import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Regression: worker Next (fresh:false) must clear Local's batch in place.
 * Reassigning `__batch = []` while `send` closes over the old array made
 * page 2+ always return [] (infinite load / Next looked finished).
 */
describe("search batch buffer aliasing", () => {
  it("reassigning __batch loses writes from a closed-over send", () => {
    const explorer = { __batch: [] };
    const closed = explorer.__batch;
    const send = (results) => {
      for (const r of results) closed.push(r);
    };

    explorer.__batch = []; // buggy Next path
    send([{ id: "page2" }]);

    assert.equal(explorer.__batch.length, 0);
    assert.equal(closed.length, 1);
  });

  it("clearing in place + live send keeps Next page items", () => {
    const explorer = { __batch: [] };
    const send = (results) => {
      const batch = explorer.__batch;
      if (!batch) return;
      for (const r of results) batch.push(r);
    };

    explorer.__batch.length = 0;
    send([{ id: "page1-a" }, { id: "page1-b" }]);
    assert.equal(explorer.__batch.length, 2);

    explorer.__batch.length = 0;
    send([{ id: "page2-a" }]);
    assert.deepEqual(
      explorer.__batch.map((r) => r.id),
      ["page2-a"],
    );
  });
});
