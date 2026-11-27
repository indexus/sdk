// The pack kernel on real walk plans. The reference is walk/pack.testkit.mjs; its
// parity with v1 and with this kernel's emulation, scenario by scenario, is
// in walk/parity.test.mjs. Here: layouts, the fake device against the
// emulation, virtual bins beyond what the walk fixtures reach, transitions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOT, ROUTING_ALPHABET } from "../tree/index.js";
import { FLOATS_PER_INSTANCE } from "../walk/pack.js";
import { writeSnapshotPair } from "../walk/snapshot.testkit.mjs";
import {
  createZoneIndex,
  walkViewport,
  planMotion,
  ENTRY_WORDS,
  FLAG_ENTER as WALK_ENTER,
  FLAG_LEAVE as WALK_LEAVE,
  FLAG_NUDGE as WALK_NUDGE,
  FLAG_VIRTUAL as WALK_VIRTUAL,
} from "../walk/index.js";
import { planToInstancesCPU, transitionToInstancesCPU } from "../walk/pack.testkit.mjs";
import {
  HEAT,
  RESOLUTION,
  makeSpace,
  randomPoints,
  drill,
  serve,
  ingestAll,
  makeBlock,
} from "../walk/walk.testkit.mjs";
import { spaceTables, parentBounds } from "./cells.js";
import { createArena } from "./arena.js";
import {
  PACK_ENTRY_BYTES,
  PACK_UNIFORM_BYTES,
  INSTANCE_FLOATS,
  FLAG_ENTER,
  FLAG_LEAVE,
  FLAG_NUDGE,
  FLAG_VIRTUAL,
  PACK_STAGES,
  packShader,
  preparePack,
  createPackKernel,
  createInstanceBuffer,
  readBackInstancesForCheck,
} from "./pack.js";
import { packEntriesF32, emulatePackStage } from "./pack.testkit.mjs";
import { fakeDevice, withGPUGlobals, USAGE } from "./device.testkit.mjs";
import { seededRandom } from "./cells.testkit.mjs";
import * as gpu from "./index.js";

/** v1's markers per zoom pair: [half|resolution|slot|lat|lng, a, b] (walk/testdata/v1-reference.json). */
const V1_MARKERS = JSON.parse(
  readFileSync(new URL("../walk/testdata/v1-reference.json", import.meta.url), "utf8"),
).packMotion;

const VIEW = [41, 49, -4, 9];
const METRICS = {
  mode: "metrics",
  latIndex: 3,
  lngIndex: 4,
  metricScale: 1e6,
  latOffset: 90,
  lngOffset: 180,
};

/** Zones answering with items below `itemThreshold` points: coarse cells split from rows. */
function itemZones(points, itemThreshold) {
  const zones = new Map();
  const queue = [ROOT];
  while (queue.length) {
    const zone = queue.shift();
    const blocks = serve(points, zone, { itemThreshold });
    zones.set(zone, blocks);
    if (!blocks.length || blocks[0].suffixChars !== 1) {
      continue;
    }
    for (const point of points) {
      const child = point.location.slice(0, (zone === ROOT ? 0 : zone.length) + 1);
      if (
        (zone === ROOT || point.location.startsWith(zone)) &&
        !queue.includes(child) &&
        !zones.has(child)
      ) {
        queue.push(child);
      }
    }
  }
  return zones;
}

function fixture({ seed = 7, count = 600, virtual = false } = {}) {
  const space = makeSpace();
  const points = randomPoints(space, { seed, count });
  const zones = virtual ? itemZones(points, 40) : drill(points, { maxDepth: 3 });
  const index = createZoneIndex(space);
  const store = ingestAll(index, zones);
  const blocks = {
    get: (handle) => ({
      rows: store.get(handle),
      origin: parentBounds(space, store.get(handle).parent),
    }),
  };
  const walk = (zoom, options = {}) =>
    walkViewport(index, {
      zoom,
      resolution: RESOLUTION,
      bounds: space.newSegment([VIEW]),
      strictBounds: space.newSegment([options.strict ?? VIEW]),
      limit: virtual ? 30 : 5,
      children: 4,
      isCovered: () => virtual,
      virtualize: virtual,
      nudgeAnchors: Boolean(options.strict),
    });
  return { space, zones, index, store, blocks, tables: spaceTables(space), walk };
}

function assertClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    const field = i % INSTANCE_FLOATS;
    const tolerance = field < 8 ? 1e-4 : 1e-5 * Math.max(1, Math.abs(expected[i]));
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `${label}: instance ${Math.floor(i / INSTANCE_FLOATS)} field ${field} = ${actual[i]}, expected ${expected[i]}`,
    );
  }
}

test("layouts: the walk's entries and flags, 14-float instances, uniform offsets as declared in WGSL", () => {
  assert.equal(PACK_ENTRY_BYTES, ENTRY_WORDS * 4);
  assert.equal(INSTANCE_FLOATS, FLOATS_PER_INSTANCE);
  assert.deepEqual(
    [FLAG_ENTER, FLAG_LEAVE, FLAG_NUDGE, FLAG_VIRTUAL],
    [WALK_ENTER, WALK_LEAVE, WALK_NUDGE, WALK_VIRTUAL],
  );

  // Offsets of struct Params computed from its declaration: every member is
  // 4 bytes except rules (3 × 16) and view (vec4f).
  const body = packShader.slice(
    packShader.indexOf("struct Params {"),
    packShader.indexOf("struct Entry {"),
  );
  const members = [...body.matchAll(/^\s+(\w+): (.+),$/gm)].map((match) => [match[1], match[2]]);
  let offset = 0;
  const offsets = {};
  for (const [name, type] of members) {
    const size = type === "array<Rule, 3>" ? 48 : type === "vec4f" ? 16 : 4;
    offsets[name] = offset / 4;
    offset += size;
  }
  assert.equal(offset, PACK_UNIFORM_BYTES);

  const { tables, walk, store } = fixture({ virtual: true });
  const plan = walk(3, { strict: [44, 45, 2, 3] });
  const info = (handle) => {
    const rows = store.get(handle);
    return { n: rows.n, depth: rows.parent.length, suffixChars: rows.suffixChars };
  };
  const previousEntries = plan.entries.slice(0, 5 * ENTRY_WORDS);
  const job = preparePack({
    info,
    tables,
    plan,
    heat: HEAT,
    position: METRICS,
    transition: { previousCount: 5, previousEntries, previousDepth: 6.5, currentDepth: 7.5 },
  });
  const u = new Uint32Array(job.uniform);
  const f = new Float32Array(job.uniform);
  const i = new Int32Array(job.uniform);
  assert.deepEqual(Array.from(f.subarray(offsets.view, offsets.view + 4)), [44, 45, 2, 3]);
  assert.equal(u[offsets.ruleCount], 3);
  assert.equal(u[offsets.positionMode], 1);
  assert.equal(i[offsets.latIndex], 3);
  assert.equal(i[offsets.lngIndex], 4);
  assert.equal(f[offsets.metricScale], 1e6);
  assert.equal(f[offsets.lngOffset], 180);
  assert.equal(u[offsets.maxLevels], 32);
  assert.deepEqual([u[offsets.step], u[offsets.size]], [3, 2]);
  assert.equal(u[offsets.capacity], plan.capacity);
  assert.equal(u[offsets.transition], 1);
  assert.equal(f[offsets.previousDepth], 6.5);
  assert.equal(f[offsets.currentDepth], 7.5);
  assert.equal(u[offsets.previousCount], 5);
  assert.equal(u[offsets.leaveEntryCount], 5);
  assert.deepEqual([i[0], i[1], f[2], u[3]], [0, 1, Math.fround(1e-6), 0]);
  assert.deepEqual([i[8], i[9], u[11]], [-1, -1, 1]);
  // The plan buffer: entries, then per output its entries, parents, anchors.
  assert.deepEqual(job.plan.subarray(u[offsets.entriesAt], u[offsets.outputsAt]), plan.entries);
  assert.equal(u[offsets.parentsAt] - u[offsets.outputsAt], 2 * plan.capacity);
  assert.deepEqual(
    new Int32Array(job.plan.buffer, u[offsets.parentsAt] * 4, plan.capacity),
    plan.parents,
  );
  assert.equal(
    u[offsets.leaveAt] - u[offsets.anchorsAt],
    4 * (plan.anchors.length / plan.anchorStride),
  );
});

