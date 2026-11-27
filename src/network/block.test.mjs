import { test } from "node:test";
import assert from "node:assert/strict";
import { drop, newBlock } from "./block.js";

test("a block is checked bytes", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const block = newBlock({ id: "asset", sha256: "a".repeat(64), bytes });
  assert.equal(block.bytes, bytes);
  assert.equal(block.byteLength, 4);
  assert.throws(
    () => newBlock({ id: "asset", sha256: "a".repeat(64), bytes: new Float32Array(1) }),
    /block bytes/,
  );
  assert.throws(() => newBlock({ id: "", sha256: "a".repeat(64), bytes }), /block id/);
  assert.throws(() => newBlock({ id: "asset", sha256: "ZZ", bytes }), /block hash/);
});

test("drop forgets the bytes once", () => {
  const block = newBlock({ id: "asset", sha256: "b".repeat(64), bytes: new Uint8Array(4) });
  drop(block);
  assert.equal(block.bytes, null);
  assert.equal(drop(block).dropped, true);
});
