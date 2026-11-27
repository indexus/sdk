// The heat defaults are the same for every collection: what a collection's
// metrics mean (a point's column, a centroid's columns, the palette's top)
// comes from the app.
import test from "node:test";
import assert from "node:assert/strict";

import {
  COLLECTION_DEFAULTS,
  CELL_POSITION_MODE_METRICS,
  normalizeCellPositionConfig,
} from "./heatmapConfig.js";
import { WALK_DEFAULTS, readOptions } from "../../walk/heat/options.js";

const BOUNDS = { mode: "bounds", metricLatIndex: 0, metricLngIndex: 0 };

test("a cell is drawn at its centre unless the app names its centroid's columns", () => {
  assert.deepEqual(normalizeCellPositionConfig(), BOUNDS);
  assert.deepEqual(normalizeCellPositionConfig(null), BOUNDS);
  assert.deepEqual(normalizeCellPositionConfig({ mode: "metrics" }), BOUNDS);
  assert.deepEqual(normalizeCellPositionConfig({ mode: "metrics", metricLatIndex: 3 }), BOUNDS);
  assert.deepEqual(
    normalizeCellPositionConfig({ mode: "bounds", metricLatIndex: 3, metricLngIndex: 4 }),
    BOUNDS,
  );
});

test("a metrics position keeps the app's columns, floored and bounded to 0..63", () => {
  const metrics = (metricLatIndex, metricLngIndex) => ({
    mode: CELL_POSITION_MODE_METRICS,
    metricLatIndex,
    metricLngIndex,
  });
  assert.deepEqual(normalizeCellPositionConfig(metrics(3, 4)), metrics(3, 4));
  const columns = { metricLatIndex: 7, metricLngIndex: 8 };
  assert.deepEqual(normalizeCellPositionConfig(columns), metrics(7, 8));
  assert.deepEqual(normalizeCellPositionConfig(metrics(1.9, "2")), metrics(1, 2));
  assert.deepEqual(normalizeCellPositionConfig(metrics(-5, 99)), metrics(0, 63));
});

test("no collection's columns or palette in the defaults", () => {
  for (const key of [
    "latMetricIndex",
    "lngMetricIndex",
    "normalizer",
    "heatmapVisualMultiplier",
    "heatmapVisualAreaMode",
    "heatmapVisualCentroidSnap",
  ])
    assert.equal(key in COLLECTION_DEFAULTS, false, key);
  assert.equal(WALK_DEFAULTS.valueMetricIndex, 0);
  assert.equal(COLLECTION_DEFAULTS.valueMetricIndex, 0);
  assert.equal(readOptions({}).valueMetricIndex, 0);
  assert.equal(readOptions({ valueMetricIndex: 2 }).valueMetricIndex, 2);
});

test("js-indexus-sdk/map exports no collection's palette or settings", async () => {
  const map = await import("../index.js");
  assert.deepEqual(Object.keys(map).sort(), [
    "AverageGridLayerWebGPU",
    "CELL_POSITION_MODE_METRICS",
    "COLLECTION_DEFAULTS",
    "LAT_OFFSET",
    "LNG_OFFSET",
    "METRIC_SCALE",
    "brightenDatavizDarkSettlementLabels",
    "compose",
    "createHeatmapPipeline",
    "detectWebGPU",
    "disableTerrain",
    "normalizeCellPositionConfig",
    "rgbRamp",
    "showWebGPUUnsupported",
    "tuneDatavizDarkBackgroundAndWater",
    "webgpuSupport",
    "webgpuUnsupportedText",
  ]);
});
