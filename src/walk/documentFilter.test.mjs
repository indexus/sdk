import assert from "node:assert/strict";
import test from "node:test";
import { documentFilter as f } from "../index.js";

test("boolean filters match an independent truth table on rows with missing and array-valued fields", () => {
  const groups = [undefined, null, 1, "1", false];
  const arrays = [undefined, null, [], [0], [false], ["1", 1], [1, 1]];
  const rows = groups.flatMap(group => arrays.map(tags => ({group, tags})));
  const group = r => r.group, tags = r => r.tags;
  const original = [1, false], allow = f.oneOf(group, original);
  original.length = 0;
  const predicate = f.and(allow, f.or(f.missing(tags), f.not(f.contains(tags, 1))));
  const truth = rows.filter(r =>
    (r.group === 1 || r.group === false) && (r.tags == null || !r.tags.includes(1)));
  assert.deepEqual(rows.filter(predicate), truth);
  assert.equal(truth.length, 10);
  assert.deepEqual(rows.filter(f.contains(tags, false)), rows.filter(r=>r.tags?.includes(false)));
  assert.equal(rows.filter(f.missing(tags)).length, 10);
  assert.deepEqual(rows.filter(f.not(f.or(f.missing(tags), f.contains(tags, 0)))),
    rows.filter(r => Array.isArray(r.tags) && !r.tags.includes(0)));
  assert.equal(f.and()({}), true);
  assert.equal(f.or()({}), false);
  assert.equal(f.oneOf(group, [])({group:1}), false);
  assert.equal(f.missing(tags)({tags:[]}), false);
  assert.equal(f.missing(tags)({}), true);
});

test("validates filters at construction and rejects malformed values on evaluated branches", () => {
  for (const make of [() => f.and(null), () => f.or(false), () => f.not(42),
    () => f.missing("name"), () => f.contains(null,2), () => f.contains(r=>r,NaN),
    () => f.oneOf(r=>r,[{}]), () => f.oneOf(r=>r,null)])
    assert.throws(make, TypeError);
  for (const bad of [[2,null], [2,Infinity], [2,{}], {}, 2])
    assert.throws(() => f.contains(r=>r,2)(bad), TypeError);
  assert.throws(() => f.oneOf(r=>r,[2])([]), TypeError);
  assert.throws(() => f.not(()=>1)({}), TypeError);
  const fail = () => { throw new Error("unexpected evaluation"); };
  assert.equal(f.or(()=>true, fail)({}), true);
  assert.equal(f.and(()=>false, fail)({}), false);
});

test("array intersections and complements handle exact types, empty arrays and absent rows", () => {
  const rows=[{}, {v:null}, {v:[]}, {v:["1",false]}, {v:[1,1]}, {v:[0,"a"]}];
  const select=r=>r.v, query=[false,1,1];
  const pred=f.containsAny(select,query);
  query.length=0;
  assert.deepEqual(rows.filter(pred),[rows[3],rows[4]]);
  assert.deepEqual(rows.filter(f.not(pred)),[rows[0],rows[1],rows[2],rows[5]]);
  assert.deepEqual(rows.filter(f.containsAny(select,[])),[]);
  for (const values of [["hit",null],["hit",[]],["hit",{}]]) {
    assert.throws(()=>f.containsAny(r=>r,["hit"])(values),TypeError);
  }
});

test("ordered array predicates compare any single element, including threshold ties", () => {
  const rows=[null,[],[-3,2],[-1],[0],[2,2]];
  const ops=[["anyLt",(a,b)=>a<b],["anyLte",(a,b)=>a<=b],["anyGt",(a,b)=>a>b],["anyGte",(a,b)=>a>=b]];
  for(const [op,compare] of ops) for(const threshold of [-3,-1,0,2,3]) {
    assert.deepEqual(rows.filter(f[op](v=>v,threshold)),
      rows.filter(v=>v?.some(n=>compare(n,threshold))));
  }
  assert.equal(f.anyGt(v=>v,"\ue000")(["𐀀"]),true);
  assert.throws(()=>f.anyGt(v=>v,1)([2,"3"]),TypeError);
  assert.throws(()=>f.anyLte(v=>v,true),TypeError);
});

test("nullable scalar membership composes as missing OR concrete membership", () => {
  const rows=[{}, {v:null}, {v:0}, {v:false}, {v:"open"}];
  const v=r=>r.v;
  assert.deepEqual(rows.filter(f.oneOf(v,[null])),rows.filter(f.missing(v)));
  assert.deepEqual(rows.filter(f.not(f.oneOf(v,[null]))),rows.slice(2));
  assert.deepEqual(rows.filter(f.oneOf(v,[null,"open"])),[rows[0],rows[1],rows[4]]);
  assert.deepEqual(rows.filter(f.oneOf(v,[])),[]);
  assert.throws(()=>f.oneOf(v,[undefined]));
  assert.throws(()=>f.containsAny(v,[null]));
});
