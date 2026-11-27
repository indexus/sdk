import { test } from "node:test";
import assert from "node:assert/strict";
import { nextDisplayZoom } from "./view.js";

test("nearby zoom catch-up uses one intermediate level in either direction", () => {
  assert.equal(nextDisplayZoom(11, 8.25, 5), 7.25);
  assert.equal(nextDisplayZoom(12, 8.25, 5), 8.25);
  assert.equal(nextDisplayZoom(13, 6.25, 5), 7.25);
  assert.equal(nextDisplayZoom(12, 6.25, 5), 6.25);
});

test("large zoom, first image and reversal join the latest camera without historical steps", () => {
  assert.equal(nextDisplayZoom(undefined, 8.25, 5), 8.25);
  assert.equal(nextDisplayZoom(11, 10.25, 5), 10.25);
  assert.equal(nextDisplayZoom(15, 4.25, 5), 4.25);
  assert.equal(nextDisplayZoom(12, 6.25, 5), 6.25);
});
