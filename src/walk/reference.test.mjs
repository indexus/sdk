// The walk against the frozen output of the v1 heatmap path
// (testdata/v1-reference.json), and the pack kernel's float32 emulation
// against the walk's CPU pack, on the same IXB2 blocks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ROOT, ROUTING_ALPHABET } from "../tree/index.js";
import {
  HEAT,
  RESOLUTION,
  makeSpace,
  randomPoints,
  drill,
  ingestAll,
  makeBlock,
  serve,
} from "./walk.testkit.mjs";
import { createZoneIndex, walkViewport, FLOATS_PER_INSTANCE } from "./index.js";
import { planToInstancesCPU } from "./pack.testkit.mjs";
import { suffixAt } from "../wire/block.js";
import { spaceTables, parentBounds } from "../gpu/cells.js";
import { packEntriesF32 } from "../gpu/pack.testkit.mjs";

const V1 = JSON.parse(
  readFileSync(new URL("./testdata/v1-reference.json", import.meta.url), "utf8"),
).parity;

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Instances as rows, empty outputs (unused virtual bins) left out. */
function rows(data) {
  const out = [];
  for (let i = 0; i < data.length; i += FLOATS_PER_INSTANCE) {
    const row = Array.from(data.subarray(i, i + FLOATS_PER_INSTANCE));
    if (row.some((v) => v !== 0)) out.push(row);
  }
  return out;
}

