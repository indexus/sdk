import { test } from "node:test";
import assert from "node:assert/strict";
import { createGPUDeviceRuntime } from "./device.js";
import { createComputeCache, gpuUpload, releaseComputeJob } from "./compute.testkit.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fakeGPU() {
  const calls = { adapters: 0, devices: 0, pipelines: 0, modules: 0 };
  const devices = [];
  const api = {
    async requestAdapter(options) {
      calls.adapters++;
      assert.equal(options.powerPreference, "low-power");
      return {
        features: new Set(["float32-blendable", "timestamp-query"]),
        async requestDevice(options) {
          calls.devices++;
          assert.deepEqual(options.requiredFeatures, ["float32-blendable", "timestamp-query"]);
          const loss = deferred(),
            device = {
              features: new Set(options.requiredFeatures),
              lost: loss.promise,
              lose: loss.resolve,
              createShaderModule({ code }) {
                calls.modules++;
                return {
                  code,
                  getCompilationInfo: async () => ({
                    messages:
                      code === "bad" ? [{ type: "error", lineNum: 2, message: "invalid" }] : [],
                  }),
                };
              },
              async createComputePipelineAsync(descriptor) {
                calls.pipelines++;
                return { descriptor };
              },
            };
          devices.push(device);
          return device;
        },
      };
    },
  };
  return { api, calls, devices };
}
test("GPU initialization is lazy, shared and enables supported precision features", async () => {
  const f = fakeGPU(),
    runtime = createGPUDeviceRuntime({ gpu: () => f.api });
  assert.equal(f.calls.devices, 0);
  const [a, b] = await Promise.all([runtime.context(), runtime.context()]);
  assert.equal(a, b);
  assert.equal(f.calls.devices, 1);
  assert.equal(a.features.float32Blendable, true);
  assert.equal(a.features.timestampQuery, true, "pass timings when the adapter has them");
});
test("a feature the adapter lacks is not asked for", async () => {
  const runtime = createGPUDeviceRuntime({
    gpu: () => ({
      requestAdapter: async () => ({
        features: new Set(["float32-blendable"]),
        requestDevice: async (options) => {
          assert.deepEqual(options.requiredFeatures, ["float32-blendable"]);
          return { features: new Set(options.requiredFeatures), lost: new Promise(() => {}) };
        },
      }),
    }),
  });
  const { features } = await runtime.context();
  assert.deepEqual(features, { float32Blendable: true, timestampQuery: false });
});
test("kernels are cached by source and entry point, not a potentially reused label", async () => {
  const f = fakeGPU(),
    runtime = createGPUDeviceRuntime({ gpu: () => f.api });
  const compute = createComputeCache(runtime.context);
  const [a, b] = await Promise.all([
    compute("roof", "source"),
    compute("terrain", "source"),
  ]);
  assert.equal(a, b);
  assert.equal(f.calls.pipelines, 1);
  assert.notEqual((await compute("roof", "new source")).pipeline, a.pipeline);
  assert.notEqual(
    (await compute("roof", "source", { entryPoint: "other" })).pipeline,
    a.pipeline,
  );
  await assert.rejects(compute("bad", "bad"), /WGSL 2: invalid/);
  await assert.rejects(compute("bad", "bad"), /WGSL 2: invalid/);
  assert.equal(
    f.calls.modules,
    4,
    "source modules are shared across entry points; failed compilation is retryable",
  );
});
test("device loss replaces device and pipelines, without destroying a shared device per job", async () => {
  const f = fakeGPU(),
    runtime = createGPUDeviceRuntime({ gpu: () => f.api });
  const compute = createComputeCache(runtime.context);
  const a = await compute("roof", "source");
  f.devices[0].lose({ reason: "destroyed" });
  await Promise.resolve();
  const b = await compute("roof", "source");
  assert.notEqual(a.device, b.device);
  assert.notEqual(a.pipeline, b.pipeline);
  assert.equal(f.calls.devices, 2);
});
test("missing GPU and failed initialization can recover without reimporting modules", async () => {
  const f = fakeGPU();
  let api = null;
  const runtime = createGPUDeviceRuntime({ gpu: () => api });
  assert.equal(await runtime.context(), null);
  api = {
    requestAdapter: async () => {
      throw Error("temporary");
    },
  };
  await assert.rejects(runtime.context(), /temporary/);
  api = f.api;
  assert.ok((await runtime.context()).device);
});
test("GPU uploads preserve typed slice offsets, align capacity, and release on loss", async () => {
  const buffers = [];
  let capacity,
    unmapped = 0,
    destroyed = 0;
  const storage = new ArrayBuffer(8);
  const device = {
    createBuffer({ size }) {
      capacity = size;
      return {
        getMappedRange: () => storage,
        unmap() {
          unmapped++;
        },
        destroy() {
          destroyed++;
        },
      };
    },
    popErrorScope: async () => {
      throw Error("lost");
    },
  };
  const source = new Uint8Array([99, 1, 2, 3, 4, 5, 99]);
  gpuUpload(device, buffers, source.subarray(1, 6), 1);
  assert.equal(capacity, 8);
  assert.deepEqual([...new Uint8Array(storage)], [1, 2, 3, 4, 5, 0, 0, 0]);
  assert.equal(unmapped, 1);
  let released = false;
  await assert.rejects(
    releaseComputeJob(device, buffers, { scope: true, release: () => (released = true) }),
    /lost/,
  );
  assert.equal(destroyed, 1);
  assert.equal(released, true);
});
test("validation scope is popped before awaiting output, without serializing parallel jobs", async () => {
  const { submitComputeJob } = await import("./compute.testkit.mjs");
  const events = [],
    completion = deferred();
  const device = {
    queue: {
      submit() {
        events.push("submit");
      },
    },
    popErrorScope() {
      events.push("pop");
      return completion.promise;
    },
  };
  const pending = submitComputeJob(device, { finish: () => ({}) });
  assert.deepEqual(events, ["submit", "pop"]);
  completion.resolve(null);
  assert.equal(await pending, null);
  const error = await submitComputeJob(
    { queue: { submit() {} }, popErrorScope: () => Promise.reject(Error("lost")) },
    { finish: () => ({}) },
  );
  assert.equal(error.message, "lost");
});
test("compileShader gives the module, or every WGSL error in one Error", async () => {
  const { compileShader } = await import("./device.js");
  const messages = [
    { type: "warning", lineNum: 1, message: "unused" },
    { type: "error", lineNum: 3, message: "bad type" },
    { type: "error", lineNum: 7, message: "no entry" },
  ];
  const device = (list) => ({
    createShaderModule: ({ label, code }) => ({
      label,
      code,
      getCompilationInfo: async () => ({ messages: list }),
    }),
  });
  const module = await compileShader(device(messages.slice(0, 1)), "pack", "ok");
  assert.deepEqual([module.label, module.code], ["pack", "ok"]);
  await assert.rejects(compileShader(device(messages), "pack", "x"), {
    message: "WGSL 3: bad type\nWGSL 7: no entry",
  });
  // a device without compilation info (Node fakes) gives the module as it is
  assert.equal(await compileShader({ createShaderModule: () => "m" }, "x", "y"), "m");
});
