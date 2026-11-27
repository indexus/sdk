import { test } from "node:test";
import assert from "node:assert/strict";
import { brightenDatavizDarkSettlementLabels, tuneDatavizDarkBackgroundAndWater } from "./mapStyle.js";

function fakeMap(layers, throwing = new Set()) {
  const calls = [];
  return {
    calls,
    getLayer: (id) => layers.includes(id),
    setPaintProperty(id, name, value) {
      calls.push([id, name, value]);
      if (throwing.has(id)) throw Error("style mutation refused");
    },
  };
}

test("a style helper sets each property in order, skips missing layers and survives a throwing one", () => {
  const map = fakeMap(["City labels", "Village labels"], new Set(["City labels"]));
  brightenDatavizDarkSettlementLabels(map);
  assert.deepEqual(map.calls, [
    ["City labels", "text-color", "#ffffff"],
    ["Village labels", "text-color", "#ffffff"],
    ["Village labels", "text-halo-color", "#000000"],
    ["Village labels", "text-halo-width", 1],
    ["Village labels", "text-halo-blur", 0],
  ]);
});

test("each layer is set on its own: one that throws stops none of the others; no map is a no-op", () => {
  const map = fakeMap(["Background", "Water", "River"], new Set(["Water"]));
  tuneDatavizDarkBackgroundAndWater(map);
  assert.deepEqual(
    map.calls.map(([id]) => id),
    ["Background", "Water", "River"],
  );
  assert.doesNotThrow(() => tuneDatavizDarkBackgroundAndWater(null));
  assert.doesNotThrow(() => brightenDatavizDarkSettlementLabels({}));
});
