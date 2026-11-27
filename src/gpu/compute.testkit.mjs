// Compute kernels outside a frame, for the first cells kernel
// (project.testkit.mjs, scripts/gpu-check/cells-check): pipelines cached by
// source and entry point on the shared device, and the job helpers (uploads,
// error scope, teardown). No production path runs them.
import { getGPUContext, compileShader } from "./device.js";

/** compute(name, code, {entryPoint}) → {device, adapter, features, pipeline} or null. */
export function createComputeCache(context = getGPUContext) {
  let device = null;
  const pipelines = new Map(),
    modules = new Map();
  return async function compute(name, code, { entryPoint = "main" } = {}) {
    const value = await context();
    if (!value) return null;
    // A new device (after a loss): nothing compiled on the old one is kept.
    if (value.device !== device) {
      device = value.device;
      pipelines.clear();
      modules.clear();
    }
    // Source and entry point are identity; a label is only a debug annotation.
    const key = entryPoint + "\0" + code;
    let compiled = pipelines.get(key);
    if (!compiled) {
      compiled = (async () => {
        let prepared = modules.get(code);
        if (!prepared) {
          prepared = compileShader(value.device, name, code);
          modules.set(code, prepared);
          prepared.catch(() => {
            if (modules.get(code) === prepared) modules.delete(code);
          });
        }
        const module = await prepared;
        const pipeline = await value.device.createComputePipelineAsync({
          label: name,
          layout: "auto",
          compute: { module, entryPoint },
        });
        return { ...value, pipeline };
      })();
      pipelines.set(key, compiled);
      compiled.catch(() => {
        if (pipelines.get(key) === compiled) pipelines.delete(key);
      });
    }
    return compiled;
  };
}

export const computeContext = createComputeCache();

/** Upload a typed slice, including its byte offset, with aligned capacity. */
export function gpuUpload(device, buffers, array, usage) {
  const bytes = new Uint8Array(array.buffer ?? array, array.byteOffset ?? 0, array.byteLength);
  const buffer = device.createBuffer({
    size: Math.max(4, Math.ceil(bytes.byteLength / 4) * 4),
    usage,
    mappedAtCreation: true,
  });
  buffers.push(buffer);
  try {
    new Uint8Array(buffer.getMappedRange()).set(bytes);
    buffer.unmap();
    return buffer;
  } catch (error) {
    buffer.destroy();
    throw error;
  }
}

/** Jobs own buffers, not the shared device. Teardown survives device loss. */
export async function releaseComputeJob(device, buffers, { scope = false, release } = {}) {
  try {
    if (scope) await device.popErrorScope();
  } finally {
    try {
      for (const buffer of buffers) buffer.destroy();
    } finally {
      release?.();
    }
  }
}

/** Close validation before an async readback, so parallel jobs cannot nest scopes. */
export function submitComputeJob(device, encoder) {
  device.queue.submit([encoder.finish()]);
  // Handle loss immediately even if the caller is cancelled while mapping output.
  return device.popErrorScope().catch((error) => error);
}