function packDevice() {
  return fakeDevice({
    run: emulatePackStage,
    limits: { maxStorageBufferBindingSize: 128 << 20, maxBufferSize: 256 << 20 },
  });
}

function fill(arena, store) {
  for (const [handle, rows] of store.blocks) {
    arena.put(handle, rows, parentBounds(makeSpace(), rows.parent));
  }
}

test("pack kernel on the fake device equals packEntriesF32, with no mapAsync on the pack path", async () => {
  await withGPUGlobals(async () => {
    const device = packDevice();
    const kernel = await createPackKernel(device);
    let virtualPlans = 0;
    for (const [options, position] of [
      [{ seed: 31 }, METRICS],
      [{ seed: 32 }, { mode: "bounds" }],
      [{ seed: 21, count: 500, virtual: true }, METRICS],
      [{ seed: 21, count: 500, virtual: true }, { mode: "bounds" }],
    ]) {
      const { tables, walk, store, blocks } = fixture(options);
      const arena = createArena(device);
      fill(arena, store);
      for (const zoom of [1, 3, 5]) {
        const plan = walk(zoom, options.virtual ? { strict: [44, 45, 2, 3] } : {});
        const expected = packEntriesF32({ blocks, tables, plan, heat: HEAT, position });
        const output = createInstanceBuffer(device, plan.capacity);
        assert.equal(output.usage, USAGE.VERTEX | USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST);
        const before = device.log.length;
        const encoder = device.createCommandEncoder();
        const result = kernel.encode(encoder, {
          arena,
          tables,
          plan,
          heat: HEAT,
          position,
          output,
        });
        device.queue.submit([encoder.finish()]);
        const events = device.log.slice(before);
        assert.equal(events.filter((event) => event[0] === "map").length, 0);
        assert.deepEqual(result, { currentCount: plan.capacity, instanceCount: plan.capacity });
        const hasVirtual = plan.entries.some(
          (word, at) => at % ENTRY_WORDS === 5 && word & FLAG_VIRTUAL,
        );
        virtualPlans += hasVirtual ? 1 : 0;
        assert.deepEqual(
          events.filter((event) => event[0] === "dispatch").map((event) => event.slice(1, 4)),
          hasVirtual && position.mode === "metrics"
            ? [
                ["reduceParents", plan.capacity, 1],
                ["writeOutputs", plan.capacity, 1],
              ]
            : [["writeOutputs", plan.capacity, 1]],
        );
        for (const [, entryPoint, bindings] of events.filter((event) => event[0] === "bindGroup")) {
          assert.deepEqual(
            bindings,
            PACK_STAGES.find((stage) => stage.entryPoint === entryPoint).bindings,
          );
        }
        const data = await readBackInstancesForCheck(device, output, result.instanceCount);
        assert.deepEqual(data, expected.data);
        assertClose(
          data,
          planToInstancesCPU(plan, store, HEAT, { ...position, space: makeSpace() }).data,
          `zoom ${zoom}`,
        );
      }
    }
    assert.ok(virtualPlans >= 2, "virtual bins were packed in both position modes");
  });
});

