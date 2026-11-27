import test from "node:test";
import assert from "node:assert/strict";
import { asyncPool } from "./network.js";

test("pool bounds concurrency, preserves input order and drains started jobs on failure", async () => {
  let active = 0,
    peak = 0;
  assert.deepEqual(
    await asyncPool(2, [3, 2, 1], async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, value));
      active--;
      return value * 2;
    }),
    [6, 4, 2],
  );
  assert.equal(peak, 2);
  let finished = false;
  const started = [];
  const failure = new Error("read unavailable");
  await assert.rejects(
    asyncPool(2, [0, 1, 2, 3], async (value) => {
      started.push(value);
      if (value === 0) {
        await new Promise((r) => setTimeout(r, 1));
        throw failure;
      }
      await new Promise((r) => setTimeout(r, 10));
      finished = true;
    }),
    (error) => error === failure,
  );
  assert.equal(finished, true);
  assert.deepEqual(started, [0, 1]);
});

test("dependency failures notify immediately and drain waiters before returning", async () => {
  const failure = new Error("parent checksum failed");
  let release,
    finished = false;
  const dependency = new Promise((_, reject) => {
    release = reject;
  });
  dependency.catch(() => {});
  await assert.rejects(
    asyncPool(
      2,
      ["parent", "child"],
      async (role) => {
        if (role === "parent") {
          await Promise.resolve();
          throw failure;
        }
        try {
          await dependency;
        } finally {
          finished = true;
        }
      },
      { onError: (error) => release(error) },
    ),
    (error) => error === failure,
  );
  assert.equal(finished, true);
});

test("aborted pools never start queued preparation", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  await assert.rejects(
    asyncPool(
      3,
      [1, 2, 3],
      () => {
        called++;
      },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(called, 0);
});
