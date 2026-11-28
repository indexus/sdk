import assert from "node:assert/strict";
import test from "node:test";

import { buildBM25Index, exactKnn, fuseRankings, numericFacet } from "../index.js";

test("reuse the same local selection for facets, lexical, vector and hybrid results", () => {
  const documents = [
    { id: "a", floor: 1, title: "garden garden", vector: [2, 0] },
    { id: "b", floor: 2, title: "roof", vector: [0, 0] },
    { id: "c", floor: 2, title: "roof garden", vector: [1, 0] },
    { id: "d", floor: 9, title: "garden", vector: [0, 0] },
  ];
  const eligible = documents.filter(doc => doc.floor <= 2);
  const lexical = buildBM25Index(eligible, { title: 1 }).search("garden");
  const vectors = exactKnn(eligible, [0, 0]);
  assert.deepEqual(lexical.map(hit => hit.id), ["a", "c"]);
  assert.deepEqual(vectors.map(hit => hit.id), ["b", "c", "a"]);
  const view = { collection: "buildings", snapshot: "fixture-v1" };
  const hybrid = fuseRankings([
    { ...view, weight: 2, hits: lexical },
    { ...view, weight: 1, hits: vectors },
  ]);
  assert.deepEqual(hybrid.map(hit => hit.id), ["a", "c", "b"]);
  assert.deepEqual(numericFacet(eligible, doc => doc.floor).buckets, [
    { value: 1, count: 1 }, { value: 2, count: 2 },
  ]);
});