// One character's rows, three characters deep, binned 8 to 18 bits below the
// zone: full characters in the bin and a last character cut at every width,
// with an offset that wraps its range around the alphabet.
test("virtual bins of any depth are the reference's, bin by bin", () => {
  const space = makeSpace();
  const tables = spaceTables(space);
  const random = seededRandom(5);
  const first = ROUTING_ALPHABET[17];
  const suffixes = new Set();
  while (suffixes.size < 700) {
    suffixes.add(
      first +
        ROUTING_ALPHABET[Math.floor(random() * 64)] +
        ROUTING_ALPHABET[Math.floor(random() * 64)],
    );
  }
  const zone = "A";
  const rows = [...suffixes].map((suffix) => ({
    suffix,
    count: 1 + Math.floor(random() * 9),
    metrics: [
      random() * 1e5,
      random() * 100,
      random() * 1e4,
      random() * 180 * 1e6,
      random() * 360 * 1e6,
    ],
  }));
  const block = makeBlock(zone, rows);
  const store = { get: () => block };
  const blocks = { get: () => ({ rows: block, origin: parentBounds(space, zone) }) };
  for (const bits of [8, 10, 12, 14, 16, 18]) {
    const capacity = 2 ** (bits - 6);
    const res = 3 + bits / 2;
    const plan = {
      entries: Uint32Array.from([
        1,
        0,
        block.n,
        res + 1,
        res,
        FLAG_VIRTUAL | FLAG_NUDGE,
        0,
        capacity,
      ]),
      capacity,
      parents: new Int32Array(capacity).fill(-1),
      anchors: new Float64Array(0),
      anchorStride: 7,
      metricCount: 5,
      step: 3,
      strictView: Float64Array.from([-60, 10, -100, 40]),
    };
    for (const position of [METRICS, { mode: "bounds" }]) {
      const expected = planToInstancesCPU(plan, store, HEAT, { ...position, space }).data;
      const { data } = packEntriesF32({ blocks, tables, plan, heat: HEAT, position });
      assertClose(data, expected, `${bits} bits ${position.mode}`);
      const filled = expected.filter((value, i) => i % INSTANCE_FLOATS === 9 && value > 0).length;
      assert.ok(filled > Math.min(capacity, 700) / 3, `${bits} bits: ${filled} bins hold rows`);
    }
  }
});

/** Two plans a zoom apart, with planMotion's flags, and their reference targets. */
function motion(from, to) {
  const { space, tables, walk, store, blocks, zones } = fixture({ seed: 17, count: 800 });
  const before = walk(from);
  const after = walk(to);
  const depths = planMotion(before, after);
  const position = { mode: "bounds" };
  const target = (plan) => planToInstancesCPU(plan, store, HEAT, { ...position, space }).data;
  return {
    space,
    tables,
    store,
    blocks,
    zones,
    before,
    after,
    depths,
    position,
    previous: target(before),
    current: target(after),
  };
}

test("a transition reproduces writeSnapshotPair; zone markers contain v1's cell markers", () => {
  let entered = 0;
  for (const [from, to] of [
    [1.5, 3.5],
    [3.5, 1.5],
    [2.2, 3.4],
    [3.9, 2.1],
  ]) {
    const m = motion(from, to);
    const pair = transitionToInstancesCPU(m.after, m.current, m.before, m.previous, m.depths).data;

    // Without markers, the pair is writeSnapshotPair's, float for float.
    const plain = new Float32Array(pair.length);
    writeSnapshotPair(plain, m.current, m.previous);
    const marked = (i) =>
      i < m.current.length ? pair[i - (i % 14) + 13] === -1 : pair[i - (i % 14) + 8] < 0;
    for (let i = 0; i < pair.length; i++) {
      if (!marked(i)) {
        assert.equal(pair[i], plain[i], `${from}->${to}: float ${i}`);
      }
    }

    // Each cell v1 marked on its own packs, same depths, is marked here with the same values.
    const key = (data, i, half) =>
      `${half}|${data[i + 10]}|${data[i + 11]}|${data[i]}|${data[i + 1]}`;
    const markers = new Map();
    for (let i = 0; i < pair.length; i += 14) {
      const half = i < m.current.length ? "current" : "previous";
      if (half === "current" && pair[i + 13] === -1) {
        markers.set(key(pair, i, half), [pair[i + 12], pair[i + 13]]);
      }
      if (half === "previous" && pair[i + 8] < 0) {
        markers.set(key(pair, i, half), [pair[i + 8], pair[i + 9]]);
      }
    }
    for (const [id, a, b] of V1_MARKERS[`${from}->${to}`]) {
      assert.deepEqual(
        markers.get(id),
        [a, b],
        `${from}->${to}: ${id.startsWith("current") ? "entering" : "leaving"}`,
      );
      if (id.startsWith("current")) entered++;
    }
  }
  assert.ok(entered > 0, `v1 marked ${entered} entering cells`);
});

