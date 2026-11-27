import test from "node:test";
import assert from "node:assert/strict";
import { Local } from "./index.js";
import { Item } from "../tree/item.js";
import { Set as Zone } from "../tree/set.js";

function fixture(projected, leaves) {
  const emitted = [],
    lookups = [];
  const space = {
    decode: (hash) => [{ hash }],
    dimension: () => ({
      name: () => "gps",
      ratio: () => 1,
      segmentDistance: (_origin, segment) =>
        segment.hash === "@" ? 100 : segment.hash === "a" ? 10 : 1,
      segmentDirection: () => 0,
      filterDirection: () => true,
      filterDistance: () => true,
    }),
  };
  const network = {
    readOptions: () => ({ method: "getSets" }),
    getConcurrency: () => 2,
    getSets: async () => new Map([["@", [projected]]]),
    getRecords: async (_c, location) => {
      lookups.push(location);
      return leaves;
    },
  };
  const local = new Local(
    { demo: space },
    { cap: 1, step: 1, origins: { gps: {} }, filters: { gps: {} } },
    { send: (rows) => emitted.push(...rows) },
    { send() {} },
    network,
  );
  return { local, emitted, lookups };
}

test("Nearby resolves a binary count=1 proxy before streaming a final item", async () => {
  const proxy = new Item("demo", "a", [1], "a");
  proxy._terminal = false;
  const leaf = new Item("demo", "abcdef", [1], "record-id");
  leaf._terminal = true;
  const f = fixture(proxy, [leaf]);
  await f.local.search();
  assert.deepEqual(f.lookups, ["a"]);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0], leaf);
  assert.notEqual(f.emitted[0], proxy);
});

test("Nearby preserves two terminal IDs at the same full location across pages", async () => {
  const zone = new Zone("demo", "a", 2, [2]);
  zone._terminal = false;
  const leaves = ["one", "two"].map((id) => {
    const item = new Item("demo", "abcdef", [1], id);
    item._terminal = true;
    return item;
  });
  const f = fixture(zone, leaves);
  await f.local.search();
  await f.local.search();
  assert.deepEqual(
    f.emitted.map((r) => r._id),
    ["one", "two"],
  );
  assert.ok(f.emitted.every((r) => r._hash === "abcdef" && r._terminal));
});
