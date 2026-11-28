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

test("ready pages select only the requested items and preserve ties with changing page sizes",async()=>{
  const zone=new Zone("demo","a",96,[96]);
  const leaves=Array.from({length:96},(_,i)=>{
    const item=new Item("demo","abcdef",[1],String(i));
    item._terminal=true;
    return item;
  });
  const f=fixture(zone,leaves);
  let selected=0, distanceCalls=0;
  f.local.monitoring.send=event=>{
    if(event.state()==="selected" && event.element() instanceof Item) selected++;
  };
  for(const item of leaves){
    const original=item.distance.bind(item);
    item.distance=()=>{distanceCalls++;return original();};
  }
  for(const step of [1,2,4,1,16,32,7,32,32,1]) {
    const before=f.emitted.length;
    f.local.options.step=step;
    selected=distanceCalls=0;
    await f.local.search();
    const available=Math.min(step,leaves.length-before);
    assert.equal(f.emitted.length-before,available);
    assert.equal(selected,available);
    if(before>0) assert.ok(distanceCalls<=step+3,`unexpected re-sort on ready page: ${distanceCalls}`);
  }
  assert.deepEqual(f.emitted,leaves);
  assert.deepEqual(f.lookups,["a"]);
});
