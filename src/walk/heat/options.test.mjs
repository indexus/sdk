// The pipeline's setters forward raw values: the worker's bounds alone must
// give what the pipeline's own bounds followed by the worker's gave.
import test from "node:test";
import assert from "node:assert/strict";

import { OPTION_MESSAGES, readOptions } from "./options.js";

/** The pipeline's former normalization; undefined: no message. */
const FORMER = {
  SET_POINT_OVERLAY_MAX_POINTS: (v) =>
    Number.isFinite(Number(v)) ? Math.max(1, Math.floor(v)) : undefined,
  SET_CUBE_SUBDIVISION_LIMIT: (v) =>
    Number.isFinite(Number(v)) ? Math.max(0, Math.floor(v)) : undefined,
  SET_REQUIRE_COMPLETE_CHILDREN: (v) => v !== false,
  SET_POLYGON_FILTER_ENABLED: (v) => v !== false,
  SET_CHILD_VIRTUALIZATION: (v) => v !== false,
};

test("a raw value bounded by the worker equals the former two-step bounds", () => {
  const values = [3, 3.7, "8", 0, -2, -0.5, NaN, Infinity, null, undefined, "x", true, false];
  for (const [type, former] of Object.entries(FORMER)) {
    const [name, normalize] = OPTION_MESSAGES[type];
    const current = readOptions({})[name];
    for (const value of values) {
      const sent = former(value);
      const before = sent === undefined ? current : normalize(sent, current);
      assert.equal(normalize(value, current), before, `${type} ${String(value)}`);
    }
  }
});
