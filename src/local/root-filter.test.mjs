import test from "node:test";
import assert from "node:assert/strict";
import { Local } from "./index.js";
import { Collection, Space } from "../tree/index.js";
import { Item } from "../tree/item.js";
import { Set as ZoneSet } from "../tree/set.js";

function searchFixture({ definitions, origin, distance, direction, rows, names = ["NearbyRootTest01"] }) {
  const emitted = [], reads = [], spaces = {}, byCollection = {};
  for (const name of names) {
    const collection = new Collection(name, definitions);
    const space = new Space(collection.dimensions(), collection.mask(), collection.offset());
    spaces[name] = space;
    byCollection[name] = rows.map(([id, coordinates]) => {
      const hash = space.encode(space.newPoint(coordinates), 16);
      const item = new Item(name, hash, [1], id);
      item._terminal = true;
      return item;
    });
  }
  const dimension = spaces[names[0]].dimension(0);
  const local = new Local(
    spaces,
    { cap: 1, step: 10, origins: { [dimension.name()]: dimension.newPoint(origin) },
      filters: { [dimension.name()]: dimension.newFilter(distance, direction) } },
    { send: (items) => emitted.push(...items) },
    { send() {} },
    { readOptions: () => ({ method: "getSet" }), getConcurrency: () => 2,
      getSet: async (collection, location) => {
        reads.push([collection, location]);
        assert.equal(location, "@");
        return byCollection[collection];
      } },
  );
  return { local, emitted, reads };
}

test("Nearby searches a linear collection with a finite maximum distance", async () => {
  const f = searchFixture({
    definitions: [{ name: "time", type: "linear", args: [0, 1000] }],
    origin: [500], distance: [0, 10], direction: [0],
    rows: [["inside", [[501]]], ["outside", [[800]]]],
  });
  await f.local.search();
  assert.deepEqual(f.emitted.map((item) => item.id()), ["inside"]);
  assert.equal(f.reads.length, 1);
});

test("Nearby reaches GPS records within a finite radius and still rejects distant records", async () => {
  const f = searchFixture({
    definitions: [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }],
    origin: [43.485, -1.52], distance: [0, 1], direction: [0, 0],
    rows: [["near", [[43.4851, -1.52]]], ["far", [[44, -1.52]]]],
  });
  await f.local.search();
  assert.deepEqual(f.emitted.map((item) => item.id()), ["near"]);
  assert.equal(f.reads.length, 1);
});

test("Nearby seeds the whole GPS root before applying an angular filter to records", async () => {
  const f = searchFixture({
    definitions: [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }],
    origin: [0, 0], distance: [0, 0], direction: [45, 135],
    rows: [["east", [[0.001, 0.01]]], ["west", [[0.001, -0.01]]]],
  });
  await f.local.search();
  assert.deepEqual(f.emitted.map((item) => item.id()), ["east"]);
});

test("Nearby finite-radius search seeds every requested collection", async () => {
  const f = searchFixture({
    definitions: [{ name: "time", type: "linear", args: [0, 1000] }],
    origin: [500], distance: [0, 10], direction: [0],
    rows: [["near", [[501]]]], names: ["NearbyRootTest01", "NearbyRootTest02"],
  });
  await f.local.search();
  assert.deepEqual(f.emitted.map((item) => item.collection()).sort(), ["NearbyRootTest01", "NearbyRootTest02"]);
  assert.equal(f.reads.length, 2);
});


test("Nearby reads a zone whose closest spherical point is not at the origin latitude", async () => {
  const collection = new Collection("Q5SphericalTest1", [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }]);
  const space = new Space(collection.dimensions(), collection.mask(), collection.offset());
  const dimension = space.dimension(0);
  const zone = space.encode(space.newPoint([[33.75, 67.5]]), 1);
  assert.deepEqual(space.decode(zone)[0].value(), [22.5, 45, 45, 90]);
  const rows = [["inside", [39.2, 45.0001]], ["outside", [22.6, 89.9]]].map(([id, coordinates]) => {
    const item = new Item(collection.name(), space.encode(space.newPoint([coordinates]), 16), [1], id);
    assert.ok(item.hash().startsWith(zone));
    item._terminal = true;
    return item;
  });
  const reads = [], emitted = [];
  const local = new Local(
    { [collection.name()]: space },
    { cap: 1, step: 10, origins: { gps: dimension.newPoint([30, 0]) },
      filters: { gps: dimension.newFilter([0, 4250], [0, 0]) } },
    { send: items => emitted.push(...items) }, { send() {} },
    { readOptions: () => ({ method: "getSet" }), getConcurrency: () => 2,
      getSet: async (name, location) => {
        reads.push(location);
        if (location === "@") return [new ZoneSet(name, zone, 2, [2])];
        assert.equal(location, zone);
        return rows;
      } },
  );
  await local.search();
  assert.deepEqual(emitted.map(item => item.id()), ["inside"]);
  assert.deepEqual(reads, ["@", zone]);
});
