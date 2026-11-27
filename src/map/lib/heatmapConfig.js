import { WALK_DEFAULTS } from "../../walk/heat/options.js";

// Defaults of the heat walk and layer, the same for every collection: what a
// collection's metrics mean (which column a point shows, where a centroid
// is, the value at the top of the palette) comes from the app.
export const COLLECTION_DEFAULTS = {
  valueMetricIndex: WALK_DEFAULTS.valueMetricIndex,
  // metric centroids: a latitude is stored as (lat + 90) · 1e6, a longitude as (lng + 180) · 1e6
  metricScale: 1_000_000,
  metricLatOffset: 90,
  metricLngOffset: 180,
  metricMaxIndex: 63,
  pointOverlayMaxPoints: WALK_DEFAULTS.pointOverlayMaxPoints,
  cubeSubdivisionLimit: WALK_DEFAULTS.cubeSubdivisionLimit,
  cubeChildrenThreshold: WALK_DEFAULTS.cubeChildrenThreshold,
  cubeCacheMaxCells: 100000,
  childVirtualizationEnabled: false,
  algorithmResolution: WALK_DEFAULTS.algorithmResolution,
  parentFallbackDepth: WALK_DEFAULTS.parentFallbackDepth,
  polygonDataFilterEnabled: true,
  polygonVisualFilterEnabled: true,
};

export const METRIC_SCALE = COLLECTION_DEFAULTS.metricScale;
export const LAT_OFFSET = COLLECTION_DEFAULTS.metricLatOffset;
export const LNG_OFFSET = COLLECTION_DEFAULTS.metricLngOffset;
const METRIC_MAX_INDEX = COLLECTION_DEFAULTS.metricMaxIndex;

const CELL_POSITION_MODE_BOUNDS = "bounds";
export const CELL_POSITION_MODE_METRICS = "metrics";

/**
 * Where a cell is drawn. Metrics: at the centroid its metrics carry, columns
 * `metricLatIndex` and `metricLngIndex` (given by the app). Bounds: at the
 * centre of the cell, the default, and what a metrics setting without both
 * columns falls back to.
 */
export function normalizeCellPositionConfig(raw) {
  let metricLatIndex = Number(raw?.metricLatIndex);
  let metricLngIndex = Number(raw?.metricLngIndex);
  const metrics =
    raw?.mode !== CELL_POSITION_MODE_BOUNDS &&
    Number.isFinite(metricLatIndex) &&
    Number.isFinite(metricLngIndex);
  if (!metrics) return { mode: CELL_POSITION_MODE_BOUNDS, metricLatIndex: 0, metricLngIndex: 0 };
  metricLatIndex = Math.max(0, Math.min(METRIC_MAX_INDEX, Math.floor(metricLatIndex)));
  metricLngIndex = Math.max(0, Math.min(METRIC_MAX_INDEX, Math.floor(metricLngIndex)));
  return { mode: CELL_POSITION_MODE_METRICS, metricLatIndex, metricLngIndex };
}
