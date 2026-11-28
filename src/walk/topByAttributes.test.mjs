import assert from "node:assert/strict";
import test from "node:test";
import { topByAttributes } from "js-indexus-sdk";

test("mixed directions, missing values, repeated IDs and partitioned top-k", () => {
  const rows = Array.from({ length: 493 }, (_, i) => ({
    id: String(i % 19).padStart(2, "0"), location: String(i).padStart(3, "0"),
    group: i % 7 === 0 ? null : String(i % 4), size: i % 5 === 0 ? undefined : i % 11,
  }));
  const criteria = [{ select: r => r.group }, { select: r => r.size, order: "desc" }];
  const oracle = [...rows].sort((a, b) =>
    Number(a.group ?? 99) - Number(b.group ?? 99) ||
    (b.size ?? -1) - (a.size ?? -1) ||
    a.id.localeCompare(b.id) || a.location.localeCompare(b.location));
  for (const limit of [1, 9, 119, 493, 700]) {
    const rank = input => topByAttributes(input, criteria, {limit});
    assert.deepEqual(rank(rows.values()), oracle.slice(0, limit));
    assert.deepEqual(rank([...rank(rows.slice(0, 190)), ...rank(rows.slice(190))]), oracle.slice(0, limit));
  }
});

test("validates each criterion, even when earlier keys alone determine order", () => {
  assert.throws(() => topByAttributes([], []));
  assert.throws(() => topByAttributes([], [{ select: r => r, order: "up" }]));
  assert.throws(() => topByAttributes([{id:"a",v:3},{id:"z",v:false}],
    [{ select:r=>r.id },{ select:r=>r.v }], {limit:1}), /one scalar type/);
});

test("each sort key sets its own null placement, independent of direction", () => {
  const rows = [
    {id:"a", group:1, size:5}, {id:"b", group:1, size:null}, {id:"c", group:1, size:8},
    {id:"d", group:null, size:1}, {id:"e", size:4}, {id:"f"},
  ];
  const rank = (order, nulls, tieNulls) => topByAttributes(rows,[
    {select:r=>r.group, order, nulls}, {select:r=>r.size, order:"desc", nulls:tieNulls},
  ]).map(r=>r.id).join("");
  for (const order of ["asc","desc"]) {
    assert.equal(rank(order,"first","last"),"edfcab");
    assert.equal(rank(order,"last","first"),"bcafed");
  }
  assert.equal(rank("asc",undefined,undefined),"cabedf");
  assert.throws(()=>topByAttributes([], [{select:r=>r.id,nulls:"earliest"}]),RangeError);
});
