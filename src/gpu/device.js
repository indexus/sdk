/** One lazy WebGPU device per JS realm. No browser access at import time. */
export function createGPUDeviceRuntime({ gpu = () => globalThis.navigator?.gpu } = {}) {
  let pending = null,
    current = null;

  async function context() {
    if (current) return current;
    if (pending) return pending;
    const api = gpu();
    if (!api) return null;
    const attempt = (async () => {
      const adapter = await api.requestAdapter({ powerPreference: "low-power" });
      if (!adapter) return null;
      // timestamp-query: pass timings of a renderer on this device (its HUD)
      const optional = ["float32-blendable", "timestamp-query"];
      const device = await adapter.requestDevice({
        requiredFeatures: optional.filter((f) => adapter.features.has(f)),
      });
      const value = {
        device,
        adapter,
        features: {
          float32Blendable: device.features.has("float32-blendable"),
          timestampQuery: device.features.has("timestamp-query"),
        },
      };
      current = value;
      device.lost.then(() => {
        // A late loss from an older device must not invalidate its replacement.
        if (current === value) current = null;
      });
      return value;
    })();
    pending = attempt;
    try {
      return await attempt;
    } finally {
      if (pending === attempt) pending = null;
    }
  }

  return { context };
}

/** A shader module of `code`, once it compiled; its errors as one Error ("WGSL line: …"). */
export async function compileShader(device, label, code) {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo?.();
  const errors = (info?.messages ?? []).filter((message) => message.type === "error");
  if (errors.length) {
    throw new Error(
      errors.map((message) => `WGSL ${message.lineNum}: ${message.message}`).join("\n"),
    );
  }
  return module;
}

// Fallback values are the WebGPU constants, for realms without GPUBufferUsage (Node tests).
export const bufferUsage = globalThis.GPUBufferUsage ?? {
  COPY_SRC: 0x4,
  COPY_DST: 0x8,
  VERTEX: 0x20,
  UNIFORM: 0x40,
  STORAGE: 0x80,
};

const runtime = createGPUDeviceRuntime();
export const getGPUContext = runtime.context;

// Synchronous first answer for apps that must decide what to show before any
// adapter request: decision 5 of heat-pipeline is a message, not a fallback.
// `reason` is a stable code; `detectWebGPU` / the layer refine it once an
// adapter has been requested ("no-adapter").
export function webgpuSupport() {
  if (globalThis.isSecureContext === false) return { supported: false, reason: "insecure-context" };
  if (!globalThis.navigator?.gpu) return { supported: false, reason: "no-webgpu" };
  return { supported: true, reason: null };
}

/** The shared device for a map: `{device, adapter, features, supported, reason}`. */
export async function detectWebGPU() {
  try {
    const context = await getGPUContext();
    if (context) return { ...context, supported: true, reason: null };
    const reason = "WebGPU unavailable";
    return { supported: false, device: null, adapter: null, features: null, reason };
  } catch (error) {
    return { supported: false, device: null, adapter: null, features: null, reason: error.message };
  }
}
