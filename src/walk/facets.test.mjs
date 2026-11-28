import test from "node:test";
import assert from "node:assert/strict";
import { RecordReader } from "../network/records.js";
import { numericFacet } from "./facets.js";

test("a client follows children and recomposes its records after transport closes", async () => {
  const requests = [];
  const zones = {
    a: { ab: {count: 2}, ac: {count: 1} },
    ab: {"ab:x": {count: 1, metrics: [5, 1]}, "ab:y": {count: 1, metrics: [9]}},
    ac: {"ac:z": {count: 1, metrics: [13, 0]}},
  };
  let offline = false;
  const reader = new RecordReader(async (_, prefix) => {
    assert.equal(offline, false);
    requests.push(prefix);
    return zones[prefix];
  });
  const rows = await reader.load("demo", "a", 3);
  offline = true;
  const usage = row => row.metrics()[1];
  const midrise = rows.filter(row => row.metrics()[0] >= 5 && row.metrics()[0] <= 10);
  assert.deepEqual(numericFacet(midrise, usage), {matched: 2, missing: 1, buckets: [{value: 1, count: 1}]});
  assert.deepEqual(numericFacet(rows, usage), {matched: 3, missing: 1, buckets: [{value: 0, count: 1}, {value: 1, count: 1}]});
  assert.deepEqual(requests.sort(), ["a","ab","ac"]);
});
