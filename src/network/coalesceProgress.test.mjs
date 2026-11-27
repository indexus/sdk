import test from "node:test";
import assert from "node:assert/strict";
import { SetsCoalescePool } from "./setsCoalescePool.js";

test("ready readers resolve while an unrelated chunk remains blocked; failures stay local", async () => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const fetched = new Map();
  const pool = new SetsCoalescePool({
    maxChunkSize: 1,
    maxParallelChunks: 2,
    fetchChunk: async (_c, locations) => {
      if (locations[0] === "b") {
        await slow;
        throw new Error("offline b");
      }
      fetched.set(locations[0], ["value"]);
    },
    finalizeWaiter: (_c, w) => new Map(w.uniqInput.map((k) => [k, fetched.get(k)])),
  });
  const a = pool.submit("c", new Map(), ["a"], ["a"]);
  const b = pool.submit("c", new Map(), ["b"], ["b"]);
  const shared = pool.submit("c", new Map(), ["a", "b"], ["a", "b"]);
  const rejectedB = assert.rejects(b, /offline b/),
    rejectedShared = assert.rejects(shared, /offline b/);
  let timeout;
  try {
    const ready = await Promise.race([
      a,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("a blocked behind b")), 1000);
      }),
    ]);
    assert.deepEqual(ready.get("a"), ["value"]);
  } finally {
    clearTimeout(timeout);
    release();
  }
  await Promise.all([rejectedB, rejectedShared]);
});

test("a chunk rejected without an Error still rejects its dependent reader", async () => {
  const pool = new SetsCoalescePool({
    fetchChunk: () => Promise.reject(undefined),
    finalizeWaiter: () => assert.fail("failed read finalized"),
  });
  await pool.submit("c", new Map(), ["a"], ["a"]).then(
    () => assert.fail("failed chunk resolved"),
    (reason) => assert.equal(reason, undefined),
  );
});
