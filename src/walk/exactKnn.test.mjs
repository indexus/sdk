import assert from "node:assert/strict";
import test from "node:test";
import { exactKnn } from "js-indexus-sdk";

test("matches full-sort distances for one-pass candidates and any top-k", () => {
  const docs = Array.from({ length: 193 }, (_, i) => ({
    id: String(192 - i).padStart(3, "0"),
    vector: Float32Array.of(i % 7, i % 5),
    include: i % 3 !== 0,
  }));
  function* selected() {
    for (const d of docs) if (d.include) yield d;
  }
  const expected = docs.filter(d => d.include).map(({ id, vector: [x, y] }) => ({
    id, distance_squared: (x - 2) ** 2 + (y - 3) ** 2,
  })).sort((a, b) => a.distance_squared - b.distance_squared || a.id.localeCompare(b.id));
  for (const limit of [1, 5, 10, 1000]) {
    assert.deepEqual(exactKnn(selected(), Float64Array.of(2, 3), { limit }), expected.slice(0, limit));
  }
  const exhausted = selected();
  Array.from(exhausted);
  assert.deepEqual(exactKnn(exhausted, [2, 3]), []);
});

test("ties follow document ID then location including across a top-k cutoff", () => {
  const docs = ["\u{10000}", "\ue000", "b", "a", "a"].map((id, i) => ({
    id, location: String(4 - i), vector: [0],
  }));
  assert.deepEqual(exactKnn(docs, [0], { limit: 3 }), [
    { id: "a", location: "0", distance_squared: 0 },
    { id: "a", location: "1", distance_squared: 0 },
    { id: "b", location: "2", distance_squared: 0 },
  ]);
  assert.deepEqual(exactKnn(docs, [0]).map(h => h.id), ["a", "a", "b", "\ue000", "\u{10000}"]);
});

test("rejects invalid vectors even after cheaper candidates fill the result", () => {
  for (const q of [[], [NaN], [Infinity], new DataView(new ArrayBuffer(4))]) {
    assert.throws(() => exactKnn([], q));
  }
  for (const vector of [[0], [1, null], [1, Infinity], [1, 1e308]]) {
    assert.throws(() => exactKnn([{ id:"a", vector:[0,0] }, { id:"b", vector:[0,0] },
      { id:"z", vector }], [0,0], {limit:1}));
  }
  assert.throws(() => exactKnn([], [1], { limit: 0 }));
});

test("cosine top-k matches an exhaustive dot-product oracle and keeps deterministic ties", () => {
  const docs = Array.from({length:85}, (_,i)=>({
    id:String(84-i), vector:Int16Array.of(i%11-5, 1+i%7, i%3-2),
  }));
  const query = [1,-3,2];
  const norm = v => Math.sqrt(v.reduce((sum,x)=>sum+x*x,0));
  const oracle = docs.map(({id,vector})=>({
    id, distance:1-vector.reduce((s,x,i)=>s+x*query[i],0)/(norm(query)*norm(vector)),
  })).sort((a,b)=>a.distance-b.distance||(a.id<b.id?-1:1)).slice(0,7);
  const hits=exactKnn(docs.values(),query,{metric:"cosine",limit:7});
  assert.deepEqual(hits.map(h=>h.id),oracle.map(h=>h.id));
  hits.forEach((h,i)=>assert.ok(Math.abs(h.cosine_distance-oracle[i].distance)<1e-14));
  const tied = ["b","a","a"].map((id,i)=>({id,location:String(3-i),vector:[0,2]}));
  assert.deepEqual(exactKnn(tied,[0,1],{metric:"cosine",limit:1}),[{id:"a",location:"1",cosine_distance:0}]);
  assert.deepEqual(exactKnn(docs,query,{metric:"l2_squared"}),exactKnn(docs,query));
});

test("cosine handles extreme scales and tiny angles; zero norms and invalid metrics reject", () => {
  const distance=(query,vector)=>exactKnn([{id:"a",vector}],query,{metric:"cosine"})[0].cosine_distance;
  const low=Number.MIN_VALUE, high=Number.MAX_VALUE;
  assert.equal(distance([high, high],[low,low]),0);
  assert.equal(distance([high,0],[-low,0]),2);
  assert.equal(distance([0,high],[low,0]),1);
  assert.ok(Math.abs(distance([1,0],[1,1e-12])-5e-25)<1e-38);
  assert.throws(()=>exactKnn([],[-0,0],{metric:"cosine"}),/nonzero/);
  assert.throws(()=>exactKnn([{id:"z",vector:[0,0]}],[0,1],{metric:"cosine"}),/nonzero/);
  assert.throws(()=>distance([high,0],[NaN,low]),/coordinate/);
  assert.throws(()=>exactKnn([], [1], {metric:"other"}),/metric/);
});
