// CPU reference of the pack kernel (docs/heat-pipeline.md §c): from a PLAN
// and the blocks it names to the 14-float instances the renderer reads
// (gpu/draw.js), laid out as the former v1 pack
// wrote them. Slow on purpose: strings per row, Space objects per cell. Tests,
// the perf suite and the GPU check compare the kernel with it.
import { ROOT, ROUTING_ALPHABET, BITS_PER_CHAR } from "../tree/index.js";
import { suffixAt } from "../wire/block.js";
import { geometricDigit, refineXyz, zoneDepth, zoneName } from "./zones.js";
import {
  ENTRY_WORDS,
  FLAG_ENTER,
  FLAG_LEAVE,
  FLAG_NUDGE,
  FLAG_VIRTUAL,
  FLOATS_PER_INSTANCE,
} from "./pack.js";

// Metric centroids are sums of offset coordinates, scaled by metricScale
// when a collection stores them as integers (gpu/pack.js SCALED_DETECTION_THRESHOLD).
const SCALED_DETECTION_THRESHOLD = 10_000;

/** Bin of a row: its suffix prefix down to `bits` geometric bits below the block parent. */
function binKey(space, depth, suffix, bits) {
  const full = Math.floor(bits / BITS_PER_CHAR);
  const rest = bits % BITS_PER_CHAR;
  if (suffix.length < full + (rest ? 1 : 0))
    throw new RangeError("walk: a row is shorter than its bin");
  if (!rest) return suffix.slice(0, full);
  const digit = geometricDigit(space, depth + full, ROUTING_ALPHABET.indexOf(suffix[full]));
  return `${suffix.slice(0, full)}:${digit >> (BITS_PER_CHAR - rest)}`;
}

/** Geometric bits [BITS_PER_CHAR, bits) of a suffix, as one number (virtual bins). */
function virtualBin(space, depth, suffix, bits) {
  let value = 0;
  for (let bit = BITS_PER_CHAR; bit < bits; bit += BITS_PER_CHAR) {
    const take = Math.min(BITS_PER_CHAR, bits - bit);
    const c = bit / BITS_PER_CHAR;
    const digit = geometricDigit(space, depth + c, ROUTING_ALPHABET.indexOf(suffix[c]));
    value = value * (1 << take) + (digit >> (BITS_PER_CHAR - take));
  }
  return value;
}

function binXyz(space, zone, depth, suffix, bits) {
  const full = Math.floor(bits / BITS_PER_CHAR);
  const location = (zone === ROOT ? "" : zone) + suffix.slice(0, full);
  const xyz = space.xyz(location || ROOT);
  const rest = bits % BITS_PER_CHAR;
  if (!rest) return xyz;
  const digit = geometricDigit(space, depth + full, ROUTING_ALPHABET.indexOf(suffix[full]));
  return refineXyz(space, xyz, depth + full, digit, rest);
}

function accumulate(target, at, block, row) {
  target[at] += block.count[row];
  for (let k = 0; k < block.metricCount; k++)
    target[at + 1 + k] += block.metrics[k * block.n + row];
}

function boundsCenter(space, xyz) {
  const point = space.center(space.bounds(xyz))[0];
  if (Number.isFinite(point?.latitude)) return [point.latitude, point.longitude];
  const values = point.value();
  return [values[0], values[1]];
}

/** Display position of a cell: metric centroid, else the center of its bounds. */
function place(position, xyz, sums, at, metricLen) {
  const { mode, latIndex, lngIndex } = position;
  const count = sums[at];
  if (mode !== "bounds" && latIndex < metricLen && lngIndex < metricLen && count > 0) {
    const latSum = sums[at + 1 + latIndex];
    const lngSum = sums[at + 1 + lngIndex];
    const scale = Math.abs(latSum) / count > SCALED_DETECTION_THRESHOLD ? position.metricScale : 1;
    const lat = latSum / (scale * count) - position.latOffset;
    const lng = lngSum / (scale * count) - position.lngOffset;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
  }
  return boundsCenter(position.space, xyz);
}

