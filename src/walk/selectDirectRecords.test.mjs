import assert from "node:assert/strict";
import test from "node:test";
import { selectDirectRecords } from "./selectDirectRecords.js";

const rows = [
  { collection: "C", location: "aa", id: "same", metrics: [0, 10] },
  { collection: "C", location: "zz", id: "same", metrics: [1], weight: 3 },
  { collection: "C", location: "zz", id: "missing", metrics: [] },
];
test("ID and metric membership project ordered tuples across addresses", () => {
  const columns = ["location", "id", 1, 0, "weight"];
  assert.deepEqual(selectDirectRecords(rows, { ids: ["same","same"], where: {metric:0,in:[0,1]}, columns }),
    [["aa","same",10,0,1],["zz","same",null,1,3]]);
  assert.deepEqual(selectDirectRecords(rows, {where:{metric:0,in:[0]},columns:["id"]}), [["same"]]);
  assert.deepEqual(selectDirectRecords(rows, {ids:[],columns}), []);
  assert.deepEqual(selectDirectRecords(rows, {where:{metric:0,in:[]},columns}), []);
});
test("invalid columns or values fail even on an empty selection", () => {
  for (const options of [{columns:new Array(1)}, {columns:[0], ids:new Array(1)},
    {columns:[0],where:{metric:0,in:new Array(1)}}, {columns:["payload"]}, {columns:[-1]}, {columns:["id"],ids:"same"},
    {columns:[0],where:{metric:0,in:[null]}}, {columns:[0],where:{metric:-1,in:[1]}}])
    assert.throws(() => selectDirectRecords([],options), TypeError);
});

test("payload columns preserve JSON values, literal keys and direct record identity", () => {
  const payload = JSON.parse('{"id":0,"a.b":false,"__proto__":[1],"obj":{"x":1},"empty":"","nil":null}');
  const columns = ["id", ...["id", "a.b", "__proto__", "obj", "empty", "nil", "toString"].map(payload => ({ payload }))];
  assert.deepEqual(selectDirectRecords([{ id: "direct", payload }, { id: "old" }], { columns }), [
    ["direct", 0, false, [1], { x: 1 }, "", null, null],
    ["old", null, null, null, null, null, null, null],
  ]);
  for (const column of [{ payload: 1 }, Object.create({ payload: "id" }), { payload: "id", typo: true }])
    assert.throws(() => selectDirectRecords([], { columns: [column] }), TypeError);
});
