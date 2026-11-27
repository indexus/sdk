import test from "node:test";
import assert from "node:assert/strict";

import { createFrame, frameOf, FRAME_PACK, FRAME_COMBINE, FRAME_DRAW } from "./frame.js";
import { fakeDevice } from "./device.testkit.mjs";

const submits = (device) => device.log.filter(([type]) => type === "submit").length;

test("recorders of every stage go into one encoder and one submit, packs first", () => {
  const device = fakeDevice();
  const frame = createFrame(device, { defer: () => {} });
  const order = [];
  const encoders = new Set();
  const record = (name) => (encoder) => {
    order.push(name);
    encoders.add(encoder);
  };
  frame.add("layer", record("draw"), FRAME_DRAW);
  frame.add("mix", record("combine"), FRAME_COMBINE);
  frame.add("price", record("pack price"), FRAME_PACK);
  frame.add("canopy", record("pack canopy"));
  assert.equal(frame.has("price"), true);
  assert.equal(frame.has("price", FRAME_DRAW), false);
  assert.equal(submits(device), 0, "nothing is submitted before the frame ends");

  assert.equal(frame.submit(), true);
  assert.deepEqual(order, ["pack price", "pack canopy", "combine", "draw"]);
  assert.equal(encoders.size, 1);
  assert.equal(submits(device), 1);
  assert.equal(frame.submits, 1);

  assert.equal(frame.submit(), false, "an empty frame submits nothing");
  assert.equal(submits(device), 1);
});

test("an owner that adds twice is encoded once, with its last recorder, after the others", () => {
  const frame = createFrame(fakeDevice(), { defer: () => {} });
  const order = [];
  frame.add("a", () => order.push("a, first"));
  frame.add("b", () => order.push("b"));
  frame.add("a", () => order.push("a, last"));
  frame.submit();
  assert.deepEqual(order, ["b", "a, last"]);
});

test("after() runs once the frame is submitted, even an empty one", () => {
  const device = fakeDevice();
  const frame = createFrame(device, { defer: () => {} });
  const seen = [];
  frame.add("a", () => seen.push("record"));
  frame.after(() => seen.push(`after ${submits(device)} submit`));
  frame.submit();
  frame.after(() => seen.push("after nothing"));
  frame.submit();
  assert.deepEqual(seen, ["record", "after 1 submit", "after nothing"]);
  assert.equal(submits(device), 1);
});

test("a frame nobody submits is flushed at the end of the turn, once", async () => {
  const device = fakeDevice();
  const frame = frameOf(device);
  assert.equal(frameOf(device), frame, "one frame per device");
  let runs = 0;
  frame.add("a", () => runs++);
  frame.add("b", () => runs++, FRAME_DRAW);
  assert.equal(submits(device), 0);
  await null;
  assert.equal(runs, 2);
  assert.equal(submits(device), 1);

  // Submitted by hand before the turn ends: the deferred flush finds nothing.
  frame.add("a", () => runs++);
  frame.submit();
  await null;
  assert.equal(submits(device), 2);
});

test("a recorder that throws is reported and the others are still submitted", (t) => {
  const device = fakeDevice();
  const frame = createFrame(device, { defer: () => {} });
  const errors = t.mock.method(console, "error", () => {});
  let ran = false;
  frame.add("bad", () => {
    throw new RangeError("not a plan");
  });
  frame.add("good", () => {
    ran = true;
  });
  frame.submit();
  assert.equal(ran, true);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(submits(device), 1);
});
