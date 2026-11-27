import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ROOT } from "../tree/index.js";
import { makeSpace, randomPoints, drill, ingestAll } from "./walk.testkit.mjs";
import {
  createZoneIndex,
  walkViewport,
  planMotion,
  ENTRY_WORDS,
  FLAG_ENTER,
  FLAG_LEAVE,
  FLOATS_PER_INSTANCE,
} from "./index.js";
import { planToInstancesCPU } from "./pack.testkit.mjs";

/** Cells the v1 path marked entering and leaving per zoom pair (testdata/v1-reference.json). */
const V1_MOTION = JSON.parse(
  readFileSync(new URL("./testdata/v1-reference.json", import.meta.url), "utf8"),
).walkMotion;

const VIEW = [41, 49, -4, 9];

test("a plan pins the blocks it reads and names the zones it lacks", () => {
  const space = makeSpace();
  const points = randomPoints(space, { seed: 2, count: 400 });
  const zones = drill(points, { maxDepth: 3, skip: ["X"] });
  const index = createZoneIndex(space);
  const store = ingestAll(index, zones);
  const bounds = space.newSegment([VIEW]);
  const options = { zoom: 3, resolution: 5, bounds, limit: 5, children: 4, isCovered: () => false };
  const plan = walkViewport(index, options);
  assert.ok(plan.missing.includes("X"));
  const used = new Set();
  for (let e = 0; e < plan.entries.length; e += ENTRY_WORDS) used.add(plan.entries[e]);
  assert.deepEqual([...plan.pinned].sort(), [...used].sort());
  for (const handle of plan.pinned) assert.ok(store.get(handle));
  assert.equal(walkViewport(index, options).signature, plan.signature, "same data, same plan");
  assert.notEqual(walkViewport(index, { ...options, zoom: 4 }).signature, plan.signature);
  // Evicted blocks: their zone is missing again.
  const evicted = index.drop([...plan.pinned].slice(-1));
  const again = walkViewport(index, options);
  assert.ok(evicted.every((zone) => again.missing.includes(zone)));
  assert.equal(walkViewport(createZoneIndex(space), options).missing[0], ROOT);
});

test("planToInstancesCPU writes both halves of each instance alike", () => {
  const space = makeSpace();
  const index = createZoneIndex(space);
  const store = ingestAll(index, drill(randomPoints(space, { count: 200 }), { maxDepth: 2 }));
  const plan = walkViewport(index, {
    zoom: 1,
    resolution: 5,
    bounds: space.newSegment([VIEW]),
    isCovered: () => false,
  });
  const { data, count } = planToInstancesCPU(
    plan,
    store,
    [{ num: -1, den: -1, minDen: 0, transform: 1 }],
    { space, mode: "bounds" },
  );
  assert.equal(count, plan.capacity);
  for (let i = 0; i < data.length; i += FLOATS_PER_INSTANCE) {
    assert.deepEqual([...data.subarray(i, i + 4)], [...data.subarray(i + 4, i + 8)]);
    assert.deepEqual([data[i + 8], data[i + 9]], [data[i + 12], data[i + 13]]);
  }
});

/** Bounds-mode identity of the outputs of entries carrying `flag`. */
function flaggedCells(plan, data, flag) {
  const keys = new Set();
  for (let e = 0; e < plan.entries.length; e += ENTRY_WORDS) {
    if (!(plan.entries[e + 5] & flag)) continue;
    for (let out = plan.entries[e + 6]; out < plan.entries[e + 6] + plan.entries[e + 7]; out++) {
      const i = out * FLOATS_PER_INSTANCE;
      keys.add(`${data[i + 10]}|${data[i]}|${data[i + 1]}`);
    }
  }
  return keys;
}

test("planMotion moves whole zones, a superset of v1's per-cell motion", () => {
  const space = makeSpace();
  const points = randomPoints(space, { seed: 17, count: 800 });
  const zones = drill(points, { maxDepth: 3 });
  const index = createZoneIndex(space);
  const store = ingestAll(index, zones);
  const bounds = space.newSegment([VIEW]);
  const options = { limit: 5, children: 4, isCovered: () => false };
  const heat = [{ num: -1, den: -1, minDen: 0, transform: 1 }];
  const pack = (zoom) => {
    const plan = walkViewport(index, { zoom, resolution: 5, bounds, ...options });
    return { plan, data: planToInstancesCPU(plan, store, heat, { space, mode: "bounds" }).data };
  };
  for (const [from, to] of [
    [1.5, 3.5],
    [3.5, 1.5],
    [2.2, 3.4],
    [3.4, 2.2],
    [3.9, 2.1],
  ]) {
    const before = pack(from);
    const after = pack(to);
    const motion = planMotion(before.plan, after.plan);
    const v1 = V1_MOTION[`${from}->${to}`];
    const entering = flaggedCells(after.plan, after.data, FLAG_ENTER);
    const leaving = flaggedCells(before.plan, before.data, FLAG_LEAVE);
    for (const id of v1.entering) assert.ok(entering.has(id), `entering ${id}`);
    for (const id of v1.leaving) assert.ok(leaving.has(id), `leaving ${id}`);
    const v1Moves = v1.entering.length + v1.leaving.length;
    if (to - from === 2)
      assert.ok(v1Moves > 0 && motion.entered > 0 && motion.left === 0, `zoom in ${from} -> ${to}`);
  }
  assert.deepEqual(planMotion(null, pack(2).plan), {
    entered: 0,
    left: 0,
    previousDepth: 7,
    currentDepth: 7,
  });
});

/** A plan with one entry per [zone, resolution, slot]. */
function plan(centerDepth, cameraDepth, cells) {
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

test("planMotion: a zone that merges back into its parent leaves", () => {
  // Cells of zone ab at resolution 7 have zone ab itself for parent, and ab
  // is a cell of zone a at resolution 6: group "a|6".
  const previous = plan(9, 9, [
    ["ab", 7, 8],
    ["cd", 7, 8],
  ]);
  const current = plan(7, 7.4, [
    ["a", 6, 7],
    ["cd", 7, 8],
  ]);
  assert.deepEqual(planMotion(previous, current), {
    entered: 0,
    left: 1,
    previousDepth: 8,
    currentDepth: 7.4,
  });
  assert.equal(previous.entries[5] & FLAG_LEAVE, FLAG_LEAVE);
  assert.equal(previous.entries[ENTRY_WORDS + 5] & FLAG_LEAVE, 0);
  const coarse = plan(6, 6, [["a", 6, 7]]);
  const fine = plan(7, 7.9, [["ab", 7, 7]]);
  assert.deepEqual(planMotion(coarse, fine), {
    entered: 1,
    left: 0,
    previousDepth: 7,
    currentDepth: 7.9,
  });
  assert.equal(fine.entries[5] & FLAG_ENTER, FLAG_ENTER);
});
