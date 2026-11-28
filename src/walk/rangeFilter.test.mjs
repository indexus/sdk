import assert from "node:assert/strict";
import test from "node:test";
import { documentFilter as f } from "../index.js";

const identity = x => x;
test("time range compares instants across leap days, offsets and the Unix epoch", () => {
  const bounds = {gte:"2024-02-29T00:00:00Z",lt:"2024-03-01T00:00:00.000Z"};
  const matches=f.timeRange(identity,bounds);
  for (const v of ["2024-02-28T19:00:00-05:00","2024-03-01T00:59:59.999+01:00",1709164800000]) assert.equal(matches(v),true);
  for (const v of ["2024-02-29T00:59:59.999+01:00","2024-03-01T01:00:00+01:00",null,undefined]) assert.equal(matches(v),false);
  assert.equal(f.timeRange(identity,{gte:0,lte:0})("1970-01-01T01:00:00+01:00"),true);
  assert.equal(f.timeRange(identity,{lt:0})("1969-12-31T23:59:59.999Z"),true);
  assert.equal(f.timeRange(identity,{gt:123,lte:123})("1970-01-01T00:00:00.123Z"),false);
  assert.equal(f.timeRange(identity,{gte:100,lte:100})("1970-01-01T00:00:00.1Z"),true);
  assert.equal(f.timeRange(identity,{gte:1,lte:1})("1970-01-01T00:00:00.001Z"),true);
});
test("invalid dates, unqualified times, leap seconds and sub-millisecond precision are rejected",()=>{
  const bad = ["2023-02-29T00:00:00Z","2024-02-31T00:00:00Z","2024-06-30T24:00:00Z",
    "2024-06-30T23:59:60Z","2024-02-29","2024-02-29T12:30:00","2024-02-29T12:30:00.1234Z",
    "2024-02-29T12:30:00+24:00","2024-02-29T12:30:00+01:60","2024-02-29T12:30:00-00:00",
    "2024-02-29T12:30:00Z\n",1.5,Infinity,"0",new Date(0)];
  for (const v of bad) {
    assert.throws(()=>f.timeRange(identity,{gte:v}));
    assert.throws(()=>f.timeRange(identity,{gte:0})(v));
  }
});
test("numeric comparisons and bound validation",()=>{
  const xs=[-2,0,1.5,4,8,null,undefined];
  for (const [bounds,expected] of [[{gt:0,lt:8},[1.5,4]],[{gte:0,lte:8},[0,1.5,4,8]],[{lt:0},[-2,null,undefined]],[{gte:4},[4,8]]])
    assert.deepEqual(xs.filter(f.numberRange(identity,bounds)),expected);
  for(const b of [{},{from:0},{gt:0,gte:0},{lte:0,lt:0},{gte:1,lte:0},{gt:undefined}]) assert.throws(()=>f.numberRange(identity,b));
  assert.throws(()=>f.numberRange(identity,{gt:0})("2"));
});

test("null and missing sort before every numeric or timestamp value", () => {
  const rows=[{}, {v:null}, {v:-1}, {v:0}, {v:1}];
  for(const range of [f.numberRange,f.timeRange]) {
    for(const [bounds,indices] of [
      [{lt:0},[0,1,2]],[{lte:0},[0,1,2,3]],[{gt:0},[4]],[{gte:0},[3,4]],
      [{lt:null},[]],[{lte:null},[0,1]],[{gt:null},[2,3,4]],[{gte:null},[0,1,2,3,4]],
      [{gt:null,lt:1},[2,3]],[{gte:null,lte:null},[0,1]],
    ]) assert.deepEqual(rows.filter(range(r=>r.v,bounds)),indices.map(i=>rows[i]));
  }
});
