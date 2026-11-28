import assert from "node:assert/strict";
import test from "node:test";
import { exactMaxSim } from "../index.js";

test("matches exhaustive enumeration of every assignment of query to document tokens", () => {
  // The reference considers the Cartesian product of token assignments.
  function enumerate(query, vectors, pos = 0, sum = 0) {
    if (pos === query.length) return sum;
    return Math.max(...vectors.map(v => enumerate(query,vectors,pos+1,
      sum + query[pos].reduce((s,x,i)=>s+x*v[i],0))));
  }
  const docs = Array.from({length:73}, (_,i)=>({
    id:"id"+i%7, location:String(i).padStart(2,"0"),
    vectors:Array.from({length:1+i%4},(_,j)=>[(i+3*j)%9-4,(3*i+j)%7-3,j%2]),
  }));
  for (const query of [[[1,1,2],[-1,3,2],[1,1,2]], [[0,0,0]], [[-1,-1,-1]]]) {
    const want = docs.map(({id,location,vectors})=>({id,location,score:enumerate(query,vectors)}))
      .sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)||a.location.localeCompare(b.location));
    for (const limit of [1,7,100])
      assert.deepEqual(exactMaxSim(docs.values(),query,{limit}),want.slice(0,limit));
  }
});

test("allows repeated use of one token, all negative products and typed coordinates", () => {
  assert.deepEqual(exactMaxSim([{id:"a",vectors:[new Float32Array([-2]),[-3]]}], [[1],[2]]), [{id:"a",score:-6}]);
  assert.deepEqual(exactMaxSim([],[[1]]),[]);
});

test("rejects empty, malformed, ragged or overflowing token inputs", () => {
  for (const bad of [[],[[]],[[1],[1,2]],[[Infinity]],[null],[[NaN]]]) {
    assert.throws(()=>exactMaxSim([],bad));
    assert.throws(()=>exactMaxSim([{id:"x",vectors:bad}],[[1]]));
  }
  assert.throws(()=>exactMaxSim([{id:"x",vectors:[[2]]}],[[1e308]]),RangeError);
  assert.throws(()=>exactMaxSim([{id:"x",vectors:[[1]]}],[[1e308],[1e308]]),RangeError);
  assert.throws(()=>exactMaxSim([{id:"",vectors:[[1]]}],[[1]]));
  assert.throws(()=>exactMaxSim([{id:"x",location:"",vectors:[[1]]}],[[1]]));
  assert.throws(()=>exactMaxSim([],[[1]],{limit:0}));
});
