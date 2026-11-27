import { test } from "node:test";
import assert from "node:assert/strict";
import { writeSnapshotPair } from "./snapshot.testkit.mjs";

test("snapshot pair preserves exact old geometry, parent anchors and LOD, without inventing parent cells", () => {
  const previous = new Float32Array([48, 2, 47, 1, 48, 2, 47, 1, 0, 3, 12, 14, 0, 3]);
  const current = new Float32Array([49, 3, 48, 2, 49, 3, 48, 2, 60, 5, 15, 16, 60, 5]);
  const output = new Float32Array(28);
  assert.equal(writeSnapshotPair(output, current, previous), 2);
  assert.deepEqual([...output.slice(0, 12)], [...current.slice(0, 12)]);
  assert.deepEqual([...output.slice(12, 14)], [0, 0]);
  assert.deepEqual([...output.slice(14, 22)], [...previous.slice(0, 8)]);
  assert.deepEqual([...output.slice(22, 28)], [0, 0, 12, 14, 0, 3], "a zero numerator stays zero");
  assert.deepEqual([...previous], [48, 2, 47, 1, 48, 2, 47, 1, 0, 3, 12, 14, 0, 3]);
});

test("empty endpoints fade out/in; first image and stable target need no transition", () => {
  const cell = new Float32Array([48, 2, 47, 1, 48, 2, 47, 1, 6, 3, 12, 14, 6, 3]);
  const output = new Float32Array(14);
  assert.equal(writeSnapshotPair(output, cell), 1);
  assert.deepEqual(output, cell);
  writeSnapshotPair(output, new Float32Array(), cell);
  assert.deepEqual([...output.slice(8)], [0, 0, 12, 14, 6, 3]);
  writeSnapshotPair(output, cell, new Float32Array());
  assert.deepEqual([...output.slice(8)], [6, 3, 12, 14, 0, 0]);
});

function row(lat, lng, parentLat, parentLng, depth, n = 6, d = 3) {
  return new Float32Array([
    lat,
    lng,
    parentLat,
    parentLng,
    lat,
    lng,
    parentLat,
    parentLng,
    n,
    d,
    depth,
    depth,
    n,
    d,
  ]);
}

test("late children replay from their visible parent; shrinking children travel back to it", () => {
  const parent = row(48, 2, 47, 1, 10),
    child = row(48.1, 2.1, 48, 2, 11);
  const out = new Float32Array(28);
  writeSnapshotPair(out, child, parent, { previousDepth: 10, currentDepth: 11.9, replay: true });
  assert.deepEqual([...out.slice(8, 12)], [6, 3, 11, 11], "current metrics and LOD are intact");
  assert.deepEqual(
    [...out.slice(12, 14)],
    [11, -1],
    "child starts at parent position, even after a late arrival",
  );
  writeSnapshotPair(out, parent, child, { previousDepth: 11.9, currentDepth: 10, replay: true });
  assert.ok(
    Math.abs(out[22] + 11.9) < 1e-5,
    "outgoing child starts at its displayed depth, without rewinding",
  );
  assert.equal(out[23], -10, "outgoing child converges to the new depth");
  assert.deepEqual([...out.slice(26, 28)], [6, 3], "previous metrics are intact");
  assert.deepEqual([...child.slice(8)], [6, 3, 11, 11, 6, 3], "cached endpoint is never mutated");
});

test("unchanged cells, unrelated parents, invisible ancestors and large jumps retain original motion", () => {
  const parent = row(48, 2, 47, 1, 10),
    child = row(48.1, 2.1, 48, 2, 11),
    out = new Float32Array(28);
  for (const [target, previous, motion] of [
    [child, child, { previousDepth: 11.5, currentDepth: 11.8, replay: true }],
    [row(48.1, 2.1, 40, 4, 11), parent, { previousDepth: 10, currentDepth: 11.9, replay: true }],
    [child, parent, { previousDepth: 10, currentDepth: 10.9, replay: true }],
    [child, parent, { previousDepth: 12, currentDepth: 11.9, replay: true }],
    [child, parent, { previousDepth: 10, currentDepth: 15, replay: false }],
  ]) {
    writeSnapshotPair(out, target, previous, motion);
    assert.deepEqual([...out.slice(12, 14)], [0, 0]);
    assert.equal(out[22], 0);
  }
});
