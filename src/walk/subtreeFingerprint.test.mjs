import assert from "node:assert/strict";
import test from "node:test";
import {mergeSubtreeFingerprints as merge} from "./subtreeFingerprint.js";
const raw = (sum, count) => ({algorithm:"sha256-add256-v1", sum:sum.padStart(64,"0"), count});
test("summaries compose over disjoint rows with carry, wrap and exact counts", () => {
  const a = raw("f".repeat(64), "9007199254740993");
  const b = raw("2", "1");
  const c = raw("ff", "2");
  assert.deepEqual(merge([]),raw("0","0"));
  assert.deepEqual(merge([a,b,c]),raw("100","9007199254740996"));
  assert.deepEqual(merge([a,merge([b,c])]),merge([merge([c,a]),b]));
  assert.deepEqual(merge([merge([]),c]),c);
});
test("unknown observations and incompatible formats cannot become a zero", () => {
  const entry = raw("1","1");
  for (const bad of [null,{},raw("1","0"), {...entry,algorithm:"other"}, {...entry,sum:"0".repeat(63)},
    {...entry,count:"01"}, {...entry,count:"1\n"}, {...entry,count:1}]) {
    assert.throws(()=>merge([entry,bad]), TypeError);
  }
  assert.throws(()=>merge([raw("1","18446744073709551615"),entry]),RangeError);
});
