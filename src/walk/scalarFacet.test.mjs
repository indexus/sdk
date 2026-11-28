import assert from "node:assert/strict";
import test from "node:test";
import { numericFacet, scalarFacet } from "js-indexus-sdk";

test("scalar buckets preserve strings, false, empty strings and missing values", () => {
  const facet = values => scalarFacet(values.values(), x => x);
  assert.deepEqual(facet(["\u{10000}", null, "", "\ue010", "", undefined]), {
    matched:6, missing:2, buckets:[{value:"",count:2},{value:"\ue010",count:1},{value:"\u{10000}",count:1}],
  });
  assert.deepEqual(facet([true,false,false]).buckets,[{value:false,count:2},{value:true,count:1}]);
  const numbers = [2,-3,null,0,undefined,2];
  assert.deepEqual(facet(numbers),numericFacet(numbers, x => x));
  for (const values of [[1,"1"],[Infinity],[[3]],[{}]]) assert.throws(() => facet(values), TypeError);
});