function close(a, b, tolerance = 1e-5) {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

/** The v1 reference of a test's n-th compare(): instance count and the sum of each float. */
function reference(t) {
  let call = 0;
  return {
    next: () => V1[`${t.name}#${call++}`],
    stats: () => V1[`${t.name}#stats${call - 1}`],
  };
}

function assertSamePack(actual, expected, label) {
  assert.ok(expected, `${label}: no v1 reference`);
  const a = rows(actual);
  assert.equal(a.length, expected.count, `${label}: instance count`);
  const sums = new Array(FLOATS_PER_INSTANCE).fill(0);
  for (const row of a) row.forEach((v, k) => (sums[k] += v));
  sums.forEach((sum, k) =>
    assert.ok(
      close(sum, expected.sums[k]),
      `${label}: float ${k} sums to ${sum}, v1 ${expected.sums[k]}`,
    ),
  );
  return a.length;
}

// The pack kernel (its float32 emulation) writes the CPU pack's instances,
// output by output.
const kernelError = { degrees: 0, relative: 0 };

function assertSameKernel(space, plan, store, position, expected, label) {
  const blocks = {
    get: (handle) => ({
      rows: store.get(handle),
      origin: parentBounds(space, store.get(handle).parent),
    }),
  };
  const { data } = packEntriesF32({
    blocks,
    tables: spaceTables(space),
    plan,
    heat: HEAT,
    position,
  });
  assert.equal(data.length, expected.length, `${label}: kernel instance count`);
  for (let i = 0; i < data.length; i++) {
    const field = i % FLOATS_PER_INSTANCE;
    const delta = Math.abs(data[i] - expected[i]);
    // Positions in degrees; values relative.
    const error =
      field < 8 || (field >= 10 && field < 12) ? delta : delta / Math.max(1, Math.abs(expected[i]));
    const key = field < 8 ? "degrees" : "relative";
    kernelError[key] = Math.max(kernelError[key], error);
    if (error > (field < 8 ? 1e-4 : 1e-5)) {
      assert.fail(
        `${label}: kernel output ${Math.floor(i / FLOATS_PER_INSTANCE)} float ${field}: ${data[i]}, CPU ${expected[i]}`,
      );
    }
  }
}

function setup(options = {}) {
  const space = makeSpace();
  const points =
    options.points ?? randomPoints(space, { seed: options.seed ?? 7, count: options.count ?? 600 });
  const zones =
    options.zones ?? drill(points, { maxDepth: options.maxDepth ?? 3, skip: options.skip ?? [] });
  const index = createZoneIndex(space);
  const store = ingestAll(index, zones);
  return { space, points, zones, index, store };
}

function compare(
  fixture,
  ref,
  view,
  {
    zoom,
    limit = 5,
    children = 4,
    isCovered = () => false,
    mode = "bounds",
    virtualize = false,
    nudge = false,
    strict = view,
    label,
  },
) {
  const { space, index, store } = fixture;
  const bounds = space.newSegment([view]);
  const strictBounds = space.newSegment([strict]);
  const plan = walkViewport(index, {
    zoom,
    resolution: RESOLUTION,
    bounds,
    strictBounds,
    limit,
    children,
    isCovered,
    virtualize,
    nudgeAnchors: nudge,
  });
  const position = {
    space,
    mode,
    latIndex: 3,
    lngIndex: 4,
    metricScale: 1e6,
    latOffset: 90,
    lngOffset: 180,
  };
  const { data } = planToInstancesCPU(plan, store, HEAT, position);
  const count = assertSamePack(data, ref.next(), label);
  assertSameKernel(space, plan, store, position, data, label);
  return { plan, count };
}

const VIEW = [41, 49, -4, 9];
const ZOOMS = [-1, 0, 1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("parity: bounds positions, every zoom, no polygon (worker default)", (t) => {
  const fixture = setup();
  const ref = reference(t);
  for (const zoom of ZOOMS) {
    const { count } = compare(fixture, ref, VIEW, { zoom, label: `zoom ${zoom}` });
    assert.ok(count > 0, `zoom ${zoom} draws something`);
  }
});

test("parity: metric centroids and parent anchors", (t) => {
  const fixture = setup({ seed: 11 });
  const ref = reference(t);
  for (const zoom of ZOOMS)
    compare(fixture, ref, VIEW, { zoom, mode: "metrics", label: `zoom ${zoom}` });
});

test("parity: Cube default isCovered stops at the limit and on few children", (t) => {
  const fixture = setup({ seed: 3 });
  const ref = reference(t);
  for (const limit of [0, 5, 40]) {
    for (const children of [1, 4]) {
      for (const zoom of [0, 2, 4]) {
        compare(fixture, ref, VIEW, {
          zoom,
          limit,
          children,
          isCovered: () => true,
          mode: "metrics",
          label: `limit ${limit} children ${children} zoom ${zoom}`,
        });
      }
    }
  }
});

test("parity: a polygon covering only part of the view", (t) => {
  const fixture = setup({ seed: 5 });
  const ref = reference(t);
  const isCovered = (cell) => {
    const [south, north] = cell.bounds[0].value();
    return south >= 44 && north <= 50;
  };
  for (const zoom of [0, 2, 4])
    compare(fixture, ref, VIEW, { zoom, isCovered, label: `zoom ${zoom}` });
});

/** Zones of `points` drilled to `maxDepth`, with the first row of `victim`'s block removed. */
function partialZones(points, maxDepth) {
  const zones = drill(points, { maxDepth });
  const [victim, blocks] = [...zones].find(
    ([zone, b]) => zone.length === 2 && b[0]?.suffixChars === 1 && b[0].n > 3,
  );
  const block = blocks[0];
  const rows = [];
  for (let row = 1; row < block.n; row++) {
    const metrics = [];
    for (let j = 0; j < block.metricCount; j++) metrics.push(block.metrics[j * block.n + row]);
    rows.push({ suffix: suffixAt(block, row), count: block.count[row], metrics });
  }
  zones.set(victim, [makeBlock(victim, rows)]);
  return { zones, victim };
}

test("parity: an incomplete zone falls back to its parent", (t) => {
  const space = makeSpace();
  const points = randomPoints(space, { seed: 9, count: 600 });
  const { zones, victim } = partialZones(points, 2);
  const fixture = setup({ points, zones });
  const ref = reference(t);
  const up = fixture.index.get(victim[0]);
  assert.ok(
    fixture.index.get(victim).count < up.children.count[ROUTING_ALPHABET.indexOf(victim[1])],
    "the zone is partial",
  );
  let fallbacks = 0;
  for (const zoom of [1, 2, 3, 4]) {
    const { plan } = compare(fixture, ref, VIEW, { zoom, mode: "metrics", label: `zoom ${zoom}` });
    const res = plan.entries.filter((_, i) => i % 8 === 4);
    const slots = new Int32Array(plan.entries.buffer).filter((_, i) => i % 8 === 3);
    fallbacks += res.filter((r, i) => r === 6 && slots[i] > 6).length;
  }
  assert.ok(fallbacks > 0, "the partial zone is drawn at its own resolution in finer slots");
});

test("parity: three tiers, and an empty slot falls back to a coarser tier", (t) => {
  const space = makeSpace();
  // Two clusters; the view sits in the gap, inside one coarse zone only.
  const points = [
    ...randomPoints(space, { seed: 1, count: 300, rect: [40, 41, 0, 1] }),
    ...randomPoints(space, { seed: 2, count: 300, rect: [47, 48, 8, 9] }),
  ];
  const fixture = setup({ points });
  const ref = reference(t);
  const gap = [43, 45, 3, 6];
  let fallbacks = 0;
  for (const zoom of [1, 2, 3, 4]) {
    const { plan } = compare(fixture, ref, gap, { zoom, label: `zoom ${zoom}` });
    const slots = new Int32Array(plan.entries.buffer).filter((_, i) => i % 8 === 3);
    const res = plan.entries.filter((_, i) => i % 8 === 4);
    fallbacks += res.filter((r, i) => r < slots[i]).length;
  }
  assert.ok(fallbacks > 0, "some slot shows coarser cells");
  // Every tier of a normal view is present.
  const { plan } = compare(fixture, ref, VIEW, { zoom: 2, label: "view" });
  const slots = new Set(new Int32Array(plan.entries.buffer).filter((_, i) => i % 8 === 3));
  assert.deepEqual([...slots].sort(), [6, 7, 8]);
});

test("parity: child virtualisation, items below the zones", (t) => {
  // Zones of at most 40 points answer with items, so coarse cells split from them.
  const space = makeSpace();
  const points = randomPoints(space, { seed: 21, count: 500 });
  const zones = new Map();
  const queue = [ROOT];
  while (queue.length) {
    const zone = queue.shift();
    const blocks = serve(points, zone, { itemThreshold: 40 });
    zones.set(zone, blocks);
    if (!blocks.length || blocks[0].suffixChars !== 1) continue;
    for (const p of points) {
      const child = p.location.slice(0, (zone === ROOT ? 0 : zone.length) + 1);
      if (
        (zone === ROOT || p.location.startsWith(zone)) &&
        !queue.includes(child) &&
        !zones.has(child)
      )
        queue.push(child);
    }
  }
  const fixture = setup({ points, zones });
  const ref = reference(t);
  let virtualRows = 0;
  for (const zoom of [1, 2, 3, 4, 5]) {
    for (const mode of ["bounds", "metrics"]) {
      const { plan } = compare(fixture, ref, VIEW, {
        zoom,
        limit: 30,
        children: 4,
        isCovered: () => true,
        virtualize: true,
        mode,
        label: `zoom ${zoom} ${mode}`,
      });
      virtualRows += plan.entries.filter((_, i) => i % 8 === 7).filter((cap) => cap > 1).length;
    }
  }
  assert.ok(virtualRows > 0, "the kernel bins rows below one character");
});

test("parity: anchors nudged into the strict view, virtual cells only", (t) => {
  const space = makeSpace();
  const points = randomPoints(space, { seed: 4, count: 300 });
  const zones = new Map([...drill(points, { maxDepth: 2, itemThreshold: 400 })]);
  const fixture = setup({ points, zones });
  const ref = reference(t);
  for (const zoom of [1, 2, 3]) {
    compare(fixture, ref, VIEW, {
      zoom,
      limit: 1000,
      isCovered: () => true,
      virtualize: true,
      nudge: true,
      mode: "metrics",
      strict: [44, 45, 2, 3],
      label: `zoom ${zoom}`,
    });
  }
});

test("parity: viewport stats equal summarizeViewport", (t) => {
  const fixture = setup({ seed: 13 });
  const ref = reference(t);
  for (const zoom of ZOOMS) {
    for (const strict of [VIEW, [43.2, 46.7, -1.3, 4.4]]) {
      const { plan } = compare(fixture, ref, VIEW, { zoom, strict, label: `zoom ${zoom}` });
      const want = ref.stats();
      assert.ok(
        close(plan.stats.totalCount, want.totalCount),
        `count ${plan.stats.totalCount} ${want.totalCount}`,
      );
      want.metricSums.forEach((v, k) =>
        assert.ok(close(plan.stats.metricSums[k], v), `metric ${k}`),
      );
    }
  }
});

test("a folded deep row (count > 1) keeps its mass and the walk descends", () => {
  // Two items truncated to the same key arrive as one row of count 2, more
  // than one character below the zone.
  const space = makeSpace();
  const location = space.encode(space.newPoint([[45, 2]]), 4);
  const zones = new Map([
    [ROOT, [makeBlock(ROOT, [{ suffix: location[0], count: 3, metrics: [] }], 0)]],
    [
      location[0],
      [
        makeBlock(
          location[0],
          [
            { suffix: location.slice(1), count: 2, metrics: [] },
            { suffix: location.slice(1, 3) + "0", count: 1, metrics: [] },
          ],
          0,
        ),
      ],
    ],
  ]);
  const { index, store } = setup({ points: [], zones });
  const view = space.newSegment([[44, 46, 1, 3]]);
  const plan = walkViewport(index, {
    zoom: 3,
    resolution: RESOLUTION,
    bounds: view,
    limit: 2,
    children: 1,
    isCovered: () => false,
  });
  const walk = rows(planToInstancesCPU(plan, store, HEAT, { space, mode: "bounds" }).data);
  assert.ok(Math.max(...walk.map((row) => row[10])) > 3, "the walk descends");
  assert.ok(
    close(
      walk.filter((row) => row[11] === 8).reduce((sum, row) => sum + Math.expm1(row[8]), 0),
      3,
    ),
  );
});

test("kernel: the float32 emulation stayed within tolerance in every scenario above", () => {
  assert.ok(
    kernelError.degrees > 0 && kernelError.degrees <= 1e-4,
    `positions ${kernelError.degrees}`,
  );
  assert.ok(kernelError.relative <= 1e-5, `values ${kernelError.relative}`);
});