/** Moves an anchor outside `view` to the center of its cell's intersection with it. */
function nudge(space, xyz, point, view) {
  const [lat, lng] = point;
  if (lat >= view[0] && lat <= view[1] && lng >= view[2] && lng <= view[3]) return point;
  const [s, n, w, e] = space.bounds(xyz)[0].value();
  const south = Math.max(s, view[0]);
  const north = Math.min(n, view[1]);
  const west = Math.max(w, view[2]);
  const east = Math.min(e, view[3]);
  if (!(n > s && e > w) || north <= south || east <= west) return point;
  return [(south + north) * 0.5, (west + east) * 0.5];
}

/**
 * Heat value of a cell: the first rule whose numerator is positive and whose
 * denominator exceeds minDen. `num`/`den` name a metric, or -1 for the count;
 * transform 1 draws log1p(numerator) over 1.
 * @param {Array<{num: number, den: number, minDen: number, transform: number}>} heat
 */
function heatValues(heat, sums, at, metricLen) {
  const read = (index) =>
    index < 0 ? sums[at] : index < metricLen ? sums[at + 1 + index] || 0 : 0;
  for (const rule of heat) {
    const num = read(rule.num);
    const den = read(rule.den);
    if (!(num > 0 && den > rule.minDen)) continue;
    return rule.transform === 1 ? [Math.log1p(num), 1] : [num - (rule.shift ?? 0) * den, den];
  }
  return [0, 0];
}

/**
 * @param {object} plan walkViewport result
 * @param {{ get(handle: number): import("../wire/block.js").RowsBlock }} store
 * @param {Array<{num: number, den: number, minDen: number, transform: number}>} heat
 * @param {{ space, mode: "bounds"|"metrics", latIndex: number, lngIndex: number,
 *   metricScale: number, latOffset: number, lngOffset: number }} position
 * @returns {{ data: Float32Array, count: number }} `count` = plan.capacity;
 *   outputs no row reached (unused virtual bins) stay all zero
 */
export function planToInstancesCPU(plan, store, heat, position) {
  const space = position.space;
  const { entries, capacity, parents, anchors, anchorStride } = plan;
  const stride = 1 + plan.metricCount;
  const sums = new Float64Array(capacity * stride);
  const cells = new Array(capacity);
  const slots = new Int32Array(entries.buffer, entries.byteOffset, entries.length);
  const entryParents = new Map();
  for (let at = 0; at < entries.length; at += ENTRY_WORDS) {
    const block = store.get(entries[at]);
    if (!block) throw new Error(`walk: block ${entries[at]} is not in the store`);
    const first = entries[at + 1];
    const res = entries[at + 4];
    const flags = entries[at + 5];
    const zone = zoneName(block.parent);
    const depth = zoneDepth(zone);
    const bits = (res - depth * space.step) * space.size;
    const virtual = (flags & FLAG_VIRTUAL) !== 0;
    let single = null;
    for (let row = first; row < first + entries[at + 2]; row++) {
      const suffix = suffixAt(block, row);
      let bin = 0;
      if (virtual) {
        if (suffix.length * BITS_PER_CHAR < bits)
          throw new RangeError("walk: a row is shorter than its bin");
        bin = virtualBin(space, depth, suffix, bits);
        if (bin >= entries[at + 7]) throw new RangeError("walk: a bin beyond the entry's capacity");
      } else {
        const key = binKey(space, depth, suffix, bits);
        if (single !== null && key !== single)
          throw new RangeError("walk: an entry spans two bins");
        single = key;
      }
      const out = entries[at + 6] + bin;
      const cell = (cells[out] ??= {
        zone,
        depth,
        suffix,
        bits,
        res,
        slot: slots[at + 3],
        flags,
        metricLen: 0,
        parent: null,
      });
      cell.metricLen = Math.max(cell.metricLen, block.metricCount);
      accumulate(sums, out * stride, block, row);
      if (virtual) {
        const id = `${at}|${bin >> space.size}`;
        let up = entryParents.get(id);
        if (!up) entryParents.set(id, (up = { sums: new Float64Array(stride), metricLen: 0 }));
        up.metricLen = Math.max(up.metricLen, block.metricCount);
        accumulate(up.sums, 0, block, row);
        cell.parent = up;
      }
    }
  }

  const data = new Float32Array(capacity * FLOATS_PER_INSTANCE);
  for (let out = 0; out < capacity; out++) {
    const cell = cells[out];
    if (!cell) continue;
    const xyz = binXyz(space, cell.zone, cell.depth, cell.suffix, cell.bits);
    const at = out * stride;
    let point = place(position, xyz, sums, at, cell.metricLen);
    let anchor = point;
    let upXyz = xyz;
    if (cell.parent || parents[out] >= 0) {
      upXyz = binXyz(space, cell.zone, cell.depth, cell.suffix, cell.bits - space.size);
      if (cell.parent) {
        anchor = place(position, upXyz, cell.parent.sums, 0, cell.parent.metricLen);
      } else {
        // Anchor rows: count, metric length, metrics.
        const row = parents[out] * anchorStride;
        const upSums = new Float64Array(stride);
        upSums[0] = anchors[row];
        for (let k = 0; k < anchors[row + 1]; k++) upSums[1 + k] = anchors[row + 2 + k];
        anchor = place(position, upXyz, upSums, 0, anchors[row + 1]);
      }
    }
    if (cell.flags & FLAG_NUDGE && plan.strictView) {
      point = nudge(space, xyz, point, plan.strictView);
      anchor = nudge(space, upXyz, anchor, plan.strictView);
    }
    const [n, d] = heatValues(heat, sums, at, cell.metricLen);
    const off = out * FLOATS_PER_INSTANCE;
    data[off] = data[off + 4] = point[0];
    data[off + 1] = data[off + 5] = point[1];
    data[off + 2] = data[off + 6] = anchor[0];
    data[off + 3] = data[off + 7] = anchor[1];
    data[off + 8] = data[off + 12] = n;
    data[off + 9] = data[off + 13] = d;
    data[off + 10] = cell.res;
    data[off + 11] = cell.slot;
  }
  return { data, count: capacity };
}

