// Per-zone summaries of IXB2 rows blocks (docs/heat-pipeline.md §b). The
// blocks leave the worker for the main-thread store right after ingest, so
// the walk only keeps what it needs to descend: per first character of the
// suffix, the mass and where its rows sit in each block.
import { ROOT, ROUTING_ALPHABET, BITS_PER_CHAR } from "../tree/index.js";
import { suffixAt } from "../wire/block.js";
import { allSums, combineColumns, hasOrdered, kindsOf, resetColumns } from "./columns.js";

export const CHARS = 1 << BITS_PER_CHAR;

/** Zone name of a block parent: the wire sends the root as "". */
export function zoneName(location) {
  return location ? location : ROOT;
}

export function zoneDepth(zone) {
  return zone === ROOT ? 0 : zone.length;
}

/** Location of the child of `zone` whose suffix starts with routing digit `r`. */
export function childLocation(zone, r) {
  return (zone === ROOT ? "" : zone) + ROUTING_ALPHABET[r];
}

/**
 * Geometric 6-bit cell index of routing digit `r` at level `level`: wire keys
 * and Space cells share one alphabet, shifted by the Space offset of the
 * level (docs/layers.md §1).
 */
export function geometricDigit(space, level, r) {
  return (((r - space.offset.at(level)) % 64) + 64) % 64;
}

/**
 * xyz of `xyz` refined by the first `bits` bits (MSB first) of the geometric
 * `digit` at `level`. Spaces whose step is an integer refine every coordinate
 * once per `space.size` bits, so the resolution stays one number.
 */
export function refineXyz(space, xyz, level, digit, bits) {
  if (bits === 0) return xyz;
  const coordinates = xyz.coordinates.slice();
  for (let n = 0; n < bits; n++) {
    const axis = space.mask.at(level, n);
    coordinates[axis] = coordinates[axis] * 2 + ((digit >> (BITS_PER_CHAR - 1 - n)) & 1);
  }
  return { resolution: xyz.resolution + bits / space.size, coordinates };
}

/**
 * @param {import("../tree/space.js").Space} space
 * @param {{ kinds?: string[] }} [options] the column kinds of the collection
 *   (its description's schema, tree/description.js); without them every
 *   column is a sum
 */
export function createZoneIndex(space, options = {}) {
  if (!Number.isInteger(space.step)) {
    throw new RangeError(`walk: a Space needs an integer step, got ${space.step}`);
  }
  /** @type {Map<string, ZoneSummary>} */
  const zones = new Map();
  /** @type {Map<number, string>} */
  const zoneOfHandle = new Map();
  const index = {
    space,
    metricCount: 0,
    kinds: Array.isArray(options.kinds) ? options.kinds.slice() : null,

    /**
     * Replaces the summary of `zone` with the rows of `rowsBlocks` (one pass,
     * no object per row). `handles[i]` names `rowsBlocks[i]` in the store.
     * Blocks whose parent is not `zone` are skipped (wire-block.md sends
     * foreign keys under the root).
     * @returns {ZoneSummary}
     */
    ingest(zone, handles, rowsBlocks) {
      const name = zoneName(zone);
      const ids = typeof handles === "number" ? [handles] : handles;
      if (ids.length !== rowsBlocks.length) throw new RangeError("walk: one handle per rows block");
      forget(name);
      const summary = allSums(index.kinds)
        ? summarize(name, ids, rowsBlocks)
        : summarizeTyped(space, index.kinds, name, ids, rowsBlocks);
      zones.set(name, summary);
      for (const block of summary.blocks) zoneOfHandle.set(block.handle, name);
      index.metricCount = Math.max(index.metricCount, summary.metricCount);
      return summary;
    },

    /** Forgets every zone that holds one of `handles`. @returns {string[]} */
    drop(handles) {
      const dropped = [];
      for (const handle of handles) {
        const name = zoneOfHandle.get(handle);
        if (name !== undefined && forget(name)) dropped.push(name);
      }
      return dropped;
    },

    get(zone) {
      return zones.get(zoneName(zone));
    },
  };

  function forget(name) {
    const previous = zones.get(name);
    if (!previous) return false;
    for (const block of previous.blocks) zoneOfHandle.delete(block.handle);
    zones.delete(name);
    return true;
  }

  return index;
}

