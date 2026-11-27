/* global GPUBufferUsage, GPUTextureUsage, GPUColorWrite */

// The heat draw: the instances of a pack (gpu/pack.js layout) drawn into a
// texture in three render passes (wgsl/draw.js): mask, accumulation,
// normalize. One HeatDraw per layer, on one device; the passes are recorded
// into the device's frame (gpu/frame.js, stage FRAME_DRAW).
//
// Instance input: a CPU pack `{count, data: Float32Array}` (uploaded with one
// writeBuffer) or a GPU pack `{count, gpuBuffer, version}` on this device,
// bound as is.
//
// Idle frames: MapLibre renders for any reason (label fade, a neighbouring
// layer). When the inputs that make the pixels (matrix, size, pack identity
// or GPU pack version, effect, mask, opacity, transition factor) equal the
// last frame's, `prepare` answers "idle" and the last image is shown again.
// The mask pass is recorded again only when the matrix, the size or the
// geometry change: the polygon is static on screen otherwise.

import { INSTANCE_BYTES } from "./pack.js";
import { frameOf, FRAME_DRAW } from "./frame.js";
import { uploadMaskGeometry } from "./mask.js";
import {
  MASK_SHADER,
  ACCUM_SHADER,
  buildNormalizeShader,
  generateColorRampWgsl,
} from "./wgsl/draw.js";

const MASK_FORMAT = "rgba8unorm";

// Forced presentation format. Matches the WebGL upload path (gl.RGBA,
// gl.UNSIGNED_BYTE) so the handoff stays on the GPU-to-GPU fast path and never
// falls back to a Canvas2D readback in Chromium.
export const PRESENTATION_FORMAT = "rgba8unorm";

const UNIT_SQUARE_VERTICES = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
const TRANSPARENT_CLEAR = { r: 0, g: 0, b: 0, a: 0 };

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------

// Module-scope scratch arrays: per-frame uniform updates do not allocate.
const MASK_SCRATCH = new Float32Array(16);
const ACCUM_SCRATCH = new Float32Array(28);
const NORMALIZE_SCRATCH = new Float32Array(8);

const MASK_WORDS = new Uint32Array(MASK_SCRATCH.buffer);
const ACCUM_WORDS = new Uint32Array(ACCUM_SCRATCH.buffer);
const NORMALIZE_WORDS = new Uint32Array(NORMALIZE_SCRATCH.buffer);
const uploadedUniforms = new WeakMap();

