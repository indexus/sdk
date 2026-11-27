// The routing table: a binary trie of peer ids, nearest by shared prefix.
import test from "node:test";
import assert from "node:assert/strict";

import { Table } from "./table.js";
import { Peer } from "../wire/peer.js";

const peer = (name) => Object.assign(Object.create(Peer.prototype), { _hash: name });

test("table: nearest follows the id's bits, falling to the only branch there is", () => {
  const table = new Table();
  const a = peer("a"); // 0000…
  const b = peer("b"); // 0100…
  const c = peer("c"); // 1100…
  table.insert(Uint8Array.of(0x00), a);
  table.insert(Uint8Array.of(0x40), b);
  table.insert(Uint8Array.of(0xc0), c);
  assert.equal(table.nearest(Uint8Array.of(0x01)), a);
  assert.equal(table.nearest(Uint8Array.of(0x7f)), b);
  assert.equal(table.nearest(Uint8Array.of(0x80)), c);
  assert.equal(table.nearest(Uint8Array.of(0xff)), c);
  assert.deepEqual(
    table.peers().map((p) => p.hash()),
    ["a", "b", "c"],
  );

  assert.equal(table.remove(Uint8Array.of(0xc0)), false);
  assert.equal(table.nearest(Uint8Array.of(0xff)), b);
  assert.deepEqual(
    table.peers().map((p) => p.hash()),
    ["a", "b"],
  );
  table.remove(Uint8Array.of(0x00));
  assert.equal(table.remove(Uint8Array.of(0x40)), true);
  assert.equal(table.nearest(Uint8Array.of(0x40)), null);
  assert.deepEqual(table.peers(), []);
  assert.throws(() => table.insert("ab", a), /Uint8Array/);
});