/**
 * @typedef {{
 *   location: string, depth: number, count: number, metricCount: number,
 *   metricSums: Float64Array, own: { count: number, metricSums: Float64Array },
 *   children: { count: Float64Array, rows: Uint32Array, items: Uint32Array,
 *     metricSums: Float64Array },
 *   blocks: Array<{ handle: number, n: number, suffixChars: number,
 *     metricCount: number, ranges: Uint32Array }>,
 * }} ZoneSummary
 * `own` holds the records placed exactly at the zone (a block of self keys,
 * suffixChars 0): they count in the zone's total, under no child.
 * `children` is indexed by the routing digit of the first suffix character;
 * `metricSums` there is digit-major (m per digit). `items` counts rows more
 * than one character below the zone. `ranges[2r]..ranges[2r+1]` are the rows
 * of digit r in that block (empty when equal).
 */
function summarize(location, handles, rowsBlocks) {
  let m = 0;
  const kept = [];
  for (let i = 0; i < rowsBlocks.length; i++) {
    const block = rowsBlocks[i];
    if (zoneName(block.parent) !== location || block.n === 0) continue;
    kept.push(i);
    m = Math.max(m, block.metricCount);
  }
  const count = new Float64Array(CHARS);
  const rows = new Uint32Array(CHARS);
  const items = new Uint32Array(CHARS);
  const charMetrics = new Float64Array(CHARS * m);
  const own = { count: 0, metricSums: new Float64Array(m) };
  const blocks = [];
  for (const i of kept) {
    const block = rowsBlocks[i];
    const { n, keyWords, keys, metricCount, metrics } = block;
    if (block.suffixChars === 0) {
      for (let row = 0; row < n; row++) {
        own.count += block.count[row];
        for (let j = 0; j < metricCount; j++) own.metricSums[j] += metrics[j * n + row];
      }
      continue;
    }
    const ranges = new Uint32Array(2 * CHARS);
    const deep = block.suffixChars > 1;
    for (let row = 0; row < n; row++) {
      const r = keys[row * keyWords] >>> (32 - BITS_PER_CHAR);
      if (ranges[2 * r + 1] === 0) ranges[2 * r] = row;
      else if (ranges[2 * r + 1] !== row) throw new Error("walk: rows block is not sorted by key");
      ranges[2 * r + 1] = row + 1;
      count[r] += block.count[row];
      rows[r]++;
      if (deep) items[r]++;
      for (let j = 0; j < metricCount; j++) charMetrics[r * m + j] += metrics[j * n + row];
    }
    blocks.push({ handle: handles[i], n, suffixChars: block.suffixChars, metricCount, ranges });
  }
  let total = own.count;
  const metricSums = Float64Array.from(own.metricSums);
  for (let r = 0; r < CHARS; r++) {
    total += count[r];
    for (let j = 0; j < m; j++) metricSums[j] += charMetrics[r * m + j];
  }
  return {
    location,
    depth: zoneDepth(location),
    count: total,
    metricCount: m,
    metricSums,
    own,
    children: { count, rows, items, metricSums: charMetrics },
    blocks,
  };
}

/**
 * summarize for a collection with columns that are not sums: the same
 * counts, rows and ranges; the columns combined by kind, in cell order (the
 * records at the zone, then the children by geometric digit, the rows of one
 * child by the geometric digits of their keys).
 */
