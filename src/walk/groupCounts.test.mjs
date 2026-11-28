import assert from "node:assert/strict";
import test from "node:test";
import { groupCounts, limitPerGroup } from "../index.js";

test("counts full tuples with missing columns and deterministic scalar order", () => {
  const rows = [
    ["a,b","c",false,0], ["a","b,c",false,0], ["a","b,c",false,-0],
    ["a","b,c",false,-3], ["a","b,c",true,4], ["a","b,c",null,5],
    ["a",null,false,0], [null], [],
  ];
  const selectors = [0,1,2,3].map(i => row => row[i]);
  const expected = [
    {values:["a","b,c",false,-3], count:1}, {values:["a","b,c",false,0], count:2},
    {values:["a","b,c",true,4], count:1}, {values:["a","b,c",null,5], count:1},
    {values:["a",null,false,0], count:1}, {values:["a,b","c",false,0], count:1},
    {values:[null,null,null,null], count:2},
  ];
  assert.deepEqual(groupCounts(rows.values(), selectors), expected);
  assert.deepEqual(groupCounts(rows.toReversed(), selectors), expected);
  assert.deepEqual(groupCounts([], selectors), []);
});

test("validates selectors and rejects unsupported or mixed types in each column", () => {
  assert.throws(() => groupCounts([], []), TypeError);
  assert.throws(() => groupCounts([], [null]), TypeError);
  for (const value of [Infinity, NaN, {}, [], 1n]) {
    assert.throws(() => groupCounts([value], [row => row]), TypeError);
  }
  assert.throws(() => groupCounts([[1,false],[2,0]], [r=>r[0],r=>r[1]]), /one scalar type/);
});

test("group caps preserve rank and backfill using distinct scalar tuples", () => {
  const rows = [["a", "b/c"], ["a", "b/c"], ["a/b", "c"], ["a", null], ["a", undefined]];
  const keys = [row => row[0], row => row[1]];
  assert.deepEqual(limitPerGroup(rows, keys, { perGroup: 1, limit: 5 }), [rows[0], rows[2], rows[3]]);
  assert.deepEqual(limitPerGroup(rows, keys, { perGroup: 2, limit: 2 }), rows.slice(0, 2));
  function* firstTwo() { yield rows[0]; yield rows[2]; throw Error("consumed past limit"); }
  assert.deepEqual(limitPerGroup(firstTwo(), keys, { perGroup: 1, limit: 2 }), [rows[0], rows[2]]);
  assert.deepEqual(limitPerGroup(firstTwo(), keys, { perGroup: 1, limit: 0 }), []);
  assert.throws(() => limitPerGroup([], keys, { perGroup: 0, limit: 1 }), RangeError);
  assert.throws(() => limitPerGroup([], [], { perGroup: 1, limit: 1 }), TypeError);
});

test("offset counts complete groups in key order, independent of input order", () => {
  const rows = [[1,"b"],[2,"x"],[1,"a"],[null,"z"],[1,"b"],[2,"x"],[1,null],[1,"b"]];
  const cols = [r=>r[0], r=>r[1]];
  const oracle = [
    {values:[1,"a"],count:1},{values:[1,"b"],count:3},{values:[1,null],count:1},
    {values:[2,"x"],count:2},{values:[null,"z"],count:1},
  ];
  for (const offset of [0,1,2,4,5,100,Number.MAX_SAFE_INTEGER]) {
    for (const limit of [0,1,2,5,Number.MAX_SAFE_INTEGER])
      assert.deepEqual(groupCounts(rows.values(),cols,{offset,limit}),oracle.slice(offset,offset+limit));
    assert.deepEqual(groupCounts(rows.toReversed(),cols,{offset}),oracle.slice(offset));
  }
  for (const value of [-1,1.2,Infinity,2**53,"2",null]) {
    assert.throws(()=>groupCounts([],cols,{offset:value}),RangeError);
    assert.throws(()=>groupCounts([],cols,{limit:value}),RangeError);
  }
});
