import assert from "node:assert/strict";
import test from "node:test";
import { DocumentUniverse } from "../index.js";

for (const width of [0, 32, 33, 65]) {
  test("live mask boundaries at " + width, () => {
    const ids = Array.from({ length: width }, (_, i) => "id" + i);
    const deleted = [2, 32, 63].filter((i) => i < width);
    const u = new DocumentUniverse("seg", "r1", ids, deleted);
    const ords = ids.map((_, i) => i);
    const a = u.posting(ords.filter((i) => i % 2 === 0));
    const b = u.posting(ords.filter((i) => i % 3 === 0));
    const alive = ords.filter((i) => !deleted.includes(i));
    for (const [m, keep] of [
      [u.and(a, b), (i) => i % 2 === 0 && i % 3 === 0],
      [u.or(a, b), (i) => i % 2 === 0 || i % 3 === 0],
      [u.andNot(a, b), (i) => i % 2 === 0 && i % 3 !== 0],
      [u.not(a), (i) => i % 2 !== 0],
      [u.not(u.posting([])), () => true],
    ]) {
      assert.deepEqual(
        u.ids(m),
        alive.filter(keep).map((i) => ids[i]),
      );
    }
    assert.equal(u.count(a),alive.filter(i=>i%2===0).length);
    assert.equal(u.intersectionCount(a,b),alive.filter(i=>i%6===0).length);
    assert.equal(u.count(u.not(u.posting([]))),alive.length);
    assert.throws(() => u.posting([width]), RangeError);
  });
}

test("rejects foreign segment, revision, ordinal order, live mask and fabricated tokens", () => {
  const u = new DocumentUniverse("s", "r", ["x", "y"]);
  const a = u.posting([0]);
  for (const other of [
    new DocumentUniverse("q", "r", ["x", "y"]),
    new DocumentUniverse("s", "v2", ["x", "y"]),
    new DocumentUniverse("s", "r", ["y", "x"]),
    new DocumentUniverse("s", "r", ["x", "y"], [1]),
  ]) {
    const foreign = other.posting([0]);
    assert.throws(() => u.or(a, foreign), /universe/);
    assert.throws(() => u.intersectionCount(a,foreign), /universe/);
    assert.throws(() => u.count(foreign), /universe/);
  }
  assert.throws(() => u.not({ present: 1n, absent: 0n }), /universe/);
});

test("all signed word patterns count correctly with duplicates and deletions", () => {
  const ids=Array.from({length:1001},(_,i)=>String(i)), ords=ids.map((_,i)=>i);
  const u=new DocumentUniverse("segment","revision",ids,[31,32,63,64,999]);
  let seed=1983;
  function ordinals() {
    return ords.filter(()=>{
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      return seed>=0x80000000;
    });
  }
  for (let j=0;j<50;j++) {
    const a=ordinals(), b=ordinals(), right=new Set(b);
    const left=u.posting([...a,...a]), both=u.intersectionCount(left,u.posting(b));
    assert.equal(both,a.filter(i=>right.has(i) && ![31,32,63,64,999].includes(i)).length);
  }
  assert.throws(()=>new DocumentUniverse("s","r",new Array(1)),TypeError);
});