function summarizeTyped(space, kinds, location, handles, rowsBlocks) {
  const depth = zoneDepth(location);
  let m = 0;
  const kept = [];
  for (let i = 0; i < rowsBlocks.length; i++) {
    const block = rowsBlocks[i];
    if (zoneName(block.parent) !== location || block.n === 0) continue;
    kept.push(i);
    m = Math.max(m, block.metricCount);
  }
  const K = kindsOf(kinds, m);
  const ordered = hasOrdered(K);
  const count = new Float64Array(CHARS);
  const rows = new Uint32Array(CHARS);
  const items = new Uint32Array(CHARS);
  const charMetrics = new Float64Array(CHARS * m);
  const own = { count: 0, metricSums: new Float64Array(m), rows: 0 };
  resetColumns(own.metricSums, 0, K);
  const perDigit = Array.from({ length: CHARS }, () => []);
  const blocks = [];
  const column = (block, row) => (k) => (k < block.metricCount ? block.metrics[k * block.n + row] : 0);
  for (const i of kept) {
    const block = rowsBlocks[i];
    const { n, keyWords, keys, metricCount } = block;
    if (block.suffixChars === 0) {
      for (let row = 0; row < n; row++) {
        combineColumns(own.metricSums, 0, own.rows, column(block, row), K);
        own.count += block.count[row];
        own.rows++;
      }
      continue;
    }
    const ranges = new Uint32Array(2 * CHARS);
    const deep = block.suffixChars > 1;
    for (let row = 0; row < n; row++) {
      const r = keys[row * keyWords] >>> (32 - BITS_PER_CHAR);
      if (ranges[2 * r + 1] === 0) ranges[2 * r] = row;
      else if (ranges[2 * r + 1] !== row) throw new Error("walk: rows block is not sorted by key");
      ranges[2 * r + 1] = row + 1;
      count[r] += block.count[row];
      rows[r]++;
      if (deep) items[r]++;
      perDigit[r].push({ block, row, key: ordered ? geometricKey(space, depth, suffixAt(block, row)) : null });
    }
    blocks.push({ handle: handles[i], n, suffixChars: block.suffixChars, metricCount, ranges });
  }
  for (let r = 0; r < CHARS; r++) {
    const list = perDigit[r];
    if (ordered) list.sort((a, b) => compareKeys(a.key, b.key));
    resetColumns(charMetrics, r * m, K);
    list.forEach((e, done) => combineColumns(charMetrics, r * m, done, column(e.block, e.row), K));
  }
  const metricSums = Float64Array.from(own.metricSums);
  let total = own.count;
  let seen = own.rows;
  for (const r of digitsInCellOrder(space, depth)) {
    if (rows[r] === 0) continue;
    combineColumns(metricSums, 0, seen, (k) => charMetrics[r * m + k], K);
    total += count[r];
    seen += rows[r];
  }
  return {
    location,
    depth,
    count: total,
    metricCount: m,
    metricSums,
    kinds: K,
    own: { count: own.count, metricSums: own.metricSums },
    children: { count, rows, items, metricSums: charMetrics },
    blocks,
  };
}

/** Geometric digits of a key's characters below a zone of this depth. */
function geometricKey(space, depth, suffix) {
  const out = new Array(suffix.length);
  for (let i = 0; i < suffix.length; i++) out[i] = geometricDigit(space, depth + i, ROUTING_ALPHABET.indexOf(suffix[i]));
  return out;
}

function compareKeys(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** The 64 routing digits of a level, sorted by geometric digit. */
function digitsInCellOrder(space, level) {
  const out = Array.from({ length: CHARS }, (_, r) => r);
  return out.sort((a, b) => geometricDigit(space, level, a) - geometricDigit(space, level, b));
}

/**
 * The binary levels inside one character below `summary`: level j groups the
 * first j·size geometric bits of the digit (j = 0 is the zone, j = step the
 * characters). Built once per summary, from its 64 digit sums only.
 */
export function zoneLevels(space, summary) {
  if (summary.levels) return summary.levels;
  const size = space.size;
  const step = space.step;
  const m = summary.metricCount;
  const digit = new Uint8Array(CHARS);
  const levels = [];
  for (let j = 0; j <= step; j++) {
    const bins = 1 << (j * size);
    levels.push({
      count: new Float64Array(bins),
      rows: new Uint32Array(bins),
      metricSums: new Float64Array(bins * m),
      children: new Uint8Array(bins),
    });
  }
  const { count, rows, metricSums } = summary.children;
  const K = summary.kinds;
  for (let r = 0; r < CHARS; r++) digit[r] = geometricDigit(space, summary.depth, r);
  if (K) {
    // Typed columns: each bin starts at the identity and takes its digits in
    // geometric order, which is cell order inside the bin.
    for (const level of levels) for (let p = 0; p < level.rows.length; p++) resetColumns(level.metricSums, p * m, K);
  }
  const order = K ? digitsInCellOrder(space, summary.depth) : null;
  for (let i = 0; i < CHARS; i++) {
    const r = order ? order[i] : i;
    if (rows[r] === 0) continue;
    for (let j = 0; j <= step; j++) {
      const level = levels[j];
      const p = digit[r] >> (BITS_PER_CHAR - j * size);
      if (K) combineColumns(level.metricSums, p * m, level.rows[p], (k) => metricSums[r * m + k], K);
      else for (let k = 0; k < m; k++) level.metricSums[p * m + k] += metricSums[r * m + k];
      level.count[p] += count[r];
      level.rows[p] += rows[r];
    }
  }
  for (let j = 0; j < step; j++) {
    const next = levels[j + 1].rows;
    for (let p = 0; p < next.length; p++) {
      if (next[p] > 0) levels[j].children[p >> size]++;
    }
  }
  levels.digit = digit;
  summary.levels = levels;
  return levels;
}
