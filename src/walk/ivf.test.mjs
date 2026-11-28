import assert from "node:assert/strict";
import test from "node:test";
import {buildIvfIndex,exactKnn} from "../index.js";

test("partial probes can miss filtered neighbors; all probes match the independent full sort",()=>{
  const rows=[{id:"a",vector:[0],live:false},{id:"b",vector:[9],live:true},
    {id:"c",vector:[8],live:true},{id:"d",vector:[5],live:true}];
  const centers=[[0],[10]];
  const index=buildIvfIndex(rows.values(),centers);
  centers[0][0]=99;
  const filter=r=>r.live;
  assert.deepEqual(index.search([4],{filter,limit:3}),{hits:[{id:"d",distance_squared:1}],
    centroidDistances:2,candidateDistances:1,visitedRows:2});
  const result=index.search([4],{filter,limit:3,probes:2});
  assert.deepEqual(result.hits,[{id:"d",distance_squared:1},{id:"c",distance_squared:16},{id:"b",distance_squared:25}]);
  assert.deepEqual(result.hits,exactKnn(rows.filter(filter),[4]));
  assert.equal(result.candidateDistances,3);
  assert.equal(result.visitedRows,4);
  assert.deepEqual(index.search([0],{filter:()=>false}).hits,[]);
});
test("ties and malformed or sparse inputs",()=>{
  const idx=buildIvfIndex([{id:"b",vector:[1]},{id:"a",vector:[1]}],[[0],[2]]);
  assert.deepEqual(idx.search([1]).hits.map(h=>h.id),["a","b"]);
  assert.deepEqual(idx.search([2]).hits,[]);
  for (const probes of [0,3,0.1]) assert.throws(()=>idx.search([0],{probes}));
  for (const q of [[NaN],[1,2],[]]) assert.throws(()=>idx.search(q));
  assert.throws(()=>idx.search([0],{filter:()=>1}));
  assert.throws(()=>buildIvfIndex([],[[Infinity]]));
  assert.throws(()=>buildIvfIndex([{id:"x",vector:["0"]}],[[0]]));
  assert.throws(()=>buildIvfIndex([],[]));
});

test("incremental batches match a rebuild and failed batches stay invisible", () => {
  const rows = [{ id: "a", vector: [0] }, { id: "z", vector: [10] }];
  const batch = [{ id: "b", vector: [7] }, { id: "c", vector: [1] }];
  const centers = [[0], [10]];
  const index = buildIvfIndex(rows, centers);
  assert.throws(() => index.add([...batch, { id: "bad", vector: [NaN] }]));
  assert.deepEqual(index.search([5], { probes: 2 }), buildIvfIndex(rows, centers).search([5], { probes: 2 }));

  index.add(batch.values());
  const rebuilt = buildIvfIndex([...rows, ...batch], centers);
  for (const query of [[0], [4], [10]]) {
    for (const probes of [1, 2]) {
      assert.deepEqual(index.search(query, { probes }), rebuilt.search(query, { probes }));
    }
  }
});

test("a filter that adds rows cannot extend the search already in progress", () => {
  const index = buildIvfIndex([{ id: "a", vector: [0] }], [[0], [10]]);
  const result = index.search([0], {
    probes: 2,
    filter: () => {
      index.add([{ id: "b", vector: [10] }]);
      return true;
    },
  });
  assert.deepEqual(result.hits.map(hit => hit.id), ["a"]);
  assert.deepEqual(index.search([0], { probes: 2 }).hits.map(hit => hit.id), ["a", "b"]);
});
