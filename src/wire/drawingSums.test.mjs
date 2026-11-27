// The drawing experience (experiences/src/experiences/drawing/progressive.js,
// collection DrawNetworkDemo2) checks every zone against the sum of its
// children to 1e-6. Its metrics are Σ colour·area over leaves whose areas run
// from 2^18 down to 2^-18, so the sums are wider than float32's 24 bits.
// This replays that check on what blocksToElements gives the experience.

import test from "node:test";
import assert from "node:assert/strict";

import { blocksToElements } from "./block.js";

const SIDE = 512;
// progressive.js: red is stored × 2^20 so that v1's integer metric 2 keeps it.
const RED_SCALE = 2 ** 20;
const RED_ERROR = 1 / RED_SCALE;

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Node sums of one zone at `depth`: [count, Σ red·area·2^20, Σ green·area, Σ blue·area]. */
function zone(depth, maxDepth, next) {
  const area = (SIDE / 8 ** depth) ** 2;
  if (depth >= maxDepth || next() < 0.6) {
    const [r, g, b] = [0, 1, 2].map(() => Math.floor(next() * 256));
    return [1, r * area * RED_SCALE, g * area, b * area];
  }
  const sum = [0, 0, 0, 0];
  for (let i = 0; i < 64; i++) zone(depth + 1, maxDepth, next).forEach((v, j) => (sum[j] += v));
  return sum;
}

/** The rows of one /sets answer as the node sends them, f32 or f64. */
function rowsBlock(zones, Column) {
  const n = zones.length;
  const metrics = new Column(5 * n);
  zones.forEach(([, red, green, blue], row) => {
    metrics[2 * n + row] = red;
    metrics[3 * n + row] = green;
    metrics[4 * n + row] = blue;
  });
  return {
    parent: "",
    suffixChars: 1,
    keyWords: 1,
    metricCount: 5,
    revision: 0,
    n,
    metricBytes: Column.BYTES_PER_ELEMENT,
    keys: Uint32Array.from(zones, (_, row) => row << 26),
    count: Uint32Array.from(zones, ([count]) => count),
    metrics,
  };
}

/** aggregateChildren's sums and tolerance, from progressive.js. */
function sums(elements) {
  const out = { count: 0, sums: [0, 0, 0] };
  for (const row of elements) {
    out.count += row.count();
    for (let i = 0; i < 3; i++) out.sums[i] += row.metrics()[i + 2] / (i === 0 ? RED_SCALE : 1);
  }
  return out;
}

function consistent(expected, children) {
  const { count, sums: got } = children;
  return !expected.sums.some(
    (value, i) =>
      Math.abs(value - got[i]) > (i === 0 ? (count + 1) * RED_ERROR : count * 1e-6 + 1e-5),
  );
}

test("drawing sums pass progressive.js's 1e-6 check in f64 where f32 fails", () => {
  const failures = { 4: 0, 8: 0 };
  const trials = 120;
  const next = random(20261113);
  for (let trial = 0; trial < trials; trial++) {
    // A zone at depth 1 and its 64 children, with leaves down to depth 4.
    const children = Array.from({ length: 64 }, () => zone(2, 4, next));
    const parent = children.reduce((sum, child) => sum.map((v, j) => v + child[j]), [0, 0, 0, 0]);
    for (const Column of [Float32Array, Float64Array]) {
      const expected = sums(blocksToElements("DrawNetworkDemo2", [rowsBlock([parent], Column)]));
      const below = sums(blocksToElements("DrawNetworkDemo2", [rowsBlock(children, Column)]));
      assert.equal(below.count, expected.count);
      if (!consistent(expected, below)) failures[Column.BYTES_PER_ELEMENT]++;
    }
  }
  // With this seed f32 fails 3 checks of 120; f64 none.
  assert.ok(failures[4] > 0, "f32 was expected to fail the check at depth 4");
  assert.equal(failures[8], 0);
});
