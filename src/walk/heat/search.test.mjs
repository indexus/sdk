import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldAcceptSearch } from "./search.js";

describe("shouldAcceptSearch", () => {
  it("accepts only on nearby with no drill/search in flight", () => {
    assert.equal(
      shouldAcceptSearch({
        surface: "nearby",
        drillInFlight: false,
        searchInFlight: false,
      }),
      true,
    );
    assert.equal(
      shouldAcceptSearch({
        surface: "aggregate",
        drillInFlight: false,
        searchInFlight: false,
      }),
      false,
    );
    assert.equal(
      shouldAcceptSearch({
        surface: "nearby",
        drillInFlight: true,
        searchInFlight: false,
      }),
      false,
    );
  });
});
