// AverageGridLayerWebGPU: the heat of a pipeline's controller on a MapLibre
// map. The draw itself is gpu/draw.js (mask → accumulation → normalize); this
// layer is its MapLibre side: custom-layer hooks, projection, canvas size,
// device lifecycle, and the composite into MapLibre's WebGL framebuffer.
//
// Integration mode: TEXTURE HANDOFF.
//   1) WebGPU draws into an OffscreenCanvas (alphaMode: "premultiplied").
//   2) In `render(gl)` the OffscreenCanvas is uploaded into a WebGL texture
//      (direct upload via WebGL2) and drawn as a fullscreen quad with
//      premultiplied-alpha blending, so labels / water / borders stay on top.
//
// One submit per map frame: the passes are recorded into the device's frame
// (gpu/frame.js) in `prerender`, which MapLibre calls on every custom layer
// before it draws any, and the first `render` submits the frame — the packs
// and combines of the heat pipelines and the passes of every heat layer.
//
// Host-drawn mode (option `surface`): no MapLibre layer and no WebGL
// composite. A renderer that draws the map itself calls `draw()` once per
// frame: the same passes draw the heat into a texture of `surface.size()`,
// `surface.matrix()` mapping Mercator (0..1) to its clip space (a Mercator
// rectangle, so a 3D scene can drape it on its ground), and the host samples
// the returned view after the device's frame is submitted.
//
// Device state (`layer.state`):
//   "ready"       — a device is attached and frames are drawn;
//   "lost"        — no usable device (lost, or none given yet): nothing is
//                   drawn, the next render asks `getGPUContext()` for one;
//   "unsupported" — WebGPU is absent; `layer.unsupportedReason` says why.
// `onDeviceLost(info)` fires once resources are released, and
// `onDeviceRestored({device, features})` once the layer can draw again, so the
// owner of a GPU pack can rebuild it on the new device.

import { getGPUContext, webgpuSupport } from "../../gpu/device.js";
import { frameOf } from "../../gpu/frame.js";
import { HeatDraw, PRESENTATION_FORMAT, copyMatrix, pickAccumFormat } from "../../gpu/draw.js";
import { WebGLCompositor } from "./webglComposite.js";

class AverageGridLayerWebGPU {
  constructor(
    id,
    controller,
    device,
    features,
    {
      followCameraCentroids = false,
      onDeviceLost = null,
      onDeviceRestored = null,
      surface = null,
    } = {},
  ) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this.controller = controller;
    this.followCameraCentroids = followCameraCentroids;
    this.onDeviceLost = onDeviceLost;
    this.onDeviceRestored = onDeviceRestored;
    /** Host-drawn mode: { matrix() → Float32Array | null, size() → [width, height] }. */
    this.surface = surface;
    this.output = null;
    this.outputView = null;

    this.device = null;
    this.accumFormat = null;
    this.state = "lost";
    this.unsupportedReason = null;
    this.restoring = null;
    /** What prerender prepared for the next render (see prepareFrame). */
    this.prepared = null;
    // GPU packs seen on the current device; on loss they become stale and
    // are never bound to the replacement device.
    this.deviceBuffers = new WeakSet();
    this.staleBuffers = new WeakSet();
    if (device) {
      this.useDevice(device, features);
    } else {
      const support = webgpuSupport();
      if (!support.supported) this.markUnsupported(support.reason);
    }

    this.geojson = null;
    this.maskEnabled = true;

    // Surface state.
    this.offscreen = null;
    this.context = null;
    this.presentationFormat = PRESENTATION_FORMAT;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    /** gpu/draw.js HeatDraw of the current device (allocated on attach). */
    this.renderer = null;
    // The inputs of a frame, rewritten in place every frame. `matrix` is a
    // Float32 copy of MapLibre's Float64 mercatorMatrix, so that the idle-frame
    // equality compares the values the GPU receives.
    this.frame = {
      matrix: new Float32Array(16),
      width: 0,
      height: 0,
      packed: null,
      effect: null,
      normalizer: 0,
      zoom: 0,
      resolutionConstant: 0,
      heatmapOpacity: 1,
      transitionFactor: 1,
      maskEnabled: true,
      context: null,
    };

