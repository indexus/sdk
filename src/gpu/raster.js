// Field raster: the instances of a heat pipeline (gpu/pack.js layout, the
// buffer the renderer draws) drawn as their cells into a texture of means over
// a Web Mercator rectangle, on the GPU, for passes that sample a field rather
// than draw cells (a weather effect reads the rain or the wind at a pixel).
//
// Texel: R = n/d of the current target, G = n/d of the previous one (a
// transition's previous half, or the earlier hour of a pair), B and A their
// coverage (1 where a cell of that target lies). A steady target has the same
// values in both. The reader blends G to R by the pipeline's transition
// factor. Cells of one target are disjoint: each texel is written once.
import { INSTANCE_FLOATS } from "./pack.js";

export const RASTER_FORMAT = "rgba16float";

const SHADER = /* wgsl */ `
struct Raster {
  rect: vec4f, // west x, north y, east x, south y, in Mercator units (0..1)
}
@group(0) @binding(0) var<uniform> raster: Raster;

struct In {
  @location(0) current: vec4f,  // lat, lng, parent lat, parent lng
  @location(1) previous: vec4f, // the same of the previous target
  @location(2) values: vec4f,   // n, d, resolution, slot
  @location(3) previousValues: vec2f,
}
struct Out {
  @builtin(position) position: vec4f,
  @location(0) value: f32,
}

const PI = 3.141592653589793;
fn mercatorY(lat: f32) -> f32 {
  let s = clamp(sin(lat * PI / 180.0), -0.9999999, 0.9999999);
  return 0.5 - 0.25 * log((1.0 + s) / (1.0 - s)) / PI;
}

fn cell(input: In, corner: u32, latLng: vec2f, n: f32, d: f32) -> Out {
  var out: Out;
  out.value = 0.0;
  // a cell without this target's value (the other half, or a motion marker)
  if (!(d > 0.0)) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let size = exp2(-input.values.z);
  let half = vec2f(90.0, 180.0) * size;
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
                                vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let k = corners[corner];
  let lat = latLng.x + k.y * half.x;
  let lng = latLng.y + k.x * half.y;
  let m = vec2f((lng + 180.0) / 360.0, mercatorY(lat));
  let r = raster.rect;
  let uv = (m - r.xy) / (r.zw - r.xy);
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.value = n / d;
  return out;
}

@vertex fn currentCell(input: In, @builtin(vertex_index) v: u32) -> Out {
  return cell(input, v, input.current.xy, input.values.x, input.values.y);
}
@vertex fn previousCell(input: In, @builtin(vertex_index) v: u32) -> Out {
  return cell(input, v, input.previous.xy, input.previousValues.x, input.previousValues.y);
}
@fragment fn mean(input: Out) -> @location(0) vec4f {
  return vec4f(input.value, input.value, 1.0, 1.0);
}
`;

const ATTRIBUTES = [
  { shaderLocation: 0, offset: 0, format: "float32x4" },
  { shaderLocation: 1, offset: 16, format: "float32x4" },
  { shaderLocation: 2, offset: 32, format: "float32x4" },
  { shaderLocation: 3, offset: 48, format: "float32x2" },
];

/** [west x, north y, east x, south y] in Mercator units of [west, south, east, north] degrees. */
export function mercatorRect([west, south, east, north]) {
  const y = (lat) => {
    const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
    return 0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI;
  };
  return [(west + 180) / 360, y(north), (east + 180) / 360, y(south)];
}

/**
 * A raster of `size` × `size` texels on `device`. encode(encoder, {packed,
 * rect}) draws `packed` (a pipeline's getPackedData(): {count, gpuBuffer})
 * over `rect` (mercatorRect of degrees); the texture holds the result once the
 * encoder is submitted.
 */
export function createFieldRaster(device, { size = 256, label = "field raster" } = {}) {
  const module = device.createShaderModule({ label, code: SHADER });
  const layout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipeline = (entryPoint, writeMask) =>
    device.createRenderPipeline({
      label: `${label}: ${entryPoint}`,
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint,
        buffers: [
          { arrayStride: INSTANCE_FLOATS * 4, stepMode: "instance", attributes: ATTRIBUTES },
        ],
      },
      fragment: { module, entryPoint: "mean", targets: [{ format: RASTER_FORMAT, writeMask }] },
      primitive: { topology: "triangle-list" },
    });
  const current = pipeline("currentCell", GPUColorWrite.RED | GPUColorWrite.BLUE);
  const previous = pipeline("previousCell", GPUColorWrite.GREEN | GPUColorWrite.ALPHA);
  const uniform = device.createBuffer({
    label,
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { buffer: uniform } }],
  });
  const texture = device.createTexture({
    label,
    size: [size, size],
    format: RASTER_FORMAT,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  });
  const view = texture.createView();
  const state = { rect: [0, 0, 1, 1], version: -1, buffer: null };

  return {
    texture,
    view,
    size,
    get rect() {
      return state.rect;
    },
    /** True when `packed` or `rect` differ from what the texture holds. */
    stale(packed, rect) {
      return (
        packed?.version !== state.version ||
        packed?.gpuBuffer !== state.buffer ||
        rect.some((v, i) => v !== state.rect[i])
      );
    },
    encode(encoder, { packed, rect }) {
      state.rect = rect.slice();
      state.version = packed?.version;
      state.buffer = packed?.gpuBuffer ?? null;
      device.queue.writeBuffer(uniform, 0, new Float32Array(rect));
      const pass = encoder.beginRenderPass({
        label,
        colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
      });
      if (packed?.count > 0 && packed.gpuBuffer) {
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, packed.gpuBuffer);
        for (const p of [current, previous]) {
          pass.setPipeline(p);
          pass.draw(6, packed.count);
        }
      }
      pass.end();
    },
    destroy() {
      texture.destroy();
      uniform.destroy();
    },
  };
}
