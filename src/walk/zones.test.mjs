import test from "node:test";
import assert from "node:assert/strict";

import { ROOT, ROUTING_ALPHABET } from "../tree/index.js";
import { makeSpace, makeBlock } from "./walk.testkit.mjs";
import { createZoneIndex, zoneLevels } from "./zones.js";

const digit = (ch) => ROUTING_ALPHABET.indexOf(ch);

test("ingest summarises a zone per first character, in one pass", () => {
  const space = makeSpace();
  const index = createZoneIndex(space);
  const sets = makeBlock(
    "7a",
    [
      { suffix: "B", count: 4, metrics: [1, 2] },
      { suffix: "0", count: 2, metrics: [3, 4] },
    ],
    2,
  );
  const items = makeBlock(
    "7a",
    [
      { suffix: "Bxy", count: 1, metrics: [5] },
      { suffix: "Czz", count: 1, metrics: [6] },
      { suffix: "Bab", count: 1, metrics: [7] },
    ],
    1,
  );
  const foreign = makeBlock(ROOT, [{ suffix: "9", count: 9, metrics: [] }], 0);
  const summary = index.ingest("7a", [10, 11, 12], [sets, items, foreign]);
  assert.equal(summary.count, 9);
  assert.equal(summary.metricCount, 2);
  assert.deepEqual([...summary.metricSums], [22, 6]);
  assert.equal(summary.blocks.length, 2, "a block of another parent is skipped");
  const { count, rows, items: deep, metricSums } = summary.children;
  assert.deepEqual([count[digit("B")], rows[digit("B")], deep[digit("B")]], [6, 3, 2]);
  assert.deepEqual([metricSums[digit("B") * 2], metricSums[digit("B") * 2 + 1]], [13, 2]);
  assert.deepEqual([count[digit("C")], count[digit("0")]], [1, 2]);
  const ranges = summary.blocks[1].ranges;
  assert.deepEqual([ranges[2 * digit("B")], ranges[2 * digit("B") + 1]], [0, 2]);
  assert.deepEqual([ranges[2 * digit("C")], ranges[2 * digit("C") + 1]], [2, 3]);
  assert.equal(index.get("7a"), summary);
  assert.equal(index.metricCount, 2);
});

test("records placed exactly at the zone count in its total, under no child", () => {
  const index = createZoneIndex(makeSpace());
  const self = makeBlock("7a", [{ suffix: "", count: 3, metrics: [5] }], 1);
  const below = makeBlock("7a", [{ suffix: "0", count: 2, metrics: [1] }], 1);
  const summary = index.ingest("7a", [1, 2], [self, below]);
  assert.equal(summary.count, 5);
  assert.deepEqual([...summary.metricSums], [6]);
  assert.deepEqual([summary.own.count, ...summary.own.metricSums], [3, 5]);
  assert.equal(summary.children.count[digit("0")], 2);
  assert.equal(summary.children.count.reduce((a, b) => a + b), 2, "no child gets the zone's own records");
  assert.equal(summary.blocks.length, 1);
});

test("ingest replaces a zone, drop forgets it by any of its handles", () => {
  const index = createZoneIndex(makeSpace());
  const block = (count) => makeBlock(ROOT, [{ suffix: "A", count, metrics: [] }], 0);
  index.ingest(ROOT, [1], [block(1)]);
  index.ingest("", [2, 3], [block(2), block(3)]);
  assert.equal(index.get(ROOT).count, 5, "the root is named @ or empty");
  assert.deepEqual(index.drop([1]), [], "the old handle no longer names the zone");
  assert.deepEqual(index.drop([3, 2]), [ROOT]);
  assert.equal(index.get(ROOT), undefined);
});

test("ingest rejects rows that are not sorted by key", () => {
  const index = createZoneIndex(makeSpace());
  const block = makeBlock(
    "x",
    ["A", "B", "C"].map((suffix) => ({ suffix, count: 1, metrics: [] })),
    0,
  );
  block.keys[2] = block.keys[0];
  assert.throws(() => index.ingest("x", [1], [block]), /not sorted/);
});

test("binary levels of a zone add up its characters", () => {
  const space = makeSpace();
  const index = createZoneIndex(space);
  const rows = ["0", "A", "a", "_", "z"].map((suffix, i) => ({
    suffix,
    count: i + 1,
    metrics: [],
  }));
  const summary = index.ingest("Q", [1], [makeBlock("Q", rows, 0)]);
  const levels = zoneLevels(space, summary);
  assert.equal(levels.length, space.step + 1);
  for (const level of levels)
    assert.equal(
      level.count.reduce((a, b) => a + b, 0),
      15,
    );
  assert.equal(levels[0].children[0], levels[1].rows.filter((n) => n > 0).length);
});