/**
 * The pair the renderer blends during a transition, as writeSnapshotPair
 * (walk/snapshot.testkit.mjs, the v1 CPU pair) writes it: the current target
 * with its previous values cleared, then the previous target as previous-only instances.
 * Subdivision and merge markers follow the per-zone flags of planMotion
 * instead of v1's per-cell geometry.
 * @param {object} plan current plan, after planMotion
 * @param {Float32Array} current planToInstancesCPU(plan, ...).data
 * @param {object} previousPlan previous plan, after planMotion
 * @param {Float32Array} previous its target
 * @param {{previousDepth: number, currentDepth: number}} motion planMotion's result
 * @returns {{ data: Float32Array, count: number }}
 */
export function transitionToInstancesCPU(plan, current, previousPlan, previous, motion) {
  const data = new Float32Array(current.length + previous.length);
  data.set(current);
  for (let off = 0; off < current.length; off += FLOATS_PER_INSTANCE) {
    data[off + 12] = 0;
    data[off + 13] = 0;
  }
  forEachOutput(plan.entries, FLAG_ENTER, (out, res) => {
    const off = out * FLOATS_PER_INSTANCE;
    if (!(data[off + 9] > 0)) return;
    data[off + 12] = res;
    data[off + 13] = -1;
  });
  for (let from = 0; from < previous.length; from += FLOATS_PER_INSTANCE) {
    const off = current.length + from;
    data.set(previous.subarray(from, from + 4), off);
    data.set(previous.subarray(from, from + 4), off + 4);
    data[off + 10] = previous[from + 10];
    data[off + 11] = previous[from + 11];
    data[off + 12] = previous[from + 8];
    data[off + 13] = previous[from + 9];
  }
  forEachOutput(previousPlan.entries, FLAG_LEAVE, (out) => {
    const off = current.length + out * FLOATS_PER_INSTANCE;
    if (!(data[off + 13] > 0)) return;
    data[off + 8] = -motion.previousDepth;
    data[off + 9] = -motion.currentDepth;
  });
  return { data, count: data.length / FLOATS_PER_INSTANCE };
}

function forEachOutput(entries, flag, run) {
  for (let at = 0; at < entries.length; at += ENTRY_WORDS) {
    if (!(entries[at + 5] & flag)) continue;
    for (let b = 0; b < entries[at + 7]; b++) run(entries[at + 6] + b, entries[at + 4]);
  }
}
