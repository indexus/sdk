import test from "node:test";
import assert from "node:assert/strict";
import { RecordReader } from "./records.js";

test("count=1 remains a branch until an explicit full location and record ID are obtained", async () => {
  const calls = [];
  const reader = new RecordReader(async (_c, prefix) => {
    calls.push(prefix);
    return prefix === "a"
      ? { aB: { count: 1, metrics: [5] } }
      : { "aBfull:record-1": { count: 1, metrics: [5] } };
  });
  const rows = await reader.load("demo", "a", 10);
  assert.deepEqual(calls, ["a", "aB"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._hash, "aBfull");
  assert.equal(rows[0]._id, "record-1");
  assert.equal(rows[0]._terminal, true);
  const finer = await reader.load("demo", "aB", 10);
  assert.equal(finer[0], rows[0]);
  assert.equal(calls.length, 2, "a finer zoom reuses complete ancestor records");
});

test("co-located records retain their distinct IDs and a shrinking viewport never changes their full location", async () => {
  const reader = new RecordReader(async () => ({
    "ab:one": { count: 1, metrics: [3] },
    "ab:two": { count: 1, metrics: [7] },
    "ac:one": { count: 1, metrics: [9] },
  }));
  const broad = await reader.load("demo", "a", 5),
    small = reader.peek("demo", "ab").records;
  assert.equal(broad.length, 3);
  assert.equal(small.length, 2);
  assert.deepEqual(
    small.map((x) => x._id),
    ["one", "two"],
  );
  assert.ok(small.every((r) => broad.includes(r)));
});

test("incomplete/malformed branches and budgets never become cached final records", async () => {
  for (const rows of [
    { a: { count: 1 } },
    { "outside:id": { count: 1 } },
    { "a:id": { count: 2 } },
    { ab: { count: 1001 } },
  ]) {
    const reader = new RecordReader(async () => rows);
    await assert.rejects(reader.load("demo", "a", 1000));
    assert.equal(reader.peek("demo", "a"), null);
  }
  const partial = new RecordReader(async (_c, p) =>
    p === "a" ? { ab: { count: 2 } } : { "abc:id": { count: 1 } },
  );
  await assert.rejects(partial.load("demo", "a"), /Incomplete/);
  assert.equal(partial.peek("demo", "a"), null);
});

test("failed reads are retried, concurrent reads share work and clearing prevents late cache resurrection", async () => {
  let finish,
    calls = 0;
  const reader = new RecordReader(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const a = reader.load("demo", "a"),
    b = reader.load("demo", "a");
  await Promise.resolve();
  assert.equal(calls, 1);
  reader.clear();
  finish({ "ab:id": { count: 1, metrics: [2] } });
  await Promise.all([a, b]);
  assert.equal(reader.peek("demo", "a"), null);
  let attempts = 0;
  const retry = new RecordReader(async () => {
    if (!attempts++) throw new Error("temporary");
    return { "ab:id": { count: 1 } };
  });
  await assert.rejects(retry.load("demo", "a"), /temporary/);
  assert.equal((await retry.load("demo", "a")).length, 1);
});

test("stale verified records remain available during refresh; total cached record count is bounded", async () => {
  let time = 0;
  const reader = new RecordReader(async (_c, p) => ({ [p + "x:id"]: { count: 1 } }), {
    ttlMs: 5,
    now: () => time,
    maxCachedRecords: 2,
  });
  const first = await reader.load("demo", "a");
  time = 6;
  assert.equal(reader.peek("demo", "a").stale, true);
  assert.equal(reader.peek("demo", "a").records[0], first[0]);
  await reader.load("demo", "b");
  await reader.load("demo", "c");
  assert.equal(reader.size, 2);
  assert.equal(reader.peek("demo", "a"), null);
});
