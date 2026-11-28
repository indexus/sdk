import assert from "node:assert/strict";
import test from "node:test";
import { numericStats } from "../index.js";

test("counts document rows once, ignores weights, and visits a single-use stream once", () => {
  const values = [1e16, 1, -1e16, 0, null, undefined, NaN, Infinity, -Infinity, "5"];
  let calls = 0;
  function* rows() {
    for (const amount of values) yield { amount, weight: 99 };
  }
  assert.deepEqual(
    numericStats(rows(), (row) => {
      calls++;
      return row.amount;
    }),
    {
      matched: 10,
      present: 4,
      missing: 6,
      sum: 1,
      avg: 0.25,
      min: -1e16,
      max: 1e16,
    },
  );
  assert.equal(calls, 10);
});

test("empty and all-missing results keep an additive zero and null mean and extremes", () => {
  for (const rows of [[], [null, undefined]]) {
    assert.deepEqual(
      numericStats(rows, (x) => x),
      {
        matched: rows.length,
        present: 0,
        missing: rows.length,
        sum: 0,
        avg: null,
        min: null,
        max: null,
      },
    );
  }
});

test("a binary64 sum overflow is reported before returning a misleading result", () => {
  for (const sign of [1, -1]) {
    const big = sign * Number.MAX_VALUE;
    assert.throws(() => numericStats([big, big, -big], (x) => x), {
      name: "RangeError",
      message: "Numeric sum overflow",
    });
  }
  assert.throws(() => numericStats([], null), TypeError);
});
