// The ramps without d3 give what d3 gave: every sample, colour parse and WGSL
// ramp of testdata/colorRamp.d3.json (frozen d3 7.9.0 output, see
// testdata/colorRamp.d3.gen.mjs). Its two ramps, "white" and "dark", are
// sample stops (the apps' palettes live in the apps): rgbRamp builds them
// from the frozen domain, range and clamp.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { parseColor, rgbRamp } from "./colorRamp.js";
import { generateColorRampWgsl } from "../gpu/wgsl/draw.js";

const D3 = JSON.parse(readFileSync(new URL("./testdata/colorRamp.d3.json", import.meta.url)));
const SCALES = Object.fromEntries(
  Object.entries(D3.scales).map(([name, { domain, range, clamp }]) => [
    name,
    rgbRamp(domain, range, { clamp }),
  ]),
);

const dec = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && "$" in v
    ? v.$ === "undefined"
      ? undefined
      : v.$ === "-0"
        ? -0
        : Number(v.$)
    : v;
const sha = (s) => createHash("sha256").update(s).digest("hex");

for (const [name, scale] of Object.entries(SCALES)) {
  const frozen = D3.scales[name];

  test(`${name}: domain, range and clamp are d3's`, () => {
    assert.deepEqual(scale.domain(), frozen.domain);
    assert.deepEqual(scale.range(), frozen.range);
    assert.equal(scale.clamp(), frozen.clamp);
    assert.notEqual(scale.domain(), scale.domain(), "a copy each call, as d3");
  });

  test(`${name}: every sample is d3's string (${frozen.samples.length})`, () => {
    for (const [input, output] of frozen.samples) {
      const x = dec(input);
      assert.equal(scale(x), dec(output), `${name}(${JSON.stringify(input)})`);
      assert.equal(scale.copy()(x), dec(output));
    }
  });

  test(`${name}: generateColorRampWgsl is d3's for 1 to 64 colours`, () => {
    for (const [n, expected] of Object.entries(D3.ranges[name])) {
      const wgsl = generateColorRampWgsl(Number(n), scale);
      assert.equal(expected.length === 64 ? sha(wgsl) : wgsl, expected, `${n} colours`);
    }
  });
}

test("parseColor is d3.color, channel for channel", () => {
  for (const [format, expected] of D3.colors) {
    const actual = parseColor(format);
    if (expected === null) {
      assert.equal(actual, null, format);
      continue;
    }
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), format);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(
        Object.is(actual[key], dec(value)),
        `${format}.${key}: ${actual[key]} for ${dec(value)}`,
      );
    }
  }
});

test("rgbRamp: two stops on a reversed domain; opacity; clamped ends (values from d3)", () => {
  const reversed = rgbRamp([1, 0], ["red", "blue"]);
  assert.equal(reversed(0.25), "rgb(64, 0, 191)");
  assert.equal(reversed(2), "rgb(255, 0, 0)");
  const clamped = rgbRamp([0, 0.5, 1], ["#000", "#fff", "rgba(0, 0, 0, 0.5)"], { clamp: true });
  assert.equal(clamped(0.75), "rgba(128, 128, 128, 0.75)");
  assert.equal(clamped(9), "rgba(0, 0, 0, 0.5)");
  assert.equal(clamped(-1), "rgb(0, 0, 0)");
});

test("js-indexus-sdk/map exports rgbRamp, for the app's palettes", async () => {
  const map = await import("../map/index.js");
  assert.equal(map.rgbRamp, rgbRamp);
});
