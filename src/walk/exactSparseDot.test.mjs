import assert from "node:assert/strict";
import test from "node:test";
import { exactSparseDot } from "../index.js";

test("weighted sparse ranks equal an independent dense oracle", () => {
  const toPairs = dense => dense.flatMap((value, i) => value ? [[i, value]] : []);
  const docs = Array.from({length:109}, (_, i) => ({
    id: String(i % 13).padStart(3, "0"), location: String(i).padStart(3, "0"),
    dense: Array.from({length:83}, (_, j) => (i * 7 + j * 3) % 9 === 0 ? (i + j) % 13 - 6 : 0),
  }));
  const rows = docs.map(({id, location, dense}) => ({id, location, vector:toPairs(dense)}));
  for (const q of [docs[4].dense, docs[5].dense, Array(83).fill(0)]) {
    const sorted = docs.map(({id,location,dense}) => ({
      id, location, score:dense.reduce((s,v,i)=>s+v*q[i],0),
    })).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id) || a.location.localeCompare(b.location));
    for (const limit of [1,7,109,110]) assert.deepEqual(exactSparseDot(rows.values(),toPairs(q),{limit}), sorted.slice(0,limit));
  }
});

test("signed, disjoint, zero and fractional weights retain their ranks and ties", () => {
  const rows = [
    {id:"a",location:"zz",vector:[[7,-0.5]]}, {id:"a",location:"aa",vector:[[7,-0.5]]},
    {id:"z",vector:[[1,-2]]}, {id:"m",vector:[[7,0]]}, {id:"p",vector:[[7,1.25]]},
  ];
  assert.deepEqual(exactSparseDot(rows, [[7,2]]),[
    {id:"p",score:2.5}, {id:"m",score:0}, {id:"z",score:0},
    {id:"a",location:"aa",score:-1}, {id:"a",location:"zz",score:-1},
  ]);
});

test("validates all coordinates including unmatched tails and rejects overflow", () => {
  const bad = [null,[[-1,1]],[[0,1],[0,2]],[[1,1],[0,2]],[[0,NaN]],[[0.5,1]],[[2**53,1]],[[0,1,2]]];
  for (const vector of bad) {
    assert.throws(()=>exactSparseDot([],vector));
    assert.throws(()=>exactSparseDot([{id:"x",vector}],[]));
  }
  assert.throws(()=>exactSparseDot([{id:"x",vector:[[0,1e308]]}],[[0,1e308]]),RangeError);
  for (const row of [{id:"",vector:[]},{id:"x",location:"",vector:[]}]) assert.throws(()=>exactSparseDot([row],[]));
  assert.throws(()=>exactSparseDot([],[],{limit:0}), RangeError);
});
