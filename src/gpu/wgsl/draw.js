// WGSL of the heat draw (gpu/draw.js), three render passes:
//
//   1) mask         -> rgba8unorm texture: the polygon, triangulated (gpu/mask.js)
//   2) accumulation -> rgba32float (rgba16float without float32-blendable),
//      additive: RG holds the previous snapshot's n/d, BA the current one's.
//      Mercator projection and the cell -> parent fractional-zoom blend are
//      done in the vertex shader.
//   3) normalize    -> the presentation texture (premultiplied alpha):
//      (n/d)/normalizer through the color ramp, inside the mask.
//
// WebGPU textures have a top-left origin: the normalize vertex shader flips
// Y so that uv follows the screen.

import { parseColor } from "../../utilities/colorRamp.js";

export const MASK_SHADER = /* wgsl */ `
struct Uniforms {
  matrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsOut {
  @builtin(position) clip: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VsOut {
  var out: VsOut;
  out.clip = u.matrix * vec4<f32>(position, 0.0, 1.0);
  return out;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
`;

// Accumulation pass — continuous-LOD GPU blend.
//
// Per-instance attribute layout (one buffer, 56 bytes per instance):
//   location 1: vec4<f32>  currentLatLng  = (curLat, curLng, curParentLat, curParentLng)   [16B]
//   location 2: vec4<f32>  previousLatLng = (prevLat, prevLng, prevParentLat, prevParentLng) [16B]
//   location 3: vec4<f32>  values         = (currentNominator, currentDenominator, resolution, slotResolution) [16B]
//   location 4: vec2<f32>  previousValues = (previousNominator, previousDenominator) [8B]
//
// Per-vertex attribute:
//   location 0: vec2<f32>  corner   = unit-square corner in [0,1]x[0,1]
//
// Uniforms:
//   matrix             : projection (mercator world -> clip), forwarded from MapLibre
//   smoothEdge         : circle edge softness
//   multiplier         : world-space radius multiplier
//   transitionFactor   : 0 -> previous snapshot, 1 -> current snapshot
//   zoom               : live MapLibre zoom (continuous, fractional)
//   resolutionConstant : RESOLUTION cube-config constant; liveDepth = zoom + resolutionConstant
//   coverage           : 1 when n and d are sums over the area of the cell's zone
//                        (d in km², a field such as the weather): both are divided
//                        by the zone's own area, so d is the share of it covered and
//                        a cell weighs the same at every level, as a cell of
//                        weight 1 does (and the sums stay small in rgba16float)
//
// LOD model + parent fallback:
// The pack carries cells from a 3-depth band centred on the live bracket
// (worker reads all three depth tiers from cube.display(), which already
// produces them). When a natural slot is empty — the fine data hasn't
// streamed in yet, or doesn't exist near a polygon border — the worker
// substitutes cells from the closest non-empty COARSER tier (down to
// `centerDepth - PARENT_FALLBACK_DEPTH`) into that slot. Substituted
// cells keep their TRUE depth in `resolution` (so the geometry renders
// at the correct large-disk size) but are tagged with the empty slot's
// depth in `slotResolution` (so the LOD kernel keeps them visible).
//
// Per frame, the shader derives a continuous live depth and computes:
//
//   relDepth  = slotResolution - liveDepth  (signed, |..| < 1 = visible)
//   lodWeight = max(0, 1 - |relDepth|)      (triangle kernel; weights of
//                                            the two visible adjacent
//                                            depths sum to 1, so density
//                                            is conserved at boundaries)
//
// For natural cells `slotResolution === resolution`. A small zoom change
// therefore needs no worker round-trip — the GPU re-weights what it
// already has and cells dissolve smoothly across the bracket boundary.
//
// Each snapshot retains its own cell/parent geometry and LOD band. The
// accumulation shader writes the two images into separate channel pairs;
// normalization divides each independently, then cross-fades pixels. No CPU
// packing or GPU buffer upload occurs on animation frames.
export const ACCUM_SHADER = /* wgsl */ `
const PI: f32 = 3.14159265358979323846;

fn lngToMercatorX(lng: f32) -> f32 {
  return (180.0 + lng) / 360.0;
}

fn latToMercatorY(lat: f32) -> f32 {
  // Equivalent to maplibregl.MercatorCoordinate.fromLngLat({lng,lat}).y.
  let s = sin(lat * PI / 180.0);
  return 0.5 - 0.25 * log((1.0 + s) / max(1.0 - s, 1e-30)) / PI;
}

override followCameraCentroids: bool = false;

struct Uniforms {
  matrix: mat4x4<f32>,
  smoothEdge: f32,
  multiplier: f32,
  transitionFactor: f32,
  zoom: f32,
  resolutionConstant: f32,
  previousCenterDepth: f32,
  areaMode: f32,
  centerDepth: f32,
  coverage: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

const EARTH_KM: f32 = 6371.0088;

/** km² of the zone of a cell centred at lat, latStep x lngStep degrees. */
fn zoneKm2(lat: f32, latStep: f32, lngStep: f32) -> f32 {
  let r = PI / 180.0;
  let north = clamp(lat + latStep * 0.5, -90.0, 90.0);
  let south = clamp(lat - latStep * 0.5, -90.0, 90.0);
  return EARTH_KM * EARTH_KM * lngStep * r * abs(sin(north * r) - sin(south * r));
}

struct VsIn {
  @location(0) corner: vec2<f32>,
  @location(1) currentLatLng: vec4<f32>,
  @location(2) previousLatLng: vec4<f32>,
  @location(3) values: vec4<f32>,
  @location(4) previousValues: vec2<f32>,
};

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) currentChannels: vec2<f32>,
  @location(3) lodWeight: f32,
  @location(4) snapshot: f32,
};

@vertex
fn vs_main(input: VsIn) -> VsOut {
  let resolution     = input.values.z;
  let slotResolution = input.values.w;

  // Continuous live depth. The pack covers slots [d-1, d, d+1] around
  // d = floor(liveDepth), so a small zoom change never falls off the
  // band edge — within that band the GPU does the LOD selection
  // itself, no worker round-trip.
  //
  // slotResolution is what the cell occupies in the multi-LOD pack.
  // For natural cells it equals the cell's own depth. For parent
  // fallback cells (coarse cells substituted into an empty finer slot)
  // the worker tags them with the empty slot's depth, so the kernel
  // keeps them visible at the live zoom even though their TRUE depth
  // is far away — the geometry below still uses resolution, so the
  // disk renders at the correct (large) size.
  // Keep the nearest available tier visible while the worker/network
  // catches up with a fast zoom. Geometry still uses the live camera.
  let snapshot = select(0.0, 1.0, input.values.y > 0.0 || u.transitionFactor >= 1.0);
  let centerDepth = mix(u.previousCenterDepth, u.centerDepth, snapshot);
  let desiredDepth = clamp(u.zoom + u.resolutionConstant,
                        centerDepth - 1.0, centerDepth + 1.0);
  // Late child data must still travel from the parent that was visible.
  // Unmarked cells retain the original camera-driven movement. Large zoom
  // jumps are unmarked by the worker and skip this bounded catch-up.
  let entering = snapshot > 0.5 && input.previousValues.y < 0.0;
  let leaving = snapshot < 0.5 && input.values.y < 0.0;
  let startDepth = select(-input.values.x, input.previousValues.x, entering);
  let endDepth = select(desiredDepth, -input.values.y, leaving);
  let liveDepth = select(desiredDepth, mix(startDepth, endDepth, u.transitionFactor), entering || leaving);
  let channels = mix(input.previousValues, input.values.xy, snapshot);
  let relDepth  = slotResolution - liveDepth;

  // Triangle LOD kernel. Two adjacent depths sum to 1 → density is
  // preserved as cells fade across bracket boundaries.
  let lodWeight = max(0.0, 1.0 - abs(relDepth));

  if (lodWeight <= 0.0 || channels.y <= 0.0) {
    // Collapse to a degenerate vertex outside the clip volume — the
    // rasterizer rejects it, no fragment shader runs.
    var skip: VsOut;
    skip.clip = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    skip.texCoord = vec2<f32>(0.0, 0.0);
    skip.currentChannels = vec2<f32>(0.0, 0.0);
    skip.lodWeight = 0.0;
    skip.snapshot = snapshot;
    return skip;
  }

  // Per-instance cell -> parent fractional-zoom blend.
  // localFrac = "how far past this instance's bracket is the live depth":
  //   localFrac < 0  -> not yet in own bracket -> sit at parent
  //   localFrac in [0, 1] -> in own bracket -> morph parent -> own
  //   localFrac > 1  -> past own bracket -> sit at own
  // Clamp visibility to the available slots, but let their ordinary
  // centroids continue moving with the camera while a pack is pending.
  let cameraDepth = u.zoom + u.resolutionConstant;
  let cameraMotion = select(cameraDepth, mix(startDepth, cameraDepth, u.transitionFactor), entering);
  let motionDepth = select(liveDepth, cameraMotion, followCameraCentroids && !leaving);
  let localFrac = motionDepth - resolution;
  let zoomDelta = clamp(1.0 - localFrac, 0.0, 1.0);

  // Resolve each snapshot's centroid (own -> parent blend).
  let curLat  = input.currentLatLng.x  + (input.currentLatLng.z  - input.currentLatLng.x)  * zoomDelta;
  let curLng  = input.currentLatLng.y  + (input.currentLatLng.w  - input.currentLatLng.y)  * zoomDelta;
  let prevLat = input.previousLatLng.x + (input.previousLatLng.z - input.previousLatLng.x) * zoomDelta;
  let prevLng = input.previousLatLng.y + (input.previousLatLng.w - input.previousLatLng.y) * zoomDelta;

  // Each image retains its own geometry; only the normalized pixels fade.
  let posT = snapshot;
  let lat = mix(prevLat, curLat, posT);
  let lng = mix(prevLng, curLng, posT);

  // mercatoorRatio inline: the four neighbour samples become four scalar
  // mercator-Y / mercator-X evaluations of the closed-form Web Mercator
  // projection. No CPU MercatorCoordinate.fromLngLat calls.
  let grid = pow(2.0, resolution);
  let latStep = 180.0 / grid;
  let lngStep = 360.0 / grid;

  let p1y = latToMercatorY(lat + latStep * 0.5);
  let p2y = latToMercatorY(lat - latStep * 0.5);
  let p3x = lngToMercatorX(lng + lngStep * 0.5);
  let p4x = lngToMercatorX(lng - lngStep * 0.5);

  let yDelta = p2y - p1y;
  let xDelta = p3x - p4x;

  // Cell mode: exact mercator quad per cell (multiplier ignored). Disk mode:
  // multiplier inflates the gaussian footprint around the centroid.
  let m = select(u.multiplier, 1.0, u.areaMode > 0.5);
  let scaleFactor = m * (1.0 + zoomDelta);
  let xRadius = xDelta * scaleFactor;
  let yRadius = yDelta * scaleFactor;

  let cx = lngToMercatorX(lng);
  let cy = latToMercatorY(lat);

  let tx = cx - xRadius * 0.5;
  let ty = cy - yRadius * 0.5;

  let worldPos = input.corner * vec2<f32>(xRadius, yRadius)
               + vec2<f32>(tx, ty);

  var out: VsOut;
  out.clip = u.matrix * vec4<f32>(worldPos, 0.0, 1.0);
  out.texCoord = input.corner;
  // Coverage: the zone's sums over its own area (the snapshot's own cell centre).
  let ownLat = mix(input.previousLatLng.x, input.currentLatLng.x, snapshot);
  let share = select(1.0, 1.0 / max(zoneKm2(ownLat, latStep, lngStep), 1e-12), u.coverage > 0.5);
  out.currentChannels = channels * share;
  out.snapshot = snapshot;
  out.lodWeight = lodWeight;
  return out;
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  let blended = input.currentChannels;

  var t: f32;

  if (u.areaMode > 0.5) {
    // Hard cell: fill the instance quad; optional softness on the square edge.
    let qx = abs(input.texCoord.x - 0.5) * 2.0;
    let qy = abs(input.texCoord.y - 0.5) * 2.0;
    let dmax = max(qx, qy);
    let band = max(u.smoothEdge * 0.4, 0.0005);
    t = smoothstep(1.0 - band, 1.0, dmax);
  } else {
    let center = vec2<f32>(0.5, 0.5);
    let radius = 0.5;
    let dist = distance(input.texCoord, center);
    if (dist > radius) {
      discard;
    }
    let smoothStart = radius * u.smoothEdge;
    t = smoothstep(smoothStart, radius, dist);
  }

  // Multiply BOTH numerator and denominator channels by lodWeight so the
  // normalized (n/d) average that the normalize pass computes stays
  // bracket-coherent at the cross-fade midpoint.
  let attenuated = blended * (1.0 - t) * input.lodWeight;

  // Independently accumulate the two images in the existing RGBA target.
  // Mixing n and d before division would make a new dense zone appear at
  // full opacity immediately. Normalize first, then cross-fade pixels.
  return select(vec4<f32>(attenuated, 0.0, 0.0),
                vec4<f32>(0.0, 0.0, attenuated), input.snapshot > 0.5);
}
`;

