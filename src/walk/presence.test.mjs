import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeBlocks } from "../wire/block.js";
import { presenceMasks } from "./presence.js";

const schema = { revision:"golden-1", columns:["a","b","c"] };
const part = (block, columns = null) => ({
  complete: true, schema,
  response: { blocks: [block], columns, redirects: [] },
});

function golden(name) {
  const file = readFileSync(new URL("../wire/testdata/" + name + ".bin", import.meta.url));
  return decodeBlocks(Uint8Array.from(file));
}

test("f32 projects original positions in reordered IXB2 columns", () => {
  const {blocks, columns} = golden("columns");
  assert.deepEqual(columns, [2,0]);
  assert.deepEqual(presenceMasks([part(blocks[0],columns)], [0,1,2], {schema}), {present: 1n, absent: 4n});
});

test("f64 merges disjoint zones X1 and XYZ under a one-column projection", () => {
  const {blocks, columns} = golden("columns-f64");
  assert.deepEqual(columns, [1]);
  const [a,b] = blocks.filter((block) => block.parent === "X").map((block) => part(block, columns));
  assert.deepEqual(presenceMasks([a], [0,1,2], {schema}), {present: 0n, absent: 2n});
  assert.deepEqual(presenceMasks([a,b], [0,1,2], {schema}), {present: 2n, absent: 0n});
  assert.deepEqual(presenceMasks([a,null], [0,1,2], {schema}), {present: 0n, absent: 0n});
  assert.deepEqual(presenceMasks([null,b], [0,1,2], {schema}), {present: 2n, absent: 0n});
});

test("uncovered parts, invalid counters and unresolved redirects cannot prove absence", () => {
  const p = part({n: 2, metricCount: 4, metrics: [0,0, 1,0, 0,NaN, -1,0]});
  assert.deepEqual(presenceMasks([p], [0,1,2,3,4]), {present: 2n, absent: 1n});
  assert.deepEqual(presenceMasks([{...p, complete:false}], [0,1]), {present: 0n, absent: 0n});
  assert.deepEqual(presenceMasks([], [0,1]), {present: 0n, absent: 0n});
  p.response.redirects = [{location:"Z"}];
  assert.deepEqual(presenceMasks([p], [0,1,2,3]), {present: 2n, absent: 0n});
});

test("presence masks preserve bits beyond 32 and 64 columns", () => {
  const cols = Array.from({length: 66}, (_,i) => i);
  const metrics = new Float32Array(66);
  metrics[65] = 1;
  const result = presenceMasks([part({n:1, metricCount:66, metrics})],cols);
  assert.equal(result.present, 1n << 65n);
  assert.equal(result.absent, (1n << 65n) - 1n);
});

test("pins indicator ordinal, source dictionary and revision for every disjoint part", () => {
  const schema = {revision:"r1", columns:["urban", null, "rural"]};
  const good = {complete:true, schema:structuredClone(schema), response:{
    columns:[3, 2, 1, 0], redirects:[], blocks:[{n:1,metricCount:4,metrics:[0,0,72,1]}],
  }};
  const requested = [3,2,1,0];
  const read = parts => presenceMasks(parts,requested,{schema});
  assert.deepEqual(read([good]),{present:8n,absent:2n});
  for (const stale of [undefined, {revision:"r2",columns:schema.columns},
    {revision:"r1",columns:["rural", null, "urban"]}, {revision:"r1",columns:["urban"]}]) {
    const unverified = {...good,schema:stale};
    assert.deepEqual(read([unverified]),{present:0n,absent:0n});
    for (const parts of [[unverified,good], [good,unverified]]) {
      assert.deepEqual(read(parts),{present:8n,absent:0n});
    }
  }
  for (const columns of [["a","a"],new Array(2),[false]]) {
    assert.throws(()=>presenceMasks([],[],{schema:{revision:"r1",columns}}),TypeError);
  }
  assert.throws(()=>presenceMasks([],[],{}),TypeError);
});

test("an empty cut has no coverage; an explicitly covered empty part can prove absence only in schema", () => {
  const schema = {revision:"r1",columns:["a"]};
  const empty = {schema,complete:true,response:{blocks:[],redirects:[],columns:null}};
  assert.deepEqual(presenceMasks([], [0,1], {schema}), {present:0n,absent:0n});
  assert.deepEqual(presenceMasks([empty], [0,1], {schema}), {present:0n,absent:1n});
  assert.deepEqual(presenceMasks([empty], [0,1]), {present:0n,absent:0n});
});

test("a full block wider than its declared dictionary cannot certify that layout", () => {
  const schema = {revision:"r1",columns:["a"]};
  const p = {schema,complete:true,response:{columns:null,redirects:[],blocks:[{n:1,metricCount:2,metrics:[1,0]}]}};
  assert.deepEqual(presenceMasks([p],[0],{schema}),{present:0n,absent:0n});
});

test("exact disjoint cuts preserve the additive identity and associative regrouping", () => {
  const schema = {revision:"finite-vocabulary",columns:["a","b","c","d"]};
  const requested = [3,1,0,2,12];
  const makePart = metrics => ({schema,complete:true,response:{
    columns:null,redirects:[],blocks:[{n:1,metricCount:4,metrics}],
  }});
  const zero = makePart([0,0,0,0]);
  const groups = [[2,0,0,0],[1,1,0,0],[0,0,0,1]];
  const add = (a,b) => a.map((v,i)=>v+b[i]);
  const read = parts => presenceMasks(parts,requested,{schema});
  const want = {present:7n,absent:8n};
  const [a,b,c] = groups;
  for (const cut of [[a,b,c],[b,c,a],[add(a,b),c],[a,add(b,c)],[add(add(a,b),c)]]) {
    assert.deepEqual(read(cut.map(makePart)),want);
    assert.deepEqual(read([zero,...cut.map(makePart)]),want);
  }
});