// These buffers are written by this module only. Compare their exact Float32
// bytes, signed zero included, without skipping any pass or animation step.
// Weak keys let disposed GPU buffers and their copies expire.
function uploadUniform(device, buffer, data, words) {
  let previous = uploadedUniforms.get(buffer);
  if (previous?.length === words.length) {
    let same = true;
    for (let i = 0; i < words.length; i++) {
      if (previous[i] !== words[i]) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  device.queue.writeBuffer(buffer, 0, data);
  if (previous?.length !== words.length) {
    previous = new Uint32Array(words.length);
    uploadedUniforms.set(buffer, previous);
  }
  previous.set(words);
}

/** mat4 (64 bytes). */
export function writeMaskUniform(device, buffer, matrix) {
  for (let i = 0; i < 16; i++) MASK_SCRATCH[i] = matrix[i];
  uploadUniform(device, buffer, MASK_SCRATCH, MASK_WORDS);
}

// mat4 + smoothEdge, multiplier, transitionFactor, zoom, resolutionConstant,
// previousCenterDepth, areaMode, centerDepth, then coverage (1: n and d are
// divided by the zone's area) and 3 of padding (112 bytes).
//
// The shader derives a continuous live depth `zoom + resolutionConstant` and
// computes per-instance LOD weight and zoomDelta from it: the pack stays valid
// across a continuous zoom and across in-band bracket changes.
export function writeAccumUniform(
  device,
  buffer,
  matrix,
  smoothEdge,
  multiplier,
  transitionFactor,
  zoom,
  resolutionConstant,
  previousCenterDepth,
  areaMode,
  centerDepth = zoom + resolutionConstant,
  coverage = 0,
) {
  const data = ACCUM_SCRATCH;
  for (let i = 0; i < 16; i++) data[i] = matrix[i];
  data[16] = smoothEdge;
  data[17] = multiplier;
  data[18] = transitionFactor;
  data[19] = zoom;
  data[20] = resolutionConstant;
  data[21] = previousCenterDepth ?? centerDepth;
  data[22] = areaMode ? 1 : 0;
  data[23] = centerDepth;
  data[24] = coverage ? 1 : 0;
  uploadUniform(device, buffer, data, ACCUM_WORDS);
}

/** normalizer, fading, heatmapOpacity, maskEnabled, blend factor, interpolateValues, padding (32 bytes). */
export function writeNormalizeUniform(
  device,
  buffer,
  normalizer,
  fading,
  heatmapOpacity,
  maskEnabled,
  transitionFactor = 1,
  interpolateValues = false,
) {
  const data = NORMALIZE_SCRATCH;
  data[0] = normalizer;
  data[1] = fading;
  data[2] = heatmapOpacity;
  data[3] = maskEnabled ? 1 : 0;
  data[4] = transitionFactor;
  data[5] = interpolateValues ? 1 : 0;
  uploadUniform(device, buffer, data, NORMALIZE_WORDS);
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

const UNIT_SQUARE_LAYOUT = {
  arrayStride: 8,
  attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
};

function createMaskPipeline(device) {
  const module = device.createShaderModule({ code: MASK_SHADER });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main", buffers: [UNIT_SQUARE_LAYOUT] },
    fragment: { module, entryPoint: "fs_main", targets: [{ format: MASK_FORMAT }] },
    primitive: { topology: "triangle-list" },
  });
}

function createAccumPipeline(device, accumFormat, followCameraCentroids) {
  const module = device.createShaderModule({ code: ACCUM_SHADER });
  const add = { srcFactor: "one", dstFactor: "one", operation: "add" };
  return device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs_main",
      constants: { followCameraCentroids: followCameraCentroids ? 1 : 0 },
      buffers: [
        UNIT_SQUARE_LAYOUT,
        {
          arrayStride: INSTANCE_BYTES,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x4" },
            { shaderLocation: 2, offset: 16, format: "float32x4" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
            { shaderLocation: 4, offset: 48, format: "float32x2" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: accumFormat, blend: { color: add, alpha: add } }],
    },
    primitive: { topology: "triangle-list" },
  });
}

// No blending: the target is cleared by the pass and the shader emits
// premultiplied alpha; the composite does the alpha-over against the map.
function createNormalizePipeline(device, format, colors, colorInterpolation) {
  const ramp = generateColorRampWgsl(colors, colorInterpolation);
  const module = device.createShaderModule({ code: buildNormalizeShader(ramp) });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format, writeMask: GPUColorWrite.ALL }],
    },
    primitive: { topology: "triangle-list" },
  });
}

export function colorRampSignature(colors, colorInterpolation, format) {
  // Not the function's identity or source: d3 scales with different ranges
  // can stringify alike and keep the wrong colors. Fingerprint the ramp's
  // output at fixed samples instead.
  if (typeof colorInterpolation !== "function") {
    return `${colors}|none|${format}`;
  }
  const samples = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    let value = "";
    try {
      value = String(colorInterpolation(i / steps));
    } catch {
      value = "";
    }
    samples.push(value);
  }
  return `${colors}|${samples.join(",")}|${format}`;
}

