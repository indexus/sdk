import { test } from "node:test";
import assert from "node:assert/strict";
import AverageGridLayer from "./AverageGridLayerWebGPU.js";
import { getGPUContext } from "../../gpu/device.js";
import { frameOf } from "../../gpu/frame.js";
import { webgpuSupport } from "../../gpu/device.js";
import { INSTANCE_BYTES as BYTES_PER_INSTANCE } from "../../gpu/pack.js";

// Browser globals the renderer touches. Values only need to be distinct bits.
globalThis.GPUBufferUsage ??= {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
};
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
globalThis.GPUColorWrite ??= { ALL: 15 };
globalThis.OffscreenCanvas ??= class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return {
      configured: null,
      configure(options) {
        this.configured = options;
      },
      unconfigure() {
        this.configured = null;
      },
      getCurrentTexture() {
        return { createView: () => ({}) };
      },
    };
  }
};

function fakeDevice() {
  let lose;
  const log = { buffers: [], writes: [], submits: 0, passes: [], destroyed: 0 };
  const resource = (extra) => ({
    destroy() {
      log.destroyed++;
    },
    ...extra,
  });
  const device = {
    log,
    features: new Set(["float32-blendable"]),
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    lose: (reason = "destroyed") => lose({ reason, message: "test" }),
    createBuffer(descriptor) {
      const buffer = resource({ ...descriptor });
      log.buffers.push(buffer);
      return buffer;
    },
    createTexture: () => resource({ createView: () => ({}) }),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createCommandEncoder() {
      return {
        beginRenderPass() {
          const pass = { vertexBuffers: [], draws: [] };
          log.passes.push(pass);
          return {
            setPipeline() {},
            setBindGroup() {},
            setIndexBuffer() {},
            end() {},
            setVertexBuffer(slot, buffer) {
              pass.vertexBuffers[slot] = buffer;
            },
            draw(vertices, instances) {
              pass.draws.push(instances);
            },
            drawIndexed() {},
          };
        },
        finish: () => ({}),
      };
    },
    queue: {
      writeBuffer(buffer) {
        log.writes.push(buffer);
      },
      submit() {
        log.submits++;
      },
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };
  return device;
}

// WebGL is only touched by the compositor; every call is a harmless no-op.
function fakeGL() {
  return new Proxy(
    { canvas: { width: 64, height: 32 } },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
        return () => ({});
      },
    },
  );
}

const effect = {
  colors: 4,
  colorInterpolation: () => "rgb(255, 0, 0)",
  smoothEdge: 0.5,
  multiplier: 1,
  fading: 0,
};

function setup(device, options) {
  const state = { pack: null, repaints: 0 };
  const controller = {
    getZoom: () => 6,
    getResolutionConstant: () => 5,
    getNormalizer: () => 10000,
    getEffect: () => effect,
    getTransitionFactor: () => 1,
    getPackedData: () => state.pack,
  };
  const layer = new AverageGridLayer(
    "test",
    controller,
    device,
    { float32Blendable: true },
    options,
  );
  const map = {
    transform: { mercatorMatrix: new Float64Array(16).fill(1) },
    triggerRepaint() {
      state.repaints++;
    },
  };
  layer.onAdd(map, fakeGL());
  return { layer, state, map };
}

const instanceWrites = (device, layer) =>
  device.log.writes.filter((buffer) => buffer === layer.renderer?.instances.buffer).length;
const accumPasses = (device) =>
  device.log.passes.filter((pass) => pass.draws.length && pass.vertexBuffers.length === 2);

function installGPU(createDevice) {
  Object.defineProperty(globalThis.navigator, "gpu", {
    configurable: true,
    value: {
      requestAdapter: async () => ({
        features: new Set(),
        requestDevice: async () => createDevice(),
      }),
    },
  });
}
const removeGPU = () => delete globalThis.navigator.gpu;

test("a CPU pack is uploaded once per new array and bound from the layer buffer", () => {
  const device = fakeDevice(),
    { layer, state } = setup(device);
  state.pack = { count: 3, data: new Float32Array(3 * 14) };
  layer.render();
  layer.render();
  assert.equal(instanceWrites(device, layer), 1, "an idle frame neither uploads nor encodes");
  assert.equal(device.log.submits, 1);
  state.pack = { count: 3, data: new Float32Array(3 * 14) };
  layer.render();
  assert.equal(instanceWrites(device, layer), 2);
  const [pass] = accumPasses(device);
  assert.equal(pass.vertexBuffers[1], layer.renderer.instances.buffer);
  assert.deepEqual(pass.draws, [3]);
});