/** A plan with one entry and one output per [zone, resolution, slot]. */
function zonePlan(centerDepth, cameraDepth, cells) {
  const entries = new Uint32Array(cells.length * ENTRY_WORDS);
  cells.forEach(([, res, slot], i) => entries.set([1, 0, 1, slot, res, 0, i, 1], i * ENTRY_WORDS));
  const zones = [...new Set(cells.map(([zone]) => zone))];
  return {
    entries,
    entryZone: Uint32Array.from(cells, ([zone]) => zones.indexOf(zone)),
    zones,
    centerDepth,
    cameraDepth,
    step: 3,
  };
}

function target(cells) {
  const data = new Float32Array(cells.length * 14);
  cells.forEach(([lat, lng, parentLat, parentLng, res, slot], i) => {
    data.set(
      [lat, lng, parentLat, parentLng, lat, lng, parentLat, parentLng, 5, 2, res, slot, 5, 2],
      i * 14,
    );
  });
  return data;
}

// Where one zone is one cell, zone motion is v1's cell motion: the pair is
// writeSnapshotPair + markSubdivisionMotion, float for float.
test("a merge and a subdivision of one zone are v1's markers exactly", () => {
  // Merge: the cells of zone ab (resolution 7) leave for ab itself, a cell of zone a.
  const fine = () =>
    zonePlan(9, 9, [
      ["ab", 7, 8],
      ["cd", 7, 8],
    ]);
  const fineData = target([
    [10, 20, 11, 21, 7, 8],
    [30, 40, 31, 41, 7, 8],
  ]);
  const coarse = (camera) =>
    zonePlan(7, camera, [
      ["a", 6, 7],
      ["cd", 7, 8],
    ]);
  const coarseData = target([
    [11, 21, 12, 22, 6, 7],
    [30, 40, 31, 41, 7, 8],
  ]);
  for (const [previousPlan, previous, plan, current, kind] of [
    [fine(), fineData, coarse(7.4), coarseData, "merge"],
    [
      { ...coarse(6), centerDepth: 6 },
      coarseData,
      zonePlan(7, 7.9, [
        ["ab", 7, 7],
        ["cd", 7, 8],
      ]),
      target([
        [10, 20, 11, 21, 7, 7],
        [30, 40, 31, 41, 7, 8],
      ]),
      "subdivision",
    ],
  ]) {
    const depths = planMotion(previousPlan, plan);
    assert.equal(depths.entered + depths.left, 1, kind);
    const pair = transitionToInstancesCPU(plan, current, previousPlan, previous, depths).data;
    const v1 = new Float32Array(pair.length);
    writeSnapshotPair(v1, current, previous, { ...depths, replay: true });
    assert.deepEqual(pair, v1, kind);
    assert.ok(kind === "merge" ? pair[28 + 8] === -depths.previousDepth : pair[13] === -1, kind);
  }
});

