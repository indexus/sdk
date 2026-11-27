// The two-field mix both perf suites and the browser check run: two
// collections of one geographic Space (their own offsets, their own points),
// drilled as a node would serve them and walked over the same view; the first
// gives a mean price, the second a share that the expression takes away.
// Same seed, same job, in Node and in the page.
import { Collection, Space, ROOT } from "../../src/tree/index.js";
import { spaceTables, parentBounds } from "../../src/gpu/cells.js";
import { createZoneIndex, walkViewport } from "../../src/walk/index.js";
import { RESOLUTION, randomPoints, drill, ingestAll } from "../../src/walk/walk.testkit.mjs";

export const MIX_SEED = 20261113;
export const MIX_NAMES = ["price", "canopy"];
export const MIX_EXPRESSION = "price * (1 - canopy / 200)";
export const MIX_POSITION = {
  mode: "metrics",
  latIndex: 3,
  lngIndex: 4,
  metricScale: 1e6,
  latOffset: 90,
  lngOffset: 180,
};

const DIMENSIONS = [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }];
const FIELDS = [
  // Value per surface, everywhere.
  { collection: "mixpricezones000", heat: [{ num: 0, den: 1, minDen: 1e-6, transform: 0 }] },
  // Mean surface (20 to 200), east of 1°E only: the west is missing.
  {
    collection: "mixcanopyzones00",
    heat: [{ num: 1, den: -1, minDen: 0, transform: 0 }],
    rect: [41, 51, 1, 9],
  },
];
const VIEWS = [
  [43, 47, -1, 4],
  [45, 49, 2, 7],
];

function field({ collection, heat, rect = [41, 51, -5, 9] }, count, seed) {
  const definition = new Collection(collection, DIMENSIONS);
  const space = new Space(definition.dimensions(), definition.mask(), definition.offset());
  const points = randomPoints(space, { seed, count, rect });
  const zones = drill(points, { maxDepth: 3 });
  const index = createZoneIndex(space);
  const store = ingestAll(index, zones);
  const views = VIEWS.map((view) => space.newSegment([view]));
  return {
    space,
    heat,
    store,
    tables: spaceTables(space),
    rows: [...zones.values()].flat().reduce((sum, block) => sum + block.n, 0),
    blocks: {
      get: (handle) => ({
        rows: store.get(handle),
        origin: parentBounds(space, store.get(handle).parent),
      }),
    },
    cellOf: (handle) => space.xyz(store.get(handle).parent || ROOT).coordinates,
    /** The plan of view `turn` (two views alternate). */
    walk: (turn = 0, zoom = 4) =>
      walkViewport(index, {
        zoom,
        resolution: RESOLUTION,
        bounds: views[turn % views.length],
        strictBounds: views[turn % views.length],
        limit: 5,
        children: 4,
        isCovered: () => false,
      }),
  };
}

/** @returns {{fields: object[], rows: number}} `count` points per collection */
export function mixJob(count, seed = MIX_SEED) {
  const fields = FIELDS.map((options, i) => field(options, count, seed + i));
  return { fields, rows: fields.reduce((sum, each) => sum + each.rows, 0) };
}
