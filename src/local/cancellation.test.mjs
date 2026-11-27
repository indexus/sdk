import { test } from "node:test";
import assert from "node:assert/strict";
import { getSet } from "./observer.js";
import { run } from "./exploration.js";
import { Set as Zone } from "../tree/set.js";

for (const records of [false, true])
  test(`Local ${records ? "record" : "zone"} reads carry cancellation and never ingest canceled data`, async () => {
    const controller = new AbortController();
    let resolve, seen;
    const read = (...args) => {
      seen = args.at(-1).signal;
      return new Promise((yes) => {
        resolve = yes;
      });
    };
    const network = records ? { getRecords: read } : { getSet: read };
    const context = { options: { signal: controller.signal }, network };
    const promise = getSet.call(context, new Zone("demo", "a", 3, [3]), () =>
      assert.fail("canceled result was ingested"),
    );
    const rejected = assert.rejects(promise, { code: "ERR_CANCELED" });
    assert.equal(seen, controller.signal);
    controller.abort();
    resolve([]);
    await rejected;
  });

test("Local stops its traversal before preparing another layer after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    run.call({
      options: { signal: controller.signal },
      prepare: () => assert.fail("obsolete traversal continued"),
    }),
    { code: "ERR_CANCELED" },
  );
});
