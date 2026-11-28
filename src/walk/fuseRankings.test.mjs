import test from "node:test";
import assert from "node:assert/strict";
import { fuseRankings } from "js-indexus-sdk";

const ranking = (ids, weight = 1) => ({
  collection: "docs", snapshot: "revision-1", weight, hits: ids.map(id => ({ id })),
});

test("matches the Python BM25 + kNN fixture and ignores raw method scores", () => {
  const text = ranking(["a", "c"], 2);
  const vector = ranking(["b", "c", "a"]);
  text.hits[1].score = 999;
  vector.hits[0].distance_squared = 0;
  const input = [text, vector];
  const copy = structuredClone(input);
  assert.deepEqual(fuseRankings(input), [
    { id: "a", score: 0.04865990111891751 },
    { id: "c", score: 0.04838709677419355 },
    { id: "b", score: 0.01639344262295082 },
  ]);
  assert.deepEqual(input, copy);
  assert.deepEqual(fuseRankings([vector, text]), fuseRankings(input));
});

test("ranks unique IDs, handles disabled lists, and resolves Unicode ties by code point", () => {
  const x = "\uE000";
  const y = "\u{10000}";
  const lists = [ranking([x, x, y]), ranking([y, x]), ranking(["ignored"], 0)];
  assert.deepEqual(fuseRankings(lists, { constant: 0, limit: 1 }), [{ id: x, score: 1.5 }]);
  assert.deepEqual(fuseRankings([ranking([])]), []);
});

test("rejects invalid weights, mixed views, conflicting IDs and overflowing scores", () => {
  const r = ranking(["a"]);
  for (const other of [{ ...r, snapshot: "other" }, { ...r, collection: "other" },
    { ...r, weight: -1 }, { ...r, weight: NaN }, { ...r, weight: null },
    { ...r, snapshot: "" }, { ...r, hits: null }, { ...r, hits: [{ id: "" }] }]) {
    assert.throws(() => fuseRankings([r, other]));
  }
  assert.throws(() => fuseRankings([{ ...r, hits: [{ id: "a", location: "0" }, { id: "a", location: "1" }] }]));
  assert.throws(() => fuseRankings([ranking([], 0)]));
  assert.throws(() => fuseRankings([ranking(["a"], 1e308), ranking(["a"], 1e308)], { constant: 0 }));
  assert.throws(() => fuseRankings([r], { limit: 0 }));
});

test("located fusion counts distinct documents and ignores repeated pairs within a list", () => {
  const a = {id:"same",location:"a"}, b = {id:"same",location:"b"}, c = {id:"z",location:"b"};
  const list = hits => ({collection:"docs",snapshot:"fixed",hits});
  const ranks = [list([a,a,b,c]),list([b,a,c])];
  const options = {identity:"location-id", constant:0};
  const expected = [{...a,score:1.5},{...b,score:1.5},{...c,score:2/3}];
  assert.deepEqual(fuseRankings(ranks,options),expected);
  assert.deepEqual(fuseRankings([...ranks].reverse(),options),expected);
  assert.throws(()=>fuseRankings([list([{id:"z"}])],options),/location/);
  assert.throws(()=>fuseRankings(ranks,{identity:"unknown"}),/identity/);
});