test("a GPU pack is bound as is, never written, and repainted when its version changes", () => {
  const device = fakeDevice(),
    { layer, state } = setup(device);
  const gpuBuffer = device.createBuffer({ size: 10 * BYTES_PER_INSTANCE, usage: 0 });
  const writesBefore = device.log.writes.length;
  state.pack = {
    count: 7,
    gpuBuffer,
    version: 1,
    centerDepth: 9,
    previousCenterDepth: 8,
    snapshotVersion: 4,
  };
  layer.render();
  layer.render();
  assert.equal(device.log.submits, 1, "same buffer and version: idle frame");
  state.pack = { ...state.pack, version: 2 };
  layer.render();
  assert.equal(device.log.submits, 2, "the buffer is rewritten in place, so the version decides");
  const instanceTraffic = device.log.writes
    .slice(writesBefore)
    .filter((buffer) => buffer === gpuBuffer || buffer === layer.renderer.instances.buffer);
  assert.deepEqual(instanceTraffic, []);
  assert.equal(layer.renderer.instances.buffer, null, "no CPU instance buffer is ever allocated");
  for (const pass of accumPasses(device)) {
    assert.equal(pass.vertexBuffers[1], gpuBuffer);
    assert.deepEqual(pass.draws, [7]);
  }
});

test("the heat layers of a map frame and the frame's packs share one submit", () => {
  const device = fakeDevice();
  const layers = [setup(device), setup(device)];
  const pack = (version) => ({
    count: 2,
    gpuBuffer: device.createBuffer({ size: 2 * BYTES_PER_INSTANCE, usage: 0 }),
    version,
  });
  layers.forEach(({ state }) => (state.pack = pack(1)));
  let packs = 0;
  frameOf(device).add("a pipeline", () => packs++);
  // MapLibre: prerender on every custom layer, then render on each.
  layers.forEach(({ layer }) => layer.prerender());
  assert.equal(device.log.submits, 0, "nothing is submitted while the frame is collected");
  layers.forEach(({ layer }) => layer.render());
  assert.equal(device.log.submits, 1);
  assert.equal(packs, 1);
  assert.equal(accumPasses(device).length, 2, "both layers drew in that submit");

  // An idle frame submits nothing; one layer's new pack is one submit.
  layers.forEach(({ layer }) => layer.prerender());
  layers.forEach(({ layer }) => layer.render());
  assert.equal(device.log.submits, 1);
  layers[1].state.pack = pack(2);
  layers.forEach(({ layer }) => layer.prerender());
  layers.forEach(({ layer }) => layer.render());
  assert.equal(device.log.submits, 2);
  assert.equal(accumPasses(device).length, 3);
});

test("device loss releases resources without throwing, then the next render rebuilds on a new device", async () => {
  const devices = [];
  installGPU(() => {
    const d = fakeDevice();
    devices.push(d);
    return d;
  });
  try {
    const first = (await getGPUContext()).device;
    const events = [];
    const { layer, state } = setup(first, {
      onDeviceLost: (info) => events.push(["lost", info.reason]),
      onDeviceRestored: ({ device }) => events.push(["restored", device]),
    });
    const stale = first.createBuffer({ size: 4 * BYTES_PER_INSTANCE, usage: 0 });
    state.pack = { count: 4, gpuBuffer: stale, version: 1 };
    layer.render();
    assert.equal(first.log.submits, 1);
    const destroyedBefore = first.log.destroyed;

    first.lose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(layer.state, "lost");
    assert.deepEqual(events, [["lost", "destroyed"]]);
    // Unit square, three uniforms, two targets; no mask and no CPU instance buffer here.
    assert.equal(first.log.destroyed - destroyedBefore, 6);
    for (const key of ["device", "compositor", "renderer", "output"]) {
      assert.equal(layer[key], null, key);
    }
    assert.equal(layer.context.configured, null, "surface unconfigured");

    assert.doesNotThrow(() => layer.render());
    await layer.restoring;
    const second = devices.at(-1);
    assert.notEqual(second, first);
    assert.equal(layer.state, "ready");
    assert.equal(layer.device, second);
    assert.equal(layer.context.configured.device, second);
    assert.deepEqual(events[1], ["restored", second]);
    assert.ok(state.repaints >= 2, "loss and restore both ask for a frame");

    // The old device's pack must not reach the new device.
    layer.render();
    assert.equal(second.log.submits, 0);
    assert.equal(accumPasses(second).length, 0);

    const fresh = second.createBuffer({ size: 4 * BYTES_PER_INSTANCE, usage: 0 });
    state.pack = { count: 4, gpuBuffer: fresh, version: 2 };
    layer.render();
    assert.equal(second.log.submits, 1);
    assert.equal(accumPasses(second)[0].vertexBuffers[1], fresh);

    // A CPU pack simply re-uploads into the new device's buffer.
    state.pack = { count: 2, data: new Float32Array(28) };
    layer.render();
    assert.equal(instanceWrites(second, layer), 1);
  } finally {
    removeGPU();
  }
});

