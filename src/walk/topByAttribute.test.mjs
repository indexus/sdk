import assert from "node:assert/strict";
import test from "node:test";
import { topByAttribute } from "js-indexus-sdk";

test("native full-sort oracle across limits, partitions, directions and missing values", () => {
  const rows = Array.from({ length: 311 }, (_, i) => ({
    id: String(i % 19).padStart(2, "0"), location: String(i).padStart(3, "0"),
    price: i % 4 ? (i * 31) % 97 : i % 8 ? null : undefined,
  }));
  for (const order of ["asc", "desc"]) {
    const d = order === "asc" ? 1 : -1;
    const sorted = [...rows].sort((a,b) =>
      Number(a.price == null) - Number(b.price == null) ||
      ((a.price ?? 0) - (b.price ?? 0)) * d || a.id.localeCompare(b.id) || a.location.localeCompare(b.location));
    for (const limit of [1, 10, 310, 311, 500]) {
      let visits = 0;
      const got = topByAttribute(rows.values(), row => { visits++; return row.price; }, { order, limit });
      assert.deepEqual(got, sorted.slice(0, limit));
      assert.equal(visits, rows.length);
      const byPrice = ds => topByAttribute(ds, r => r.price, {order, limit});
      assert.deepEqual(byPrice([...byPrice(rows.slice(0, 170)), ...byPrice(rows.slice(170))]), got);
    }
  }
});

test("code-point ordering, boolean attributes and stable identical keys", () => {
  const rows = [{id:"z", a:"\u{10000}"}, {id:"a", a:"\ue000"}, {id:"a", a:"\ue000"}, {id:"n"}];
  const asc = topByAttribute(rows, r => r.a);
  assert.equal(asc[0], rows[1]);
  assert.equal(asc[1], rows[2]);
  assert.deepEqual(asc, [rows[1], rows[2], rows[0], rows[3]]);
  assert.deepEqual(topByAttribute(rows, r => r.a, {order:"desc"}), [rows[0], rows[1], rows[2], rows[3]]);
  const byBool = [{id:"y",x:true}, {id:"x",x:false}];
  assert.deepEqual(topByAttribute(byBool, r => r.x), [byBool[1],byBool[0]]);
});

test("empty iterable, mixed scalar types and invalid values", () => {
  assert.deepEqual(topByAttribute([], r => r.v), []);
  for (const values of [[0, "0"], [false, 0], [NaN], [Infinity], [{}]]) {
    assert.throws(() => topByAttribute(values.map((v,i) => ({id:String(i),v})), r=>r.v));
  }
  assert.throws(() => topByAttribute([], x=>x, {order:"ascending"}));
  assert.throws(() => topByAttribute([], x=>x, {limit:0}));
});

test("single-key placement treats absent and explicit null alike",()=>{
  const rows=[{id:"b", v:3},{id:"a"}, {id:"c",v:null},{id:"d",v:1}];
  for (const [order,nulls,expected] of [
    ["asc","first","acdb"],["desc","first","acbd"],
    ["asc","last","dbac"],["desc","last","bdac"],
  ]) assert.equal(topByAttribute(rows,r=>r.v,{order,nulls}).map(r=>r.id).join(""),expected);
});