test("pack kernel transition: previous target copied first, shifted, markers, as the reference", async () => {
  await withGPUGlobals(async () => {
    for (const [from, to] of [
      [1.5, 3.5],
      [3.9, 2.1],
    ]) {
      const m = motion(from, to);
      if (to < from) {
        // No zone merges in this fixture: flag some to exercise the markers.
        for (let e = 0; e < m.before.entries.length; e += 3 * ENTRY_WORDS) {
          m.before.entries[e + 5] |= FLAG_LEAVE;
        }
      }
      const device = packDevice();
      const kernel = await createPackKernel(device);
      const arena = createArena(device);
      fill(arena, m.store);
      const output = createInstanceBuffer(device, m.before.capacity + m.after.capacity);
      const common = { arena, tables: m.tables, heat: HEAT, position: m.position, output };

      let encoder = device.createCommandEncoder();
      const first = kernel.encode(encoder, { ...common, plan: m.before });
      device.queue.submit([encoder.finish()]);
      const firstData = await readBackInstancesForCheck(device, output, first.instanceCount);
      assertClose(firstData, m.previous, "previous target");

      // The next plan packs into the same buffer: its current half is the previous target.
      const transition = {
        previousEntries: m.before.entries,
        previousDepth: m.depths.previousDepth,
        currentDepth: m.depths.currentDepth,
      };
      const before = device.log.length;
      encoder = device.createCommandEncoder();
      const second = kernel.encode(encoder, {
        ...common,
        plan: m.after,
        transition: { ...transition, previous: { buffer: output, count: first.currentCount } },
      });
      device.queue.submit([encoder.finish()]);
      const events = device.log.slice(before);
      const firstCommand = events.find((event) => ["copy", "clear", "dispatch"].includes(event[0]));
      assert.deepEqual(firstCommand.slice(0, 3), ["copy", "pack-instances", "pack-previous"]);
      assert.deepEqual(
        events.filter((event) => event[0] === "dispatch").map((event) => event[1]),
        ["writeOutputs", "shiftPrevious", "markLeave"],
      );
      assert.equal(second.instanceCount, m.after.capacity + m.before.capacity);
      const data = await readBackInstancesForCheck(device, output, second.instanceCount);
      const expected = packEntriesF32({
        blocks: m.blocks,
        tables: m.tables,
        plan: m.after,
        heat: HEAT,
        position: m.position,
        transition: { ...transition, previous: firstData },
      });
      assert.deepEqual(data, expected.data);
      const reference = transitionToInstancesCPU(
        m.after,
        m.current,
        m.before,
        m.previous,
        m.depths,
      ).data;
      assertClose(data, reference, `${from}->${to}`);
      const markers = reference.filter(
        (value, i) => (i % 14 === 13 && value === -1) || (i % 14 === 8 && value < 0),
      ).length;
      assert.ok(markers > 0, `${from}->${to}: ${markers} markers`);
    }
  });
});

test("pack kernel checks its plan and its output on the CPU", async () => {
  await withGPUGlobals(async () => {
    const device = packDevice();
    const kernel = await createPackKernel(device);
    const arena = createArena(device);
    const { tables, walk, store } = fixture({ seed: 21, count: 500, virtual: true });
    fill(arena, store);
    const hasVirtual = (candidate) =>
      candidate.entries.some((word, at) => at % ENTRY_WORDS === 5 && word & FLAG_VIRTUAL);
    const plan = [1, 2, 3, 4, 5].map((zoom) => walk(zoom)).find(hasVirtual);
    const big = createInstanceBuffer(device, plan.capacity);
    const encode = (overrides, edit = () => {}) => {
      const copy = { ...plan, entries: plan.entries.slice(), parents: plan.parents.slice() };
      edit(copy);
      return kernel.encode(device.createCommandEncoder(), {
        arena,
        tables,
        plan: copy,
        heat: HEAT,
        position: METRICS,
        output: big,
        ...overrides,
      });
    };
    encode({});
    assert.throws(() => encode({ output: createInstanceBuffer(device, 1) }), /output holds/);
    assert.throws(() => encode({}, (p) => (p.entries[0] = 9999)), /not in the arena/);
    assert.throws(() => encode({}, (p) => (p.entries[2] = 1e6)), /reads rows/);
    assert.throws(() => encode({}, (p) => (p.entries[4] = 90)), /targets resolution/);
    assert.throws(
      () => encode({}, (p) => (p.entries[6] = p.capacity)),
      /beyond the plan's capacity/,
    );
    assert.throws(() => encode({}, (p) => (p.step = 2)), /not a walk plan/);
    const virtual = plan.entries.findIndex(
      (word, at) => at % ENTRY_WORDS === 5 && word & FLAG_VIRTUAL,
    );
    assert.ok(virtual > 0);
    assert.throws(
      () => encode({}, (p) => (p.entries[virtual + 2] /* binCapacity */ += 1)),
      /virtual entry/,
    );
    assert.throws(() => encode({ heat: [{}, {}, {}, {}] }), /at most 3/);
    assert.throws(() => encode({ position: { mode: "metrics" } }), /latIndex/);
    assert.throws(() => encode({ arena: createArena(fakeDevice()) }), /another device/);
  });
});

test("gpu index exports the pack surface", () => {
  for (const name of ["createArena", "createPackKernel", "PACK_ENTRY_BYTES", "BLOCK_TABLE_BYTES"]) {
    assert.ok(name in gpu, name);
  }
});
