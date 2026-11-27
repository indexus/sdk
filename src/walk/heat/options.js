// Options of the heat worker: INIT's payload and the SET_* messages, with
// their defaults and bounds. map/lib/heatmapConfig.js COLLECTION_DEFAULTS
// carries these defaults under the same names.

export const WALK_DEFAULTS = {
  // the metric a point of the overlay shows (per item): the app names its column
  valueMetricIndex: 0,
  pointOverlayMaxPoints: 1000,
  cubeSubdivisionLimit: 5,
  cubeChildrenThreshold: 4,
  algorithmResolution: 5,
  parentFallbackDepth: 6,
};

function positive(value, fallback) {
  return Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : fallback;
}

function nonNegative(value, fallback) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback;
}

const flag = (value) => value !== false;

/** Option messages: [option, normalize]. Each one re-walks the view. */
export const OPTION_MESSAGES = {
  SET_POINT_OVERLAY_MAX_POINTS: ["maxPoints", positive],
  SET_CUBE_SUBDIVISION_LIMIT: ["limit", nonNegative],
  SET_REQUIRE_COMPLETE_CHILDREN: ["requireCompleteChildren", flag],
  SET_ALGO_RESOLUTION: ["resolution", positive],
  SET_POLYGON_FILTER_ENABLED: ["polygonFilter", flag],
  SET_VALUE_METRIC_INDEX: ["valueMetricIndex", nonNegative],
  SET_CHILD_VIRTUALIZATION: ["virtualize", flag],
};

export function readOptions(payload) {
  const cube = payload.cubeOpt ?? {};
  const points = payload.pointOverlay?.maxPoints;
  return {
    resolution: positive(cube.resolution, WALK_DEFAULTS.algorithmResolution),
    limit: nonNegative(cube.limit, WALK_DEFAULTS.cubeSubdivisionLimit),
    children: positive(cube.children, WALK_DEFAULTS.cubeChildrenThreshold),
    requireCompleteChildren: payload.requireCompleteChildren !== false,
    virtualize: payload.childVirtualizationEnabled !== false,
    polygonFilter: payload.polygonFilterEnabled !== false,
    valueMetricIndex: nonNegative(payload.valueMetricIndex, WALK_DEFAULTS.valueMetricIndex),
    maxPoints: positive(points, WALK_DEFAULTS.pointOverlayMaxPoints),
    autoDelta: payload.autoDelta === true,
    // a plan is sent once the view's detail is read (no plan of a view half read)
    completePlans: payload.completePlans === true,
  };
}
