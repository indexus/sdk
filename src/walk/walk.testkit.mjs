// Synthetic IXB2 data for the walk tests: points -> the rows blocks a node
// would serve for each zone. Not part of the package (`files` ships *.js).
import { Collection, Space, ROOT, ROUTING_ALPHABET } from "../tree/index.js";
import { keyWords, seededRandom, writeKey } from "../gpu/cells.testkit.mjs";

export const COLLECTION = "walkparityzones";

export function makeSpace() {
  const collection = new Collection(COLLECTION, [
    { name: "gps", type: "spherical", args: [-90, 90, -180, 180] },
  ]);
  return new Space(collection.dimensions(), collection.mask(), collection.offset());
}

/** Metric layout of the fixtures: value, surface, price, lat·1e6 (offset), lng·1e6 (offset). */
export const METRICS = 5;

/** Resolution constant and heat rules of the walk fixtures: value per surface, average price, log count. */
export const RESOLUTION = 5;
export const HEAT = [
  { num: 0, den: 1, minDen: 1e-6, transform: 0 },
  { num: 2, den: -1, minDen: 0, transform: 0 },
  { num: -1, den: -1, minDen: 0, transform: 1 },
];

/**
 * `count` random points in `rect` [south, north, west, east], one per
 * location of `depth` characters.
 */
export function randomPoints(
  space,
  { seed = 1, count = 200, depth = 6, rect = [40, 50, -5, 10] } = {},
) {
  const random = seededRandom(seed);
  const byLocation = new Map();
  for (let i = 0; i < count; i++) {
    const lat = rect[0] + random() * (rect[1] - rect[0]);
    const lng = rect[2] + random() * (rect[3] - rect[2]);
    const location = space.encode(space.newPoint([[lat, lng]]), depth);
    if (byLocation.has(location)) continue;
    byLocation.set(location, [
      Math.round(1000 + random() * 1e6),
      Math.round(20 + random() * 180),
      Math.round(1000 + random() * 5e5),
      Math.round((lat + 90) * 1e6),
      Math.round((lng + 180) * 1e6),
    ]);
  }
  return [...byLocation].map(([location, metrics]) => ({ location, metrics }));
}

const digits = (suffix) => [...suffix].map((ch) => ROUTING_ALPHABET.indexOf(ch));

function compareSuffix(a, b) {
  const x = digits(a);
  const y = digits(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** A RowsBlock (docs/layers.md §2) from `{suffix, count, metrics}` rows of one length. */
export function makeBlock(parent, rows, metricCount = METRICS) {
  rows = rows.slice().sort((a, b) => compareSuffix(a.suffix, b.suffix));
  const n = rows.length;
  const suffixChars = rows[0].suffix.length;
  const words = keyWords(suffixChars);
  const keys = new Uint32Array(n * words);
  const count = new Uint32Array(n);
  const metrics = new Float32Array(n * metricCount);
  rows.forEach((row, i) => {
    writeKey(row.suffix, keys, i * words);
    count[i] = row.count;
    for (let j = 0; j < metricCount; j++) metrics[j * n + i] = row.metrics[j] ?? 0;
  });
  return {
    parent: parent === ROOT ? "" : parent,
    suffixChars,
    keyWords: words,
    metricCount,
    revision: 0,
    n,
    keys,
    count,
    metrics,
  };
}

/**
 * The blocks a node serves for `zone`: one row per item when the zone holds
 * at most `itemThreshold` points, otherwise one Set row per child character
 * (metrics rounded to float32 once, as the encoder does).
 */
export function serve(points, zone, { itemThreshold = 8 } = {}) {
  const prefix = zone === ROOT ? "" : zone;
  const inside = points.filter(
    (p) => p.location.startsWith(prefix) && p.location.length > prefix.length,
  );
  if (inside.length === 0) return [];
  const metricCount = Math.max(METRICS, ...inside.map((p) => p.metrics.length));
  if (inside.length <= itemThreshold) {
    return [
      makeBlock(
        zone,
        inside.map((p) => ({
          suffix: p.location.slice(prefix.length),
          count: 1,
          metrics: p.metrics,
        })),
        metricCount,
      ),
    ];
  }
  const sets = new Map();
  for (const p of inside) {
    const suffix = p.location[prefix.length];
    const set = sets.get(suffix) ?? { suffix, count: 0, metrics: new Array(metricCount).fill(0) };
    set.count++;
    p.metrics.forEach((v, j) => (set.metrics[j] += Math.fround(v)));
    sets.set(suffix, set);
  }
  return [makeBlock(zone, [...sets.values()], metricCount)];
}

/**
 * Zones a Grid would have drilled: breadth first from the root, every zone
 * served with Sets is drilled down to `maxDepth` characters, except `skip`.
 * @returns {Map<string, RowsBlock[]>}
 */
export function drill(points, { maxDepth = 3, itemThreshold = 8, skip = [] } = {}) {
  const zones = new Map();
  const queue = [ROOT];
  while (queue.length) {
    const zone = queue.shift();
    const blocks = serve(points, zone, { itemThreshold });
    zones.set(zone, blocks);
    const depth = zone === ROOT ? 0 : zone.length;
    if (depth >= maxDepth || blocks.length === 0 || blocks[0].suffixChars !== 1) continue;
    const prefix = zone === ROOT ? "" : zone;
    const children = new Set(
      points
        .filter((p) => p.location.startsWith(prefix))
        .map((p) => p.location.slice(0, depth + 1)),
    );
    for (const child of [...children].sort()) if (!skip.includes(child)) queue.push(child);
  }
  return zones;
}

/** A store over the drilled zones, and an index fed from it. */
export function ingestAll(index, zones) {
  const blocks = new Map();
  let handle = 1;
  for (const [zone, rows] of zones) {
    const handles = rows.map(() => handle++);
    handles.forEach((h, i) => blocks.set(h, rows[i]));
    index.ingest(zone, handles, rows);
  }
  return { get: (h) => blocks.get(h), blocks };
}