// The normalize shader with a baked-in color ramp (generateColorRampWgsl).
export function buildNormalizeShader(colorRampWgsl) {
  return /* wgsl */ `
struct Uniforms {
  normalizer: f32,
  fading: f32,
  heatmapOpacity: f32,
  maskEnabled: f32,
  transitionFactor: f32,
  interpolateValues: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var accumTex: texture_2d<f32>;
@group(0) @binding(2) var maskTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
  // Full-screen triangle covering [-1,-1] to [1,1] without index buffer.
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let p = positions[vid];
  var out: VsOut;
  out.clip = vec4<f32>(p, 0.0, 1.0);
  // WebGPU textures are top-left origin, so flip Y when going clip -> uv.
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

${colorRampWgsl}

fn sampleAtUv(tex: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
  let dims = textureDimensions(tex);
  let maxXY = vec2<i32>(dims) - vec2<i32>(1, 1);
  let xy = clamp(vec2<i32>(uv * vec2<f32>(dims)), vec2<i32>(0, 0), maxXY);
  return textureLoad(tex, xy, 0);
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  if (u.maskEnabled > 0.5) {
    let mask = sampleAtUv(maskTex, input.uv).r;
    if (mask < 0.5) {
      discard;
    }
  }

  let accum = sampleAtUv(accumTex, input.uv);
  let previous = normalizeChannels(accum.rg);
  let current = normalizeChannels(accum.ba);
  // Weather opts into scalar interpolation before the nonlinear palette.
  // Without it, the image crossfades. Never fill a missing endpoint
  // with zero temperature or mix two dates' different area denominators.
  if (u.interpolateValues > 0.5 && u.transitionFactor > 0.0 && u.transitionFactor < 1.0) {
    if (accum.g <= u.fading || accum.a <= u.fading || accum.g <= 0.0 || accum.a <= 0.0) {
      return vec4<f32>(0.0);
    }
    let value = mix(accum.r / accum.g, accum.b / accum.a, u.transitionFactor) / u.normalizer;
    return vec4<f32>(interpolateColor(value), 1.0) * clamp(u.heatmapOpacity, 0.0, 1.0);
  }
  return mix(previous, current, u.transitionFactor) * clamp(u.heatmapOpacity, 0.0, 1.0);
}

fn normalizeChannels(channels: vec2<f32>) -> vec4<f32> {
  if (channels.y <= u.fading || channels.y <= 0.0) {
    return vec4<f32>(0.0);
  }
  let value = (channels.x / channels.y) / u.normalizer;
  return vec4<f32>(interpolateColor(value), 1.0);
}
`;
}

// The WGSL color ramp: `colors` constant buckets sampled from
// colorInterpolation, as `interpolateColor(t: f32) -> vec3<f32>`.
export function generateColorRampWgsl(colors, colorInterpolation) {
  const stops = [];
  for (let i = 0; i < colors; i++) {
    const t = (i + 1) / colors;
    const c = parseColor(colorInterpolation(t));
    stops.push([t, [c.r / 255, c.g / 255, c.b / 255]]);
  }

  const colorDefs = stops
    .map(
      (entry, i) =>
        `  let c${i} = vec3<f32>(${entry[1][0].toFixed(6)}, ${entry[1][1].toFixed(
          6,
        )}, ${entry[1][2].toFixed(6)});`,
    )
    .join("\n");

  const conditions = [];
  for (let i = 0; i < colors - 1; i++) {
    const t1 = stops[i + 1][0].toFixed(6);
    conditions.push(`  if (t <= ${t1}) { return c${i}; }`);
  }

  const lastColor = `c${colors - 1}`;

  return `fn interpolateColor(t: f32) -> vec3<f32> {
${colorDefs}
${conditions.join("\n")}
  return ${lastColor};
}`;
}
