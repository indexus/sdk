import test from "node:test";
import assert from "node:assert/strict";
import { Local } from "./index.js";
import { Collection, Space } from "../tree/index.js";
import { Item } from "../tree/item.js";
import { Set as Zone } from "../tree/set.js";

function buildTree(name, space, points) {
  // Build a 3-level tree: '@' -> depth 1 -> depth 2 -> terminal Items (depth 16).
  const byPrefix1 = new Map();
  const byPrefix2 = new Map();
  const items = [];
  for (const [id, coords] of points) {
    const hash = space.encode(space.newPoint([coords]), 16);
    const item = new Item(name, hash, [1], id);
    item._terminal = true;
    items.push({ id, coords, hash, item });
    const p1 = hash.slice(0, 1);
    const p2 = hash.slice(0, 2);
    if (!byPrefix1.has(p1)) byPrefix1.set(p1, new Set());
    byPrefix1.get(p1).add(p2);
    if (!byPrefix2.has(p2)) byPrefix2.set(p2, []);
    byPrefix2.get(p2).push(item);
  }

  const children = new Map();
  const rootChildren = [];
  for (const [p1, p2Set] of byPrefix1.entries()) {
    let count = 0;
    const lvl2 = [];
    for (const p2 of p2Set) {
      const leafItems = byPrefix2.get(p2);
      count += leafItems.length;
      lvl2.push(new Zone(name, p2, leafItems.length, [leafItems.length]));
      children.set(p2, leafItems);
    }
    rootChildren.push(new Zone(name, p1, count, [count]));
    children.set(p1, lvl2);
  }
  children.set("@", rootChildren);
  return { items, children };
}

function oracleFilter(dimension, space, origin, distanceRange, angleRange, items) {
  const filter = dimension.newFilter(distanceRange, angleRange);
  return items
    .filter(({ hash }) => {
      const [seg] = space.decode(hash);
      const dist = dimension.segmentDistance(origin, seg);
      const dir = dimension.segmentDirection(origin, seg);
      return dimension.filterDistance(filter, dist, false) && dimension.filterDirection(filter, dir);
    })
    .map(({ id }) => id)
    .sort();
}

async function runAllPages(local, emitted) {
  for (let i = 0; i < 100; i++) {
    const before = emitted.length;
    await local.search();
    if (emitted.length === before) break;
  }
  return emitted.map((item) => item.id()).sort();
}

test("Local paginated search matches exhaustive oracle across North wraparound, South, and parallel-tangent sectors", async () => {
  const name = "AngularLocalTest";
  const collection = new Collection(name, [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }]);
  const space = new Space(collection.dimensions(), collection.mask(), collection.offset());
  const dimension = space.dimension(0);

  const points = [
    ["north-exact", [45, 0]],
    ["north-west", [47, -0.5]],
    ["north-east", [47, 0.5]],
    ["north-near-hole", [40.1, 0]],
    ["tangent-hit", [45.05, 54.7356]],
    ["south-exact", [32, 0]],
    ["south-east", [33, 0.4]],
    ["south-west", [33, -0.4]],
    ["east-far", [40, 25]],
    ["west-far", [40, -25]],
  ];
  // Add a deterministic ring of 36 points around (40, 0).
  for (let k = 0; k < 36; k++) {
    const rad = (k * 10 * Math.PI) / 180;
    points.push([`ring-${k}`, [40 + 4 * Math.cos(rad), 4 * Math.sin(rad)]]);
  }

  const { items, children } = buildTree(name, space, points);
  const network = {
    readOptions: () => ({ method: "getSet" }),
    getConcurrency: () => 4,
    getSet: async (_name, location) => children.get(location) ?? [],
  };

  const cases = [
    { label: "North wraparound + annulus", origin: [40, 0], dist: [100, 1200], angle: [345, 15] },
    { label: "North 0..10 deg", origin: [40, 0], dist: [0, 1200], angle: [0, 10] },
    { label: "Parallel tangent extremum", origin: [30, 0], dist: [0, 8000], angle: [52, 56] },
    { label: "South sector excludes due-North", origin: [40, 0], dist: [0, 1200], angle: [165, 195] },
  ];

  for (const tc of cases) {
    const origin = dimension.newPoint(tc.origin);
    const expected = oracleFilter(dimension, space, origin, tc.dist, tc.angle, items);
    assert.ok(expected.length > 0, `${tc.label}: expected at least one matching item`);

    const emitted = [];
    const local = new Local(
      { [name]: space },
      {
        cap: 1,
        step: 3,
        origins: { gps: origin },
        filters: { gps: dimension.newFilter(tc.dist, tc.angle) },
      },
      { send: (batch) => emitted.push(...batch) },
      { send() {} },
      network,
    );

    const got = await runAllPages(local, emitted);
    assert.deepEqual(got, expected, `${tc.label}: mismatch`);
    // Verify no duplicate IDs across paginated waves.
    assert.equal(new Set(emitted.map((i) => i.id())).size, emitted.length, `${tc.label}: duplicates`);
  }
});
