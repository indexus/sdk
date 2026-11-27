// The coarse read of a region (SUMS): coverZones and blockSums against the
// loop the worker ran inline before they were shared (frozen here).
import test from "node:test";
import assert from "node:assert/strict";

import { ROOT } from "../../tree/index.js";
import { suffixAt } from "../../wire/block.js";
import { CHARS, childLocation, zoneDepth } from "../zones.js";
import { coverZones, blockSums } from "../index.js";
import { makeSpace, randomPoints, drill } from "../walk.testkit.mjs";

function referenceSums(space, zonesBlocks, bounds, maxZones) {
  const view = bounds.map(({ dimension, segment }) =>
    space.dimension(dimension).newSegment(segment),
  );
  const overlaps = (zone) => space.overlap(view, space.decode(zone)).overlap;
  let zones = [ROOT];
  for (;;) {
    const next = [];
    for (const zone of zones) {
      for (let r = 0; r < CHARS; r++) {
        const child = childLocation(zone, r);
        if (overlaps(child)) next.push(child);
      }
    }
    if (next.length > maxZones || zoneDepth(next[0] ?? ROOT) > 12) break;
    zones = next;
  }
  const rect = view[0].value();
  let totalCount = 0;
  let sums = [];
  for (const blocks of zones.map((zone) => zonesBlocks.get(zone) ?? [])) {
    for (const block of blocks) {
      if (sums.length < block.metricCount) {
        sums = [...sums, ...new Array(block.metricCount - sums.length).fill(0)];
      }
      for (let row = 0; row < block.n; row++) {
        const cell = space.decode(block.parent + suffixAt(block, row))[0].value();
        const south = Math.max(cell[0], rect[0]);
        const north = Math.min(cell[1], rect[1]);
        const west = Math.max(cell[2], rect[2]);
        const east = Math.min(cell[3], rect[3]);
        if (north <= south || east <= west) continue;
        const f = ((north - south) * (east - west)) / ((cell[1] - cell[0]) * (cell[3] - cell[2]));
        totalCount += block.count[row] * f;
        for (let j = 0; j < block.metricCount; j++) sums[j] += block.metrics[j * block.n + row] * f;
      }
    }
  }
  return { zones, totalCount, metricSums: sums };
}

test("coverZones and blockSums give the worker's former SUMS to the bit", () => {
  const space = makeSpace();
  const zonesBlocks = drill(randomPoints(space, { seed: 5, count: 600 }), { maxDepth: 3 });
  for (const [segment, maxZones] of [
    [[41, 49, -4, 9], 16],
    [[43.2, 44.9, 1.1, 3.7], 4],
    [[-80, 80, -170, 170], 64],
    [[45, 45.01, 2, 2.01], 1],
  ]) {
    const bounds = [{ dimension: 0, segment }];
    const expected = referenceSums(space, zonesBlocks, bounds, maxZones);
    assert.ok(expected.totalCount > 0);
    const view = space.dimension(0).newSegment(segment);
    const zones = coverZones(space, [view], maxZones);
    assert.deepEqual(zones, expected.zones);
    const blocks = zones.flatMap((zone) => zonesBlocks.get(zone) ?? []);
    const { totalCount, metricSums } = blockSums(space, blocks, [view]);
    assert.equal(totalCount, expected.totalCount);
    assert.deepEqual(metricSums, expected.metricSums);
  }
});
