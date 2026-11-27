import test from "node:test";
import assert from "node:assert/strict";
import { terminalPoints } from "./terminalPoints.js";
const leaf = (hash, id) => ({ _collection: "c", _hash: hash, _id: id, _terminal: true });
const position = (r) => ({ lat: r._hash === "a" ? 1 : 2, lng: 3 });
const read = (records, viewport = [0, 4, 0, 4]) =>
  terminalPoints(records, viewport, 10, position, () => 7);

test("only verified leaves can become points; parent/proxy counts never synthesize positions", () => {
  for (const record of [
    { count: 1, xyz: { coordinates: [1, 2] } },
    { _id: "a", _hash: "a", _terminal: false },
    leaf("", "id"),
  ]) {
    assert.throws(() => read([record]), /verified terminal/);
  }
});

test("identity, multiplicity and positions survive zoom, order changes and parent/child result overlap", () => {
  const a = leaf("a", "one"),
    b = leaf("a", "two"),
    c = leaf("b", "one");
  const wide = read([a, b, c]),
    zoom = read([c, b, a, b], [0.5, 1.5, 0, 4]);
  assert.equal(wide.count, 3);
  assert.equal(zoom.count, 2, "two records at the same position remain two records");
  const coords = (result) =>
    new Map(
      result.keys.map((key, i) => [
        key,
        [...new Float32Array(result.buffer).slice(i * 3, i * 3 + 2)],
      ]),
    );
  const before = coords(wide);
  for (const [key, xy] of coords(zoom)) assert.deepEqual(xy, before.get(key));
  assert.deepEqual(read([c, b, a]).keys, wide.keys);
});

test("a missing leaf coordinate never falls back to a parent centroid", () => {
  assert.throws(
    () =>
      terminalPoints(
        [leaf("a", "id")],
        [0, 4, 0, 4],
        10,
        () => null,
        () => 0,
      ),
    /own location/,
  );
});

test("point-mode totals use the visible final records instead of parent fractions", () => {
  const a = { ...leaf("a", "one"), _metrics: [20, 2, 10] },
    b = { ...leaf("b", "two"), _metrics: [90, 3, 30] };
  const result = read([a, b], [0.5, 1.5, 0, 4]);
  assert.equal(result.count, 1);
  assert.deepEqual(result.metricSums, [20, 2, 10]);
});

test("offscreen records do not force a heatmap switch or consume the visible point budget", () => {
  const records = [
    leaf("a", "visible"),
    ...Array.from({ length: 50 }, (_, i) => leaf("b", `outside-${i}`)),
  ];
  const result = terminalPoints(records, [0.5, 1.5, 0, 4], 1, position, () => 7);
  assert.equal(result.count, 1);
  assert.throws(
    () => terminalPoints([leaf("a", "one"), leaf("a", "two")], [0, 4, 0, 4], 1, position, () => 7),
    (error) => error.code === "POINT_BUDGET",
  );
});
test("per-sale metrics remain aligned with sorted identities, and never alias source records", () => {
  const a = { ...leaf("a", "one"), _metrics: [400000, 100, 4000] },
    b = { ...leaf("a", "two"), _metrics: [750000, 150, 5000] };
  const result = read([b, a]);
  assert.deepEqual(result.recordMetrics, [
    [400000, 100, 4000],
    [750000, 150, 5000],
  ]);
  result.recordMetrics[0][0] = 0;
  assert.equal(a._metrics[0], 400000);
});
