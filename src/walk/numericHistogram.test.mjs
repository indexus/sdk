import assert from "node:assert/strict";
import test from "node:test";
import { histogramQuantile, mergeNumericHistograms, numericHistogram } from "../index.js";

const bounds = [0, 3, 6, 10];
const of = rows => numericHistogram(rows, x => x, bounds);
test("boundaries, underflow, overflow and missing retain disjoint counts", () => {
  const h = of([-2,0,0,3,5,10,12,Infinity,null,NaN,"3"]);
  assert.deepEqual(h,{bounds,counts:[1,2,2,0,2],missing:4});
  assert.deepEqual(histogramQuantile(h,0),{rank:1,firstRank:1,lastRank:1,lowerInclusive:null,upperExclusive:0});
  assert.deepEqual(histogramQuantile(h,0.5),{rank:4,firstRank:4,lastRank:5,lowerInclusive:3,upperExclusive:6});
  assert.deepEqual(histogramQuantile(h,1),{rank:7,firstRank:6,lastRank:7,lowerInclusive:10,upperExclusive:null});
  assert.equal(histogramQuantile(of([null]),1),null);
});
test("partition merges preserve every bucket and each nearest-rank oracle value", () => {
  const values = Array.from({length:509},(_,i) => (i * 23 % 79) / 4 - 4);
  const a=of(values.slice(0,73)), b=of(values.slice(73,222)), c=of(values.slice(222));
  const expected=of(values);
  assert.deepEqual(mergeNumericHistograms([of([]),mergeNumericHistograms([a,b]),c]),expected);
  assert.deepEqual(mergeNumericHistograms([c,a,b]),expected);
  const sorted=values.toSorted((a,b)=>a-b);
  for (let i=0;i<=1000;i++) {
    const q=i/1000;
    const oracleRank=Math.max(1,Math.ceil(q*sorted.length));
    const {rank,firstRank,lastRank,lowerInclusive,upperExclusive}=histogramQuantile(expected,q);
    assert.equal(rank,oracleRank);
    assert.ok(firstRank<=rank && rank<=lastRank);
    for (const j of [firstRank,rank,lastRank]) {
      if (lowerInclusive!==null) assert.ok(sorted[j-1]>=lowerInclusive);
      if (upperExclusive!==null) assert.ok(sorted[j-1]<upperExclusive);
    }
    if (firstRank>1) assert.ok(sorted[firstRank-2]<lowerInclusive);
    if (lastRank<sorted.length) assert.ok(sorted[lastRank]>=upperExclusive);
  }
});
test("reject mismatched partitions, malformed counts, overflowing totals and invalid quantiles",()=>{
  assert.throws(()=>mergeNumericHistograms([]));
  assert.throws(()=>mergeNumericHistograms([of([]),numericHistogram([],x=>x,[1])]));
  for (const bounds of [[],[1,1],[2,1],[0,Infinity],new Array(1)]) assert.throws(()=>numericHistogram([],x=>x,bounds));
  for (const counts of [[-1,2],[1.5,0],new Array(2),[0],[Number.MAX_SAFE_INTEGER,1]]) {
    assert.throws(()=>histogramQuantile({bounds:[0],counts,missing:0},0.5));
  }
  const max = {bounds:[1],counts:[Number.MAX_SAFE_INTEGER,0],missing:0};
  assert.throws(()=>mergeNumericHistograms([max,{bounds:[1],counts:[0,0],missing:1}]));
  for (const q of [-1,NaN,2]) assert.throws(()=>histogramQuantile(of([]),q));
});

test("opt-in midpoint reads serialized legacy histograms and preserves open tails", () => {
  const h = JSON.parse('{"bounds":[0,4,10],"counts":[1,3,2,1],"missing":20}');
  const opts = {estimate:"midpoint"};
  for (const [q,want] of [[0,null],[0.4,2],[0.8,7],[1,null]]) {
    const plain = histogramQuantile(h,q);
    assert.ok(!("estimate" in plain));
    assert.deepEqual(histogramQuantile(h,q,opts),{...plain,estimate:want});
  }
  assert.equal(histogramQuantile(of([null,NaN]),0.5,opts),null);
  assert.throws(()=>histogramQuantile(h,0.5,{estimate:"linear"}),RangeError);
});
test("midpoints remain finite and inside half-open binary64 intervals", () => {
  const m=Number.MAX_VALUE, tiny=Number.MIN_VALUE;
  for(const [lo,hi] of [[-m,m],[-m,m/2],[m/2,m],[-m,-m/2],[-tiny,0],[0,tiny],
    [1+Number.EPSILON,1+2*Number.EPSILON],[1,1+Number.EPSILON]]) {
    const h={bounds:[lo,hi],counts:[0,1,0],missing:0};
    const e=histogramQuantile(h,0.5,{estimate:"midpoint"}).estimate;
    assert.ok(Number.isFinite(e) && e>=lo && e<hi,`bounds ${lo}, ${hi}, estimate ${e}`);
  }
  assert.equal(histogramQuantile({bounds:[-m,m],counts:[0,1,0],missing:0},1,{estimate:"midpoint"}).estimate,0);
});

test("tracked extrema bound open tails, preserve exact endpoint ranks and merge with neutral old empties",()=>{
  const tracked=rows=>numericHistogram(rows,x=>x,[0,10],{trackExtrema:true});
  const old=rows=>numericHistogram(rows,x=>x,[0,10]);
  const opts={estimate:"midpoint"};
  const rows=[-20,-10,1,2,13,15,40,null];
  const h=tracked(rows);
  assert.deepEqual([h.min,h.max,h.missing],[-20,40,1]);
  assert.deepEqual(histogramQuantile(h,0.8,opts).estimateRange,{lower:10,upper:40,upperInclusive:true});
  assert.deepEqual(histogramQuantile(h,0.25,opts).estimateRange,{lower:-20,upper:0,upperInclusive:false});
  assert.deepEqual(histogramQuantile(h,1,opts).estimateRange,{lower:40,upper:40,upperInclusive:true});
  assert.deepEqual([0,0.25,0.5,0.8,1].map(q=>histogramQuantile(h,q,opts).estimate),[-20,-10,5,25,40]);
  assert.deepEqual(mergeNumericHistograms([tracked(rows.slice(0,4)),old([]),tracked(rows.slice(4))]),h);
  const mixed=mergeNumericHistograms([tracked(rows.slice(0,4)),old(rows.slice(4))]);
  assert.deepEqual(mixed,old(rows));
  assert.equal(histogramQuantile(mixed,1,opts).estimate,null);
  assert.deepEqual(tracked([null]),{bounds:[0,10],counts:[0,0,0],missing:1,min:null,max:null});
  assert.equal(histogramQuantile(tracked([2,2,2]),0.5,opts).estimate,2);
  for (const extra of [{min:-20},{min:0,max:40},{min:-20,max:9},{min:NaN,max:40}]) {
    const broken={...old(rows),...extra};
    assert.throws(()=>histogramQuantile(broken,0.5,opts));
    assert.throws(()=>mergeNumericHistograms([broken]));
  }
  assert.throws(()=>numericHistogram([],x=>x,[0],{trackExtrema:"yes"}));
});