    // WebGL composite (lives in MapLibre's gl context).
    this.gl = null;
    this.glCanvas = null;
    this.compositor = null;
    /** Last debug label emitted when `controller.debugHeatmap` is set. */
    this._heatmapDbgPath = "";
  }

  // --------------------------------------------------------------------------
  // MapLibre custom-layer hooks
  // --------------------------------------------------------------------------

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.glCanvas = gl.canvas;

    if (typeof OffscreenCanvas === "undefined") {
      console.error(
        "[AverageGridLayerWebGPU] OffscreenCanvas unavailable; cannot run texture handoff.",
      );
      return;
    }

    this.offscreen = new OffscreenCanvas(1, 1);
    const context = this.offscreen.getContext("webgpu");
    if (!context) {
      console.error("[AverageGridLayerWebGPU] webgpu context unavailable on OffscreenCanvas");
      return;
    }
    this.context = context;
    if (this.device) this.attachDevice();
  }

  // Configures the surface and allocates every device-owned resource. Runs on
  // add and again after a device loss, against the replacement device.
  attachDevice() {
    // Force rgba8unorm + srgb so the bytes the OffscreenCanvas exposes line
    // up exactly with the WebGL upload path (gl.RGBA, gl.UNSIGNED_BYTE,
    // default sRGB). On platforms that prefer bgra8unorm, the format
    // mismatch forces Chromium to fall back to the slow Canvas2D readback
    // path on every frame.
    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: "premultiplied",
      colorSpace: "srgb",
    });

    this.renderer = new HeatDraw(this.device, {
      accumFormat: this.accumFormat,
      followCameraCentroids: this.followCameraCentroids,
      format: this.presentationFormat,
    });
    if (!this.surface) {
      this.compositor = new WebGLCompositor(this.gl);
      this.compositor.init();
    }
    this.resizeIfNeeded();
    if (this.geojson) this.renderer.setMask(this.geojson);

    if (!this.surface)
      console.info(`[AverageGridLayerWebGPU] presentationFormat=${this.presentationFormat}`);
  }

  onRemove() {
    this.releaseDeviceResources();
    this.context = null;
    this.offscreen = null;
    this.glCanvas = this.gl = this.map = null;
  }

  // Everything below belongs to one device (or, for the compositor, is only
  // meaningful for its frames). The surface itself survives: it is
  // reconfigured with the next device.
  releaseDeviceResources() {
    this.context?.unconfigure();
    this.renderer?.dispose();
    this.compositor?.dispose();
    this.output?.destroy();
    this.output = this.outputView = null;
    this.renderer = null;
    this.compositor = null;
    this.canvasWidth = this.canvasHeight = 0;
  }

  // --------------------------------------------------------------------------
  // Device lifecycle
  // --------------------------------------------------------------------------

  useDevice(device, features) {
    this.device = device;
    this.accumFormat = pickAccumFormat(device, features);
    this.state = "ready";
    device.lost?.then((info) => this.handleDeviceLost(device, info));
  }

  markUnsupported(reason) {
    this.state = "unsupported";
    this.unsupportedReason = reason;
  }

  handleDeviceLost(device, info) {
    // A late loss of a device this layer already replaced changes nothing.
    if (this.device !== device) return;
    this.releaseDeviceResources();
    this.device = null;
    this.state = "lost";
    this.staleBuffers = this.deviceBuffers;
    this.deviceBuffers = new WeakSet();
    console.warn(
      `[AverageGridLayerWebGPU] device lost (${info?.reason ?? "unknown"}): ${info?.message ?? ""}`,
    );
    notify(this.onDeviceLost, info);
    this.map?.triggerRepaint?.();
  }

  // Asks the shared runtime for a device once; concurrent frames wait on the
  // same request. Errors stay inside: the render loop never sees them.
  restoreDevice() {
    if (this.restoring) return this.restoring;
    this.restoring = (async () => {
      try {
        const value = await getGPUContext();
        if (!value) {
          this.markUnsupported("no-adapter");
          return;
        }
        this.useDevice(value.device, value.features);
        if (this.context) this.attachDevice();
        notify(this.onDeviceRestored, { device: value.device, features: value.features });
        this.map?.triggerRepaint?.();
      } catch (error) {
        console.warn("[AverageGridLayerWebGPU] device request failed:", error);
      } finally {
        this.restoring = null;
      }
    })();
    return this.restoring;
  }

  prerender() {
    // A frame that was prepared and never rendered left no image behind.
    if (this.prepared) this.renderer?.invalidate();
    this.prepared = this.prepareFrame();
  }

  render() {
    // Without a prerender (a host that only calls render) the frame is prepared here.
    const prepared = this.prepared ?? this.prepareFrame();
    this.prepared = null;
    if (prepared === "idle") {
      this.compositor.blit();
      return;
    }
    if (!prepared) return;

    frameOf(this.device).submit();
    if (!prepared.drawn) {
      // Surface lost / dropped frame; the next one will reacquire. Don't
      // trust the cached frame state until we successfully encode again.
      this.renderer?.invalidate();
      return;
    }
    // Hand the WebGPU result over to MapLibre's WebGL framebuffer at this
    // layer's compositing slot (before "Water"), so labels stay on top.
    this.compositor.upload(this.offscreen, this.canvasWidth, this.canvasHeight);
    this.compositor.blit();
  }

  /**
   * Host-drawn mode: records this frame's passes into the device's frame
   * (frameOf(device), submitted by the host or at the end of the turn) and
   * returns the view of the heat texture (premultiplied rgba8unorm), or null
   * when there is nothing to show.
   */
  draw() {
    if (!this.surface) throw Error("draw() needs the surface option");
    if (!this.context && this.state === "ready") {
      this.context = { configure() {}, unconfigure() {}, getCurrentTexture: () => this.output };
      this.attachDevice();
    }
    const prepared = this.prepareFrame();
    return prepared ? this.outputView : null;
  }

  /**
   * Reads the frame's inputs and records this layer's passes into the
   * device's frame.
   * @returns {null | "idle" | {drawn: boolean}} nothing to show, the last
   *   image again, or passes to submit
   */
  prepareFrame() {
    if (this.state === "lost") {
      this.restoreDevice();
      return null;
    }
    if (this.state !== "ready" || !this.context || !(this.offscreen || this.surface)) return null;
    if (!this.readMatrix()) return null;

    this.resizeIfNeeded();
    const { renderer, frame } = this;
    if (!renderer?.targets || this.canvasWidth === 0 || this.canvasHeight === 0) return null;

    // Every controller input is read ONCE per frame: getZoom() can drift
    // mid-render during animations.
    const { controller } = this;
    frame.zoom = controller.getZoom();
    frame.resolutionConstant = controller.getResolutionConstant();
    frame.effect = controller.getEffect();
    frame.normalizer = controller.getNormalizer();
    frame.heatmapOpacity = controller.getHeatmapOpacity ? controller.getHeatmapOpacity() : 1;
    frame.transitionFactor = controller.getTransitionFactor();
    renderer.setRamp(frame.effect);

    const packed = controller.getPackedData(frame.zoom);
    const gpuBuffer = packed?.gpuBuffer ?? null;
    // A GPU pack from the lost device cannot be bound here; wait for the
    // owner to provide one built on the replacement device. An empty target
    // draws no overlay and invalidates the old screen image.
    if (!packed || packed.count === 0 || (gpuBuffer && this.staleBuffers.has(gpuBuffer))) {
      this.compositor?.invalidateComposite();
      renderer.invalidate();
      return null;
    }
    if (gpuBuffer) this.deviceBuffers.add(gpuBuffer);
    frame.packed = packed;
    frame.width = this.canvasWidth;
    frame.height = this.canvasHeight;
    frame.maskEnabled = this.maskEnabled;
    frame.context = this.context;

    const prepared = renderer.prepare(frame, this);
    if (controller.debugHeatmap && renderer.lastPath !== this._heatmapDbgPath) {
      this._heatmapDbgPath = renderer.lastPath;
      console.info("[heatmap-gpu]", `path: ${renderer.lastPath}`, {
        packedCount: packed.count,
        heatmapOpacity: frame.heatmapOpacity,
      });
    }
    return prepared;
  }

  // --------------------------------------------------------------------------
  // Mask
  // --------------------------------------------------------------------------

  initializeMask(geojson) {
    this.geojson = geojson;
    if (this.device && this.context && this.renderer) this.renderer.setMask(geojson);
  }

  setMaskEnabled(enabled) {
    const next = enabled !== false;
    if (this.maskEnabled === next) return;
    this.maskEnabled = next;
    this.renderer?.invalidate();
  }

  // --------------------------------------------------------------------------
  // Projection and size
  // --------------------------------------------------------------------------

  // `transform.mercatorMatrix` (mercator [0,1] -> clip), which MapLibre keeps
  // in lock-step with the camera animation (the map is in "mercator"
  // projection), or the host surface's matrix; copied into frame.matrix.
  readMatrix() {
    const mat = this.surface ? this.surface.matrix() : this.map?.transform?.mercatorMatrix;
    if (!mat || mat.length < 16) return false;
    copyMatrix(this.frame.matrix, mat);
    return true;
  }

  resizeIfNeeded() {
    if (!this.surface && (!this.glCanvas || !this.offscreen)) return;
    const scale = this.controller.getRenderScale?.() ?? 1;
    const [w, h] = this.surface
      ? this.surface.size()
      : [Math.ceil(this.glCanvas.width * scale), Math.ceil(this.glCanvas.height * scale)];
    if (w === this.canvasWidth && h === this.canvasHeight) return;
    if (w === 0 || h === 0) return;

    if (this.surface) {
      this.output?.destroy();
      this.output = this.device.createTexture({
        size: [w, h, 1],
        format: this.presentationFormat,
        // copy source: a host may read it back (checks)
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      this.outputView = this.output.createView();
    } else {
      this.offscreen.width = w;
      this.offscreen.height = h;
    }
    this.canvasWidth = w;
    this.canvasHeight = h;
    this.renderer.resize(w, h);
    this.compositor?.invalidateTextureSize();
  }
}

function notify(callback, value) {
  try {
    callback?.(value);
  } catch (error) {
    console.error("[AverageGridLayerWebGPU] device callback failed:", error);
  }
}

export default AverageGridLayerWebGPU;
