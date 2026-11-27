// Heat pipeline end to end in Node: a real HTTP node serving IXB2, the heat
// worker behind a MessageChannel, the main pipeline packing on a fake device
// that runs the kernel's float32 emulation (heat.testkit.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import { ROOT } from "../../tree/index.js";
import { FLOATS_PER_INSTANCE } from "../../walk/index.js";
import { ENTRY_WORDS, FLAG_LEAVE } from "../../walk/pack.js";
import { planToInstancesCPU, transitionToInstancesCPU } from "../../walk/pack.testkit.mjs";
import { HEAT, randomPoints } from "../../walk/walk.testkit.mjs";
import { spaceTables, parentBounds } from "../../gpu/cells.js";
import { packEntriesF32 } from "../../gpu/pack.testkit.mjs";
import { withGPUGlobals } from "../../gpu/device.testkit.mjs";
import { POSITION, connect, packDevice, readInstances, startNode, delay } from "./heat.testkit.mjs";
import { createHeatmapPipeline } from "./pipeline.js";

const VIEW = [41, 49, -4, 9];

function close(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Kernel output against a reference, output by output (positions in degrees, values relative). */
function assertSameInstances(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: instance count`);
  for (let i = 0; i < actual.length; i++) {
    const field = i % FLOATS_PER_INSTANCE;
    if (!close(actual[i], expected[i], field < 8 ? 1e-4 : 1e-5)) {
      const output = Math.floor(i / FLOATS_PER_INSTANCE);
      assert.fail(`${label}: output ${output} float ${field}: ${actual[i]} for ${expected[i]}`);
    }
  }
}

function reference(h) {
  const { plan, store } = h.pipeline.state;
  return planToInstancesCPU(plan, store, HEAT, { space: h.space, ...POSITION }).data;
}

function emulated(h, plan = h.pipeline.state.plan) {
  const { store } = h.pipeline.state;
  const get = (handle) => {
    const rows = store.get(handle);
    return { rows, origin: parentBounds(h.space, rows.parent) };
  };
  const tables = spaceTables(h.space);
  return packEntriesF32({ blocks: { get }, tables, plan, heat: HEAT, position: POSITION }).data;
}

async function scenario(body, { points, budgetBytes, init } = {}) {
  await withGPUGlobals(async () => {
    const space = (await import("../../walk/walk.testkit.mjs")).makeSpace();
    const node = await startNode(points ?? randomPoints(space, { seed: 7, count: 600 }));
    const h = await connect(node, { heat: HEAT, budgetBytes, init });
    try {
      await body(h);
    } finally {
      h.close();
      await node.stop();
    }
  });
}

test("MOVE → BLOCKS → PLAN: the pack is packEntriesF32 and planToInstancesCPU", async () => {
  await scenario(async (h) => {
    for (const zoom of [0, 2, 4]) {
      h.move(zoom, VIEW);
      await h.settle();
      const { packed, plan } = h.pipeline.state;
      assert.ok(plan.capacity > 0, `zoom ${zoom} draws`);
      assert.equal(packed.count, plan.capacity, "at rest the buffer holds the target alone");
      const gpu = readInstances(packed);
      assert.deepEqual(gpu, emulated(h), `zoom ${zoom}: the fake device ran the kernel emulation`);
      assertSameInstances(gpu, reference(h), `zoom ${zoom} vs planToInstancesCPU`);
    }
    assert.ok(h.messages.includes("BLOCKS") && h.messages.includes("PLAN"));
    assert.equal(h.worker.state.inflight.size, 0);
  });
});

/** Instances of a plan packed alone, on the CPU reference. */
function steady(h, plan) {
  const { store } = h.pipeline.state;
  return planToInstancesCPU(plan, store, HEAT, { space: h.space, ...POSITION }).data;
}

/**
 * Runs the reads to rest, checking every fade against the CPU reference of
 * the pair before ending it. Returns the plans that faded.
 */
async function checkFades(h, label) {
  const faded = [];
  const [link] = h.links;
  const drawn = () => ({
    plan: h.pipeline.state.plan,
    data: readInstances(h.pipeline.state.packed),
  });
  // The previous half of a fade is what was drawn when its PLAN came in.
  let target = drawn();
  link.beforePlan = () => {
    if (!h.pipeline.state.fade.active) target = drawn();
  };
  // At rest: no fade, nothing in flight on the wire or in the channel, for
  // 10 polls in a row.
  let calm = 0;
  try {
    for (let i = 0; i < 2000 && calm < 10; i++) {
      await delay(10);
      const { fade, packed, plan } = h.pipeline.state;
      if (!fade.active) {
        calm = h.busy(link) ? 0 : calm + 1;
        continue;
      }
      calm = 0;
      const payload = h.plans.at(-1);
      assert.equal(payload.dataDriven, true);
      const pair = plan.capacity + target.plan.capacity;
      assert.equal(packed.count, pair, `${label}: current then previous`);
      const previous = { entries: payload.previousEntries };
      const current = steady(h, plan);
      const expected = transitionToInstancesCPU(
        plan,
        current,
        previous,
        target.data,
        payload.motion,
      );
      assertSameInstances(readInstances(packed), expected.data, `${label}: fade ${faded.length}`);
      faded.push({ payload, data: readInstances(packed), capacity: plan.capacity });
      h.clock.t += 1000;
      h.pipeline.controller.getTransitionFactor();
    }
  } finally {
    link.beforePlan = null;
  }
  assert.equal(calm, 10, `${label}: the reads came to rest`);
  return faded;
}

test("zoom in and out: each fade is the reference pair, with per-zone markers", async () => {
  await scenario(async (h) => {
    h.move(0, VIEW);
    await h.settle();
    h.move(3, [43, 46, 0, 5]);
    const zoomIn = await checkFades(h, "zoom in");
    assert.ok(zoomIn.length > 0);
    const entering = zoomIn.find(({ payload }) => payload.motion.entered > 0);
    assert.ok(entering, "finer detail subdivides from its zone");
    const half = entering.capacity * FLOATS_PER_INSTANCE;
    const marker = (v, i) => i % FLOATS_PER_INSTANCE === 13 && i < half && v === -1;
    const marked = entering.data.filter(marker);
    assert.ok(marked.length > 0, "entering outputs carry (resolution, -1)");
    assertSameInstances(readInstances(h.pipeline.state.packed), reference(h), "zoom in at rest");
    h.move(0, VIEW);
    assert.ok((await checkFades(h, "zoom out")).length > 0);
    const { packed, plan } = h.pipeline.state;
    assert.equal(packed.count, plan.capacity, "at rest the previous half is gone");
    assertSameInstances(readInstances(h.pipeline.state.packed), reference(h), "zoom out at rest");
  });
});

test("PLAN message: the previous entries are transferred, not copied; the plan is cloned", async () => {
  await scenario(async (h) => {
    h.move(0, VIEW);
    await h.settle();
    h.move(3, [43, 46, 0, 5]);
    await h.settle();
    h.move(0, VIEW);
    await h.settle();
    const [link] = h.links;
    const { posts, plans } = link;
    assert.equal(posts.length, plans.length, "every PLAN posted reached the pipeline");
    let driven = 0;
    for (let k = 0; k < posts.length; k++) {
      const { message, transfer } = posts[k];
      const payload = message.payload;
      for (const key of [
        "snapshotVersion",
        "previousSnapshotVersion",
        "centerDepth",
        "previousCenterDepth",
        "columnsVersion",
        "dataDriven",
        "emptyConfirmed",
        "plan",
        "motion",
        "previousEntries",
      ]) {
        assert.ok(key in payload, `PLAN ${k}: ${key}`);
      }
      // The worker keeps its plan (the next planMotion reads it): never transferred.
      assert.ok(!transfer.includes(payload.plan.entries.buffer), `PLAN ${k}: plan cloned`);
      const received = plans[k];
      assert.ok(received.plan.entries instanceof Uint32Array);
      if (!payload.dataDriven) {
        assert.equal(payload.previousEntries, null, `PLAN ${k}: no previous half`);
        assert.equal(received.previousEntries, null);
        continue;
      }
      driven++;
      const previous = posts[k - 1].message.payload.plan;
      assert.equal(payload.previousEntries, previous.entries, "the previous plan's own entries");
      assert.ok(transfer.includes(previous.entries.buffer), `PLAN ${k}: previous transferred`);
      assert.equal(previous.entries.byteLength, 0, "detached in the worker once posted");
      // What arrives: the previous plan as it was received, with LEAVE marks only.
      const before = plans[k - 1].plan.entries;
      const after = received.previousEntries;
      assert.ok(after instanceof Uint32Array);
      assert.equal(after.byteOffset, 0);
      assert.equal(after.buffer.byteLength, after.byteLength);
      assert.equal(after.length, before.length);
      for (let i = 0; i < after.length; i++) {
        const leave = i % ENTRY_WORDS === 5 ? FLAG_LEAVE : 0;
        assert.equal(after[i] & ~leave, before[i], `PLAN ${k}: word ${i}`);
      }
    }
    assert.ok(driven > 0, "some plans faded");
  });
});

test("during a fade the pair stays and plans wait; a stale completion is ignored", async () => {
  await scenario(async (h) => {
    h.move(1, VIEW);
    await h.settle();
    const before = h.plans.length;
    h.move(2, VIEW);
    await h.until(() => h.pipeline.state.fade.active);
    const payload = h.plans[before];
    const pair = readInstances(h.pipeline.state.packed);
    h.move(3, VIEW);
    await delay(80);
    assert.equal(h.plans.length, before + 1, "no plan during the fade");
    assert.deepEqual(readInstances(h.pipeline.state.packed), pair, "the pair stays mid-fade");
    const stale = { snapshotVersion: payload.snapshotVersion - 1 };
    h.worker.handle({ type: "TRANSITION_COMPLETE", payload: stale });
    assert.equal(h.worker.state.transition, payload.snapshotVersion, "a stale end is ignored");
    h.clock.t += 1000;
    h.pipeline.controller.getTransitionFactor();
    await h.settle();
    assert.ok(h.plans.length > before + 1, "the latest camera follows the fade");
    assert.equal(h.pipeline.state.plan.cameraDepth, 8);
    assertSameInstances(readInstances(h.pipeline.state.packed), reference(h), "at rest");
  });
});

test("a jump of two brackets shows the one between, then the camera's", async () => {
  await scenario(async (h) => {
    h.move(2, VIEW);
    await h.settle();
    const before = h.plans.length;
    h.move(4, VIEW);
    await h.settle();
    const depths = h.plans.slice(before).map((payload) => payload.centerDepth);
    assert.equal(depths[0], 8, "one bracket first");
    assert.equal(depths.at(-1), 9, "then the camera");
  });
});

test("a fast MOVE cancels the reads the new view does not need", async () => {
  await scenario(async (h) => {
    h.move(0, VIEW);
    await h.settle();
    h.node.delayMs = 300;
    const asked = h.node.requests.length;
    h.move(5, [41, 42, -4, -3]);
    await h.until(() => h.node.requests.length > asked);
    const away = [...h.worker.state.inflight.keys()];
    const mark = h.node.requests.length;
    h.move(5, [47.5, 48.5, 7, 8]);
    h.node.delayMs = 0;
    await h.settle();
    const near = new Set(h.node.requests.slice(mark).flat());
    assert.ok(
      away.some((zone) => !near.has(zone)),
      "the first view had reads of its own",
    );
    assert.ok(h.node.aborted > 0, "the node saw the request go away");
    for (const zone of away) {
      if (near.has(zone)) continue;
      assert.equal(h.worker.state.index.get(zone), undefined, `${zone} cancelled, not ingested`);
    }
    assert.ok(h.pipeline.state.plan.capacity > 0);
    assertSameInstances(readInstances(h.pipeline.state.packed), reference(h), "the second view");
  });
});

test("SET_VISIBILITY: a hidden map reads nothing and resumes the latest camera", async () => {
  await scenario(async (h) => {
    h.move(2, VIEW);
    await h.settle();
    h.pipeline.controller.setReadVisibility(false);
    const requests = h.node.requests.length;
    const plans = h.plans.length;
    h.move(3, VIEW);
    h.move(4, VIEW);
    await delay(100);
    assert.equal(h.node.requests.length, requests, "no read while hidden");
    assert.equal(h.plans.length, plans, "no plan while hidden");
    h.pipeline.controller.setReadVisibility(true);
    await h.settle();
    assert.ok(h.node.requests.length > requests);
    assert.equal(h.pipeline.state.plan.centerDepth, 9, "the last camera");
  });
});

test("the store budget evicts unpinned blocks; the worker reads them again", async () => {
  const west = [41, 43, -4, -1];
  const east = [46, 48, 6, 9];
  await scenario(
    async (h) => {
      h.move(4, west);
      await h.settle();
      const westZones = new Set(h.node.zonesRead());
      h.move(4, east);
      await h.settle();
      assert.ok(h.sentToWorker.includes("STORE_EVICTED"), "the budget evicted");
      const { store, plan } = h.pipeline.state;
      for (const handle of plan.pinned) assert.ok(store.has(handle), "pinned blocks stay");
      const reads = h.node.zonesRead().length;
      h.move(4, west);
      await h.settle();
      const again = h.node.zonesRead().slice(reads);
      assert.ok(
        again.some((zone) => westZones.has(zone)),
        "an evicted zone is read again",
      );
      assertSameInstances(readInstances(h.pipeline.state.packed), reference(h), "back west");
    },
    { budgetBytes: 1024 },
  );
});

test("device loss: the arena is rebuilt from the store, without the network", async () => {
  await scenario(async (h) => {
    h.move(3, VIEW);
    await h.settle();
    const before = readInstances(h.pipeline.state.packed);
    const requests = h.node.requests.length;
    h.pipeline.deviceLost();
    assert.equal(h.pipeline.controller.getPackedData().count, 0, "nothing drawn without a device");
    const device = packDevice();
    await h.pipeline.controller.onDeviceRestored({ device });
    const packed = h.pipeline.controller.getPackedData();
    assert.ok(device.buffers.includes(packed.gpuBuffer), "the pack lives on the new device");
    assert.deepEqual(readInstances(packed), before);
    assert.equal(h.node.requests.length, requests, "no read");
  });
});

test("blocks that arrive while the kernel compiles reach the arena", async () => {
  await scenario(async (h) => {
    h.move(3, VIEW);
    await h.settle();
    h.pipeline.deviceLost();
    // A real device compiles the pack kernel for milliseconds: blocks and
    // plans keep arriving meanwhile.
    const device = packDevice();
    const compile = device.createComputePipelineAsync.bind(device);
    device.createComputePipelineAsync = async (descriptor) => {
      await delay(50);
      return compile(descriptor);
    };
    const restored = h.pipeline.controller.onDeviceRestored({ device });
    h.move(5, [42, 46, -2, 3]);
    await h.settle();
    await restored;
    await h.settle();
    const packed = h.pipeline.controller.getPackedData();
    assert.ok(packed.count > 0, "the new view is drawn");
    assert.deepEqual(readInstances(packed), emulated(h));
  });
});

test("unknown detail keeps the geometry on screen; an empty view clears at once", async () => {
  await scenario(async (h) => {
    h.move(2, VIEW);
    await h.settle();
    const shown = h.pipeline.state.packed;
    const plans = h.plans.length;
    // Without its root the walk knows nothing of the view until the root is back.
    h.node.delayMs = 250;
    const root = [...h.worker.state.live]
      .filter(([, zone]) => zone === ROOT)
      .map(([handle]) => handle);
    h.worker.handle({ type: "STORE_EVICTED", payload: { handles: root } });
    await h.until(() => h.worker.state.inflight.has(ROOT));
    await delay(50);
    assert.equal(h.plans.length, plans, "no empty plan while the read is pending");
    assert.equal(h.pipeline.state.packed, shown, "the last geometry stays");
    h.node.delayMs = 0;
    await h.settle();
    assert.ok(h.pipeline.state.plan.capacity > 0);
    assertSameInstances(readInstances(h.pipeline.state.packed), reference(h), "the root is back");
    h.move(8, [-50, -49, -140, -139]);
    await h.settle();
    assert.equal(h.plans.at(-1).emptyConfirmed, true, "the root says the view is empty");
    assert.equal(h.pipeline.state.packed.count, 0);
  });
});

test("reconcile replaces the zones that changed, and only those", async () => {
  const space = (await import("../../walk/walk.testkit.mjs")).makeSpace();
  const points = randomPoints(space, { seed: 7, count: 600 });
  await scenario(
    async (h) => {
      h.move(3, VIEW);
      await h.settle();
      const total = h.plans.at(-1).viewportMetricCount;
      h.pipeline.controller.requestReconcile();
      await h.settle();
      const sent = () => h.messages.filter((type) => type === "BLOCKS" || type === "DROP").length;
      const quiet = sent();
      h.pipeline.controller.requestReconcile();
      await h.settle();
      assert.equal(sent(), quiet, "nothing changed, nothing sent");
      const added = randomPoints(space, { seed: 99, count: 40, rect: [44, 45, 2, 3] });
      h.node.points = [...points, ...added];
      h.pipeline.controller.requestReconcile();
      await h.settle();
      assert.ok(h.messages.includes("DROP"), "the old blocks of a changed zone are dropped");
      assert.ok(h.plans.at(-1).viewportMetricCount > total, "the view counts the new points");
      assert.equal(h.plans.at(-1).dataDriven, false, "a refresh snaps");
      assertSameInstances(readInstances(h.pipeline.state.packed), reference(h), "after reconcile");
    },
    { points },
  );
});

test("a v1 node: its answer is a read error, nothing is drawn", async () => {
  await withGPUGlobals(async () => {
    const node = await startNode([]);
    node.v1 = true;
    const h = await connect(node, { heat: HEAT });
    try {
      h.move(2, VIEW);
      await h.until(() => node.requests.length > 0);
      await h.settle();
      assert.ok(!h.messages.includes("BLOCKS"), "no block from a v1 answer");
      assert.equal(h.pipeline.controller.getPackedData().count, 0, "nothing drawn");
    } finally {
      h.close();
      await node.stop();
    }
  });
});

test("the v2 path imports no DVF rule", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of [
    "../../walk/heat/worker.js",
    "../workers/heat.worker.js",
    "./pipeline.js",
    "../lib/heatmapConfig.js",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /presets\/dvf|dvf/i, file);
  }
  assert.equal(ROOT, "@");
});

test("without the app's normalizer, the palette's top is 1", () => {
  const worker = { postMessage() {}, addEventListener() {}, removeEventListener() {} };
  const dimensions = [{ name: "g", type: "spherical", args: [-90, 90, -180, 180] }];
  const options = { worker, collection: { name: "x", dimensions }, heat: [{ num: 0, den: -1 }] };
  const neutral = createHeatmapPipeline({ ...options, gpu: async () => null });
  const app = createHeatmapPipeline({ ...options, gpu: async () => null, normalizer: 10 });
  try {
    assert.equal(neutral.controller.getNormalizer(), 1);
    assert.equal(app.controller.getNormalizer(), 10);
  } finally {
    neutral.destroy();
    app.destroy();
  }
});

test("grid diagnostics expose only nonempty actual read zones and the current plan's zones", async () => {
  await scenario(async h => {
    h.move(4, VIEW);
    await h.settle();
    const before=h.node.requests.length,bytes=h.pipeline.state.store.bytes;
    const loaded=[...h.pipeline.controller.getLoadedZones()],drawn=[...h.pipeline.controller.getDrawnZones()];
    assert.ok(loaded.length>0);assert.ok(drawn.length>0);
    assert.equal(new Set(loaded).size,loaded.length);
    const asked=new Set(h.node.zonesRead());
    for(const zone of loaded){
      assert.ok(asked.has(zone),`zone ${zone} was actually read`);
      assert.ok(h.node.points.some(point=>zone===ROOT||point.location.startsWith(zone)),`zone ${zone} contains a record`);
    }
    for(const zone of drawn)assert.ok(loaded.includes(zone));
    assert.equal(h.node.requests.length,before);
    assert.equal(h.pipeline.state.store.bytes,bytes);
    h.pipeline.state.store.clear();
    assert.deepEqual([...h.pipeline.controller.getLoadedZones()],[]);
    assert.deepEqual([...h.pipeline.controller.getDrawnZones()],[]);
  });
});

test("empty cube responses never become grid zones", async () => {
  await scenario(async h => {
    h.move(4, VIEW);await h.settle();
    assert.deepEqual([...h.pipeline.controller.getLoadedZones()],[]);
    assert.deepEqual([...h.pipeline.controller.getDrawnZones()],[]);
  },{points:[]});
});
