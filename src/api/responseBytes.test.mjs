import test from "node:test";
import assert from "node:assert/strict";
import { responseWireBytes } from "./getSets.js";

test("chunked gzip size comes from matching Resource Timing, not decoded size", () => {
  assert.equal(responseWireBytes({}, [{ startTime: 30, encodedBodySize: 500 }], 25), 500);
  assert.ok(Number.isNaN(responseWireBytes({}, [{ startTime: 10, encodedBodySize: 1000 }], 25)));
  assert.equal(responseWireBytes({ "content-length": "800" }), 800);
  assert.equal(
    responseWireBytes({ "content-length": "800" }, [{ startTime: 30, encodedBodySize: 500 }], 25),
    500,
  );
});