// Match a FLOAT accumulation whenever 32-bit float blending exists; otherwise
// rgba16float (last-bucket banding in dense areas, possible Inf if metric sums
// get large).
export function pickAccumFormat(device, features) {
  const supports32fBlend =
    features?.float32Blendable === true || device.features?.has?.("float32-blendable") === true;
  if (!supports32fBlend) {
    console.warn(
      "[AverageGridLayerWebGPU] float32-blendable unavailable; using rgba16float accumulation (precision degraded)",
    );
  }
  return supports32fBlend ? "rgba32float" : "rgba16float";
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

function attachment(view) {
  return { view, clearValue: TRANSPARENT_CLEAR, loadOp: "clear", storeOp: "store" };
}

function recordMaskPass(cmd, ctx) {
  const pass = cmd.beginRenderPass({ colorAttachments: [attachment(ctx.maskView)] });
  if (ctx.indexCount > 0 && ctx.vertexBuffer && ctx.indexBuffer) {
    pass.setPipeline(ctx.pipeline);
    pass.setBindGroup(0, ctx.bindGroup);
    pass.setVertexBuffer(0, ctx.vertexBuffer);
    pass.setIndexBuffer(ctx.indexBuffer, "uint16");
    pass.drawIndexed(ctx.indexCount);
  }
  pass.end();
}

function recordAccumPass(cmd, ctx) {
  const pass = cmd.beginRenderPass({ colorAttachments: [attachment(ctx.accumView)] });
  if (ctx.instanceCount > 0 && ctx.instanceBuffer) {
    pass.setPipeline(ctx.pipeline);
    pass.setBindGroup(0, ctx.bindGroup);
    pass.setVertexBuffer(0, ctx.unitSquareBuffer);
    pass.setVertexBuffer(1, ctx.instanceBuffer);
    pass.draw(6, ctx.instanceCount, 0, 0);
  }
  pass.end();
}

// False when the surface is lost or unavailable: the frame is skipped and the
// next one reacquires it.
function recordNormalizePass(cmd, ctx) {
  let view;
  try {
    view = ctx.context.getCurrentTexture().createView();
  } catch {
    return false;
  }
  const pass = cmd.beginRenderPass({ colorAttachments: [attachment(view)] });
  pass.setPipeline(ctx.pipeline);
  pass.setBindGroup(0, ctx.bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
  return true;
}

// ---------------------------------------------------------------------------
// Frame signature (idle frames)
// ---------------------------------------------------------------------------

function matricesEqual(a, b) {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function copyMatrix(out, src) {
  for (let i = 0; i < 16; i++) out[i] = src[i];
}

function effectSignature(effect, normalizer) {
  const am = effect.areaMode ?? 0;
  const cs = effect.centroidSnap ?? 0;
  return `${effect.multiplier}|${effect.smoothEdge}|${effect.fading}|${normalizer}|${effect.colors}|${am}|${cs}|${effect.interpolateValues ? 1 : 0}|${effect.coverage ? 1 : 0}`;
}

class FrameSignature {
  constructor() {
    this.matrix = new Float32Array(16);
    this.canvasW = 0;
    this.canvasH = 0;
    this.instanceData = null;
    this.instanceVersion = 0;
    this.effectSig = "";
    this.maskVersion = -1;
    this.heatmapOpacity = NaN;
    this.transitionFactor = NaN;
    this.valid = false;
  }

  // null on a cold cache, else which inputs changed since the last capture:
  // matchesAll (skip the passes), maskUnchanged (reuse the mask).
  diff(inputs) {
    if (!this.valid) return null;
    const matrixSame = matricesEqual(this.matrix, inputs.matrix);
    const canvasSame = this.canvasW === inputs.canvasW && this.canvasH === inputs.canvasH;
    const maskSame = this.maskVersion === inputs.maskVersion;
    const matchesAll =
      matrixSame &&
      canvasSame &&
      maskSame &&
      this.effectSig === inputs.effectSig &&
      this.instanceData === inputs.instanceData &&
      this.instanceVersion === inputs.instanceVersion &&
      this.heatmapOpacity === inputs.heatmapOpacity &&
      this.transitionFactor === inputs.transitionFactor;
    return { matchesAll, maskUnchanged: matrixSame && canvasSame && maskSame };
  }

  capture(inputs) {
    copyMatrix(this.matrix, inputs.matrix);
    this.canvasW = inputs.canvasW;
    this.canvasH = inputs.canvasH;
    this.instanceData = inputs.instanceData;
    this.instanceVersion = inputs.instanceVersion;
    this.effectSig = inputs.effectSig;
    this.maskVersion = inputs.maskVersion;
    this.heatmapOpacity = inputs.heatmapOpacity;
    this.transitionFactor = inputs.transitionFactor;
    this.valid = true;
  }

  invalidate() {
    this.valid = false;
  }
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

/** The vertex buffer of CPU packs: grows geometrically, written once per new array. */
class InstanceBuffer {
  constructor(device) {
    this.device = device;
    this.buffer = null;
    this.capacity = 0;
    this.lastData = null;
    this.lastCount = 0;
  }

  upload(packed) {
    const n = packed.count;
    if (!packed.data || n <= 0) return 0;
    if (packed.data === this.lastData && n === this.lastCount) return n;
    if (n > this.capacity) {
      const next = Math.max(n, this.capacity * 2, 256);
      this.buffer?.destroy();
      this.buffer = this.device.createBuffer({
        size: next * INSTANCE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.capacity = next;
    }
    const { data } = packed;
    this.device.queue.writeBuffer(this.buffer, 0, data.buffer, data.byteOffset, n * INSTANCE_BYTES);
    this.lastData = data;
    this.lastCount = n;
    return n;
  }

  dispose() {
    this.buffer?.destroy();
    this.buffer = null;
  }
}

function uniformBuffer(device, size) {
  return device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}

function target(device, width, height, format) {
  return device.createTexture({
    size: [width, height, 1],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}

export class HeatDraw {
  /**
   * @param {GPUDevice} device
   * @param {object} options
   * @param {string} options.accumFormat pickAccumFormat's
   * @param {boolean} [options.followCameraCentroids]
   * @param {string} [options.format] of the presentation texture
   */
  constructor(
    device,
    { accumFormat, followCameraCentroids = false, format = PRESENTATION_FORMAT },
  ) {
    this.device = device;
    this.format = format;
    this.unitSquareBuffer = device.createBuffer({
      size: UNIT_SQUARE_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.unitSquareBuffer, 0, UNIT_SQUARE_VERTICES);
    this.uniforms = {
      mask: uniformBuffer(device, 64),
      accum: uniformBuffer(device, 112),
      normalize: uniformBuffer(device, 32),
    };
    this.maskPipeline = createMaskPipeline(device);
    this.accumPipeline = createAccumPipeline(device, accumFormat, followCameraCentroids);
    this.accumFormat = accumFormat;
    /** Compiled when the color ramp changes (setRamp). */
    this.normalizePipeline = null;
    this.rampSignature = "";
    this.instances = new InstanceBuffer(device);
    this.maskGeometry = null;
    this.maskVersion = 0;
    /** {accum, mask, accumView, maskView} of the current size. */
    this.targets = null;
    this.maskBindGroup = this.accumBindGroup = this.normalizeBindGroup = null;
    this.signature = new FrameSignature();
  }

  /** The last image is stale: the next prepare records every pass. */
  invalidate() {
    this.signature.invalidate();
  }

  resize(width, height) {
    this.destroyTargets();
    const accum = target(this.device, width, height, this.accumFormat);
    const mask = target(this.device, width, height, MASK_FORMAT);
    this.targets = { accum, mask, accumView: accum.createView(), maskView: mask.createView() };
    this.normalizeBindGroup = null; // depends on the new views
    this.invalidate();
  }

  setMask(geojson) {
    this.maskGeometry?.dispose();
    this.maskGeometry = uploadMaskGeometry(this.device, geojson);
    this.maskVersion += 1;
    this.invalidate();
  }

  /** Compiles the normalize pipeline when the effect's color ramp changed. */
  setRamp(effect) {
    const sig = colorRampSignature(effect.colors, effect.colorInterpolation, this.format);
    if (sig === this.rampSignature && this.normalizePipeline) return;
    this.normalizePipeline = createNormalizePipeline(
      this.device,
      this.format,
      effect.colors,
      effect.colorInterpolation,
    );
    this.rampSignature = sig;
    this.normalizeBindGroup = null; // the layout is new
    this.invalidate(); // colors repaint at once
  }

  /**
   * Writes this frame's uniforms and records its passes into the device's
   * frame, to draw into `context.getCurrentTexture()`.
   * @param {object} frame matrix (Float32Array), width, height, packed, effect,
   *   normalizer, zoom, resolutionConstant, heatmapOpacity, transitionFactor,
   *   maskEnabled, context
   * @returns {"idle" | {drawn: boolean}} the last image again, or the passes
   *   (`drawn` false once submitted if the surface was lost)
   */
  prepare(frame, owner = this) {
    const { matrix, packed, effect, normalizer, heatmapOpacity, transitionFactor } = frame;
    const gpuBuffer = packed.gpuBuffer ?? null;
    const inputs = {
      matrix,
      canvasW: frame.width,
      canvasH: frame.height,
      instanceData: gpuBuffer ?? packed.data,
      instanceVersion: gpuBuffer ? packed.version : 0,
      effectSig: effectSignature(effect, normalizer),
      maskVersion: this.maskVersion,
      heatmapOpacity,
      transitionFactor,
    };
    const diff = this.signature.diff(inputs);
    this.lastPath = diff?.matchesAll ? "idle-skip" : "full-pipeline";
    if (diff && diff.matchesAll) return "idle";

    const needMask = !diff || !diff.maskUnchanged;
    this.signature.capture(inputs);
    this.writeUniforms(frame);

    // The contexts are read now; the passes are encoded when the frame is submitted.
    const maskCtx = needMask ? this.maskPassContext() : null;
    const accumCtx = this.accumPassContext(packed);
    const normalizeCtx = this.normalizePassContext(frame.context);
    const prepared = { drawn: false };
    frameOf(this.device).add(
      owner,
      (cmd) => {
        if (maskCtx) recordMaskPass(cmd, maskCtx);
        recordAccumPass(cmd, accumCtx);
        prepared.drawn = recordNormalizePass(cmd, normalizeCtx);
      },
      FRAME_DRAW,
    );
    return prepared;
  }

  writeUniforms(frame) {
    const { device, uniforms } = this;
    const { matrix, effect, transitionFactor, packed } = frame;
    writeMaskUniform(device, uniforms.mask, matrix);
    writeAccumUniform(
      device,
      uniforms.accum,
      matrix,
      effect.smoothEdge,
      effect.multiplier,
      transitionFactor,
      frame.zoom,
      frame.resolutionConstant,
      packed.previousCenterDepth,
      effect.areaMode ? 1 : 0,
      packed.centerDepth,
      effect.coverage === true,
    );
    writeNormalizeUniform(
      device,
      uniforms.normalize,
      frame.normalizer,
      effect.fading,
      frame.heatmapOpacity,
      frame.maskEnabled,
      transitionFactor,
      effect.interpolateValues === true,
    );
  }

  maskPassContext() {
    this.maskBindGroup ??= this.device.createBindGroup({
      layout: this.maskPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms.mask } }],
    });
    return {
      maskView: this.targets.maskView,
      pipeline: this.maskPipeline,
      bindGroup: this.maskBindGroup,
      vertexBuffer: this.maskGeometry?.vertexBuffer ?? null,
      indexBuffer: this.maskGeometry?.indexBuffer ?? null,
      indexCount: this.maskGeometry?.indexCount ?? 0,
    };
  }

  accumPassContext(packed) {
    const { gpuBuffer } = packed;
    const instanceCount = gpuBuffer ? packed.count : this.instances.upload(packed);
    this.accumBindGroup ??= this.device.createBindGroup({
      layout: this.accumPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms.accum } }],
    });
    return {
      accumView: this.targets.accumView,
      pipeline: this.accumPipeline,
      bindGroup: this.accumBindGroup,
      unitSquareBuffer: this.unitSquareBuffer,
      instanceBuffer: gpuBuffer ?? this.instances.buffer,
      instanceCount,
    };
  }

  normalizePassContext(context) {
    this.normalizeBindGroup ??= this.device.createBindGroup({
      layout: this.normalizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniforms.normalize } },
        { binding: 1, resource: this.targets.accumView },
        { binding: 2, resource: this.targets.maskView },
      ],
    });
    return { context, pipeline: this.normalizePipeline, bindGroup: this.normalizeBindGroup };
  }

  destroyTargets() {
    this.targets?.accum.destroy();
    this.targets?.mask.destroy();
    this.targets = null;
  }

  /** Releases every buffer and texture (the device itself is shared). */
  dispose() {
    this.unitSquareBuffer.destroy();
    this.uniforms.mask.destroy();
    this.uniforms.accum.destroy();
    this.uniforms.normalize.destroy();
    this.maskGeometry?.dispose();
    this.instances.dispose();
    this.destroyTargets();
  }
}