test("a throwing loss callback stays out of the render loop, and a late loss of a replaced device is ignored", async () => {
  installGPU(fakeDevice);
  try {
    const first = (await getGPUContext()).device;
    let lost = 0;
    const { layer, state } = setup(first, {
      onDeviceLost: () => {
        lost++;
        throw Error("owner bug");
      },
    });
    state.pack = { count: 1, data: new Float32Array(14) };
    const error = console.error;
    console.error = () => {};
    try {
      first.lose();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = error;
    }
    layer.render();
    await layer.restoring;
    assert.equal(layer.state, "ready");
    first.lose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lost, 1);
    assert.equal(layer.state, "ready");
    layer.onDeviceLost = null;
  } finally {
    removeGPU();
  }
});

test("without navigator.gpu the layer and webgpuSupport report unsupported and never draw", () => {
  removeGPU();
  assert.deepEqual(webgpuSupport(), { supported: false, reason: "no-webgpu" });
  const { layer, state } = setup(null);
  assert.equal(layer.state, "unsupported");
  assert.equal(layer.unsupportedReason, "no-webgpu");
  state.pack = { count: 1, data: new Float32Array(14) };
  assert.doesNotThrow(() => layer.render());
  assert.equal(layer.restoring, null, "no device request");
});

test("a runtime without adapter turns a lost layer unsupported", async () => {
  // The shared runtime caches its live device; lose it so the next request asks again.
  (await getGPUContext())?.device.lose();
  await new Promise((resolve) => setImmediate(resolve));
  Object.defineProperty(globalThis.navigator, "gpu", {
    configurable: true,
    value: { requestAdapter: async () => null },
  });
  try {
    assert.equal(webgpuSupport().supported, true);
    const { layer } = setup(null);
    assert.equal(layer.state, "lost", "no device yet: the first render asks for one");
    layer.render();
    await layer.restoring;
    assert.equal(layer.state, "unsupported");
    assert.equal(layer.unsupportedReason, "no-adapter");
  } finally {
    removeGPU();
  }
});

test("host-drawn mode draws into its own texture of the surface's size, with the surface's matrix", () => {
  const device = fakeDevice(),
    textures = [];
  device.createTexture = (descriptor) => {
    const texture = { ...descriptor, view: {}, destroyed: false };
    texture.createView = () => texture.view;
    texture.destroy = () => (texture.destroyed = true);
    textures.push(texture);
    return texture;
  };
  let size = [128, 64];
  const matrix = new Float32Array(16).fill(2),
    state = { pack: null },
    controller = {
      getZoom: () => 6,
      getResolutionConstant: () => 5,
      getNormalizer: () => 10000,
      getEffect: () => effect,
      getTransitionFactor: () => 1,
      getPackedData: () => state.pack,
    },
    layer = new AverageGridLayer(
      "host",
      controller,
      device,
      { float32Blendable: true },
      {
        surface: { matrix: () => matrix, size: () => size },
      },
    );
  assert.equal(layer.draw(), null, "nothing to show without a pack");
  state.pack = { count: 2, data: new Float32Array(2 * 14) };
  const view = layer.draw();
  const output = textures.find((t) => t.view === view);
  assert.ok(output, "the view is the layer's output texture");
  assert.deepEqual(output.size, [128, 64, 1]);
  assert.equal(layer.compositor, null, "no WebGL composite");
  frameOf(device).submit();
  assert.equal(device.log.submits, 1);
  assert.equal(accumPasses(device).length, 1);
  assert.equal(layer.draw(), view, "an idle frame shows the same texture");
  size = [256, 64];
  const resized = layer.draw();
  assert.notEqual(resized, view);
  assert.ok(output.destroyed, "the texture of the old size is released");
});

test("removal unconfigures the surface, releases every resource once and permits a same-size remount", () => {
  const device = fakeDevice(),
    textures = [];
  const createTexture = device.createTexture;
  device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor);
    textures.push(texture);
    return texture;
  };
  const { layer, state, map } = setup(device);
  state.pack = { count: 2, data: new Float32Array(2 * 14) };
  for (let cycle = 0; cycle < 3; cycle++) {
    layer.initializeMask({
      type: "FeatureCollection",
      features: [
        {
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    });
    layer.render();
    const context = layer.context;
    const created = device.log.buffers.length + textures.length;
    layer.onRemove();
    layer.onRemove();
    assert.equal(context.configured, null, "surface unconfigured");
    assert.equal(device.log.destroyed, created, "every buffer and texture released once");
    for (const key of ["map", "gl", "glCanvas", "context", "renderer", "compositor"])
      assert.equal(layer[key], null, key);
    assert.equal(layer.canvasWidth, 0);
    assert.equal(layer.device, device, "a layer must not destroy the shared device");
    const submits = device.log.submits;
    layer.onAdd(map, fakeGL());
    layer.render();
    assert.equal(device.log.submits, submits + 1, "the remounted layer draws at the same size");
  }
});
