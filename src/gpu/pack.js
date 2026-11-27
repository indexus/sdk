// Pack kernel: a walk plan and the blocks resident in the arena -> the
// renderer's instance buffer, entirely on the GPU (docs/heat-pipeline.md
// §c). Nothing is read back; readBackInstancesForCheck is for tests and the
// browser check only. The reference is walk/pack.testkit.mjs (planToInstancesCPU),
// which matches the frozen v1 output (walk/reference.test.mjs);
// gpu/pack.testkit.mjs runs this kernel's entry points in JS.
//
// The plan names, per output (one instance), the rows that make it:
// - a plain output is one cell; its entries (contiguous in the plan) are the
//   runs of its rows, in one or several blocks, and add up;
// - a FLAG_VIRTUAL entry owns 2^(bits-6) outputs: the rows of one character,
//   binned by the geometric bits that follow it. Rows are sorted by routing
//   digit and a geometric digit is the routing digit minus the level's
//   offset, mod 64: a range of geometric digits is one or two ranges of
//   routing digits. So the rows of a bin are at most two runs, found by
//   binary search, never a scatter.
// One workgroup of 64 lanes per output sums count and the metrics the rules
// need over its runs (strided sums, then a tree: no float atomics) and lane 0
// writes the 14 floats. The parent anchor comes from the plan's anchors
// (zone summaries), or for a virtual bin from its enclosing bin, reduced once
// per sibling group by a first pass.
//
// Transitions reproduce writeSnapshotPair (walk/snapshot.testkit.mjs, the
// v1 CPU pair), whose output for a current target C (n instances) and a
// previous target P is
//   [0, n):     C, with previousValues [12..13] = 0
//               (or, entering by subdivision, [12] = resolution, [13] = -1)
//   [n, n+m):   P, with previousLatLng [4..7] = its [0..3],
//               previousValues [12..13] = its values [8..9], values [8..9] = 0
//               (or, leaving by a merge, [8] = -previousDepth, [9] = -currentDepth)
// A target alone has [4..7] = [0..3] and [12..13] = [8..9]. The markers come
// from the per-zone FLAG_ENTER / FLAG_LEAVE that walk's planMotion sets
// (decision 4) instead of matching cell geometry. The previous target is
// copied (copyBufferToBuffer) before the pack overwrites it, then a shift
// kernel writes it as the previous half: it only reads [0..3] and [8..11],
// which a transition leaves untouched, so the current half of the last
// output is always a valid previous target.
import { bufferUsage, compileShader } from "./device.js";
import { suffixWGSL } from "./wgsl/suffix.js";
import {
  FIELD_MAX_RESOLUTION,
  FIELD_ROW_WORDS,
  fieldLayout,
  indexDispatch,
  indexShader,
} from "./field.js";

import {
  ENTRY_WORDS,
  FLAG_ENTER,
  FLAG_LEAVE,
  FLAG_NUDGE,
  FLAG_VIRTUAL,
  FLOATS_PER_INSTANCE as INSTANCE_FLOATS,
} from "../walk/pack.js";

// The walk's entry layout and flags (walk/pack.js) are the kernel's input.
export { FLAG_ENTER, FLAG_LEAVE, FLAG_NUDGE, FLAG_VIRTUAL, INSTANCE_FLOATS };
export const PACK_ENTRY_BYTES = ENTRY_WORDS * 4;
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
const POSITION_BOUNDS = 0;
export const POSITION_METRICS = 1;

const TABLE_WORDS = 12;
const ANCHOR_WORDS = 4;
const MAX_RULES = 3;
const ROW_GROUP = 256;
const MAX_GROUPS = 65535;
// A column the reduction skips: unused rule slots, bounds position.
const UNUSED = -2;
// Metric centroids: sums whose mean is above this are integers, scaled by
// metricScale (the v1 rule).
export const SCALED_DETECTION_THRESHOLD = 10000;
export const PACK_UNIFORM_BYTES = 176;

/** Reads entry i of a plan: handle, firstRow, rowCount, slot (i32), targetResolution, flags, outBase, binCapacity. */
export function readEntry(entries, i) {
  const at = i * ENTRY_WORDS;
  return {
    handle: entries[at],
    firstRow: entries[at + 1],
    rowCount: entries[at + 2],
    slot: entries[at + 3] | 0,
    targetResolution: entries[at + 4],
    flags: entries[at + 5],
    outBase: entries[at + 6],
    binCapacity: entries[at + 7],
  };
}

/**
 * Heat rules, as the walk reads them: up to three `{num, den, minDen = 0,
 * transform = 0, shift = 0}`, -1 reads count, j reads metric j (0 when no block
 * of the cell has it). The first rule with num > 0 and den > minDen gives
 * (num - shift·den, den), a value num / den - shift (a positive scale for a
 * quantity such as kelvin), or (log1p(num), 1) with transform 1. No rule: (0,
 * 0), which the renderer drops.
 */
export function normalizeHeat(heat, kinds = null) {
  const rules = Array.isArray(heat) ? heat : [];
  if (rules.length > MAX_RULES) {
    throw new RangeError(`pack: at most ${MAX_RULES} heat rules, got ${rules.length}`);
  }
  return rules.map((rule) => {
    const transform = rule.transform ?? 0;
    if (transform !== 0 && transform !== 1) {
      throw new RangeError(`pack: unknown heat transform ${transform}`);
    }
    const num = rule.num ?? -1;
    const den = rule.den ?? -1;
    for (const column of [num, den]) {
      if (!Number.isInteger(column) || column < -1) {
        throw new RangeError(`pack: heat column ${column} is neither -1 (count) nor a metric`);
      }
    }
    // The heat adds the rows of an output (one workgroup per output): only a
    // sum column adds up. Other kinds are read from zone values instead.
    for (const column of [num, den]) {
      const kind = column >= 0 && Array.isArray(kinds) ? (kinds[column] ?? "sum") : "sum";
      if (kind !== "sum") {
        throw new RangeError(`pack: heat column ${column} is a ${kind} column; the heat adds rows, so it reads sums only`);
      }
    }
    const shift = rule.shift ?? 0;
    if (!Number.isFinite(shift) || (shift !== 0 && transform !== 0)) {
      throw new RangeError(`pack: a heat shift needs a finite number and transform 0`);
    }
    return { num, den, minDen: rule.minDen ?? 0, transform, shift };
  });
}

/**
 * Position of an instance and of its parent anchor:
 * `{mode: "bounds" | "metrics", latIndex, lngIndex, metricScale = 1,
 * latOffset = 0, lngOffset = 0}`. Bounds: centre of the cell. Metrics:
 * lat = latSum / (scale·count) - latOffset, falling
 * back to the centre when the cell's blocks lack those metrics.
 */
export function normalizePosition(position = {}) {
  const mode = position.mode === "metrics" ? POSITION_METRICS : POSITION_BOUNDS;
  const latIndex = position.latIndex ?? -1;
  const lngIndex = position.lngIndex ?? -1;
  if (
    mode === POSITION_METRICS &&
    !(Number.isInteger(latIndex) && latIndex >= 0 && Number.isInteger(lngIndex) && lngIndex >= 0)
  ) {
    throw new RangeError("pack: metrics position needs latIndex and lngIndex");
  }
  return {
    mode,
    latIndex: mode === POSITION_METRICS ? latIndex : UNUSED,
    lngIndex: mode === POSITION_METRICS ? lngIndex : UNUSED,
    metricScale: position.metricScale ?? 1,
    latOffset: position.latOffset ?? 0,
    lngOffset: position.lngOffset ?? 0,
  };
}

/**
 * Checks a walk plan against the arena and lays out everything a pack needs:
 * uniform bytes, the plan buffer (tables, entries, per-output entry ranges,
 * parents, anchors, leave entries) and dispatch sizes. Shared by encode and
 * by the float32 emulation, so both run on the same bytes.
 *
 * @param job.info        (handle) => {n, depth, suffixChars} or null
 * @param job.tables      spaceTables(space) of gpu/cells.js
 * @param job.plan        walkViewport(...) result
 * @param job.transition  null, or {previousCount, previousEntries, previousDepth, currentDepth}
 * @param job.field       null, or {cellOf}: the pack also writes a field (gpu/field.js);
 *   cellOf(handle) gives the coordinates of the block's parent zone (space.xyz)
 */
export function preparePack({
  info,
  tables,
  plan,
  heat,
  position,
  transition = null,
  field = null,
}) {
  const rules = normalizeHeat(heat, plan.kinds);
  const place = normalizePosition(position);
  const { entries, capacity, parents, anchors, anchorStride, step } = plan;
  const size = tables.coordinates;
  const entryCount = entries.length / ENTRY_WORDS;
  const anchorCount = anchorStride > 0 ? anchors.length / anchorStride : 0;
  if (!Number.isInteger(entryCount) || parents.length !== capacity || step * size !== 6) {
    throw new RangeError("pack: not a walk plan for this Space");
  }

  // Per output: its first entry and how many follow (virtual bins: their one entry).
  const outputs = new Uint32Array(2 * capacity);
  let virtualEntries = 0;
  let coarsest = FIELD_MAX_RESOLUTION;
  for (let e = 0; e < entryCount; e++) {
    const entry = readEntry(entries, e);
    const block = info(entry.handle);
    if (!block) {
      throw new RangeError(
        `pack: entry ${e} reads handle ${entry.handle}, which is not in the arena`,
      );
    }
    if (entry.rowCount === 0 || entry.firstRow + entry.rowCount > block.n) {
      throw new RangeError(
        `pack: entry ${e} reads rows ${entry.firstRow}+${entry.rowCount} of ${block.n}`,
      );
    }
    const bits = (entry.targetResolution - block.depth * step) * size;
    if (bits < 0 || bits > 6 * block.suffixChars) {
      throw new RangeError(
        `pack: entry ${e} targets resolution ${entry.targetResolution}, outside its block`,
      );
    }
    if (field && entry.targetResolution > FIELD_MAX_RESOLUTION) {
      throw new RangeError(
        `pack: a field holds resolutions up to ${FIELD_MAX_RESOLUTION}, entry ${e} has ${entry.targetResolution}`,
      );
    }
    coarsest = Math.min(coarsest, entry.targetResolution);
    if (entry.outBase + entry.binCapacity > capacity) {
      throw new RangeError(`pack: entry ${e} writes beyond the plan's capacity ${capacity}`);
    }
    if (entry.flags & FLAG_VIRTUAL) {
      if (bits < 6 + size || bits > 36 || entry.binCapacity !== 2 ** (bits - 6)) {
        throw new RangeError(
          `pack: virtual entry ${e} has ${entry.binCapacity} bins for ${bits} bits`,
        );
      }
      for (let b = 0; b < entry.binCapacity; b++) {
        if (outputs[2 * (entry.outBase + b) + 1] !== 0) {
          throw new RangeError(`pack: virtual entry ${e} shares an output`);
        }
        outputs.set([e, 1], 2 * (entry.outBase + b));
      }
      virtualEntries++;
      continue;
    }
    const out = entry.outBase;
    const anchor = parents[out];
    if (entry.binCapacity !== 1 || anchor >= anchorCount || (anchor >= 0 && bits < size)) {
      throw new RangeError(`pack: entry ${e} is not one anchored cell`);
    }
    if (outputs[2 * out + 1] === 0) {
      outputs[2 * out] = e;
    } else if (
      outputs[2 * out] + outputs[2 * out + 1] !== e ||
      readEntry(entries, e - 1).flags & FLAG_VIRTUAL
    ) {
      throw new RangeError(`pack: the entries of output ${out} are not contiguous`);
    }
    outputs[2 * out + 1]++;
  }

  const leave = transition?.previousEntries ?? new Uint32Array(0);
  const leaveEntryCount = leave.length / ENTRY_WORDS;
  const leaveSlotStart = new Uint32Array(leaveEntryCount + 1);
  for (let e = 0; e < leaveEntryCount; e++) {
    leaveSlotStart[e + 1] = leaveSlotStart[e] + readEntry(leave, e).binCapacity;
  }
  const leaveSlotCount = leaveSlotStart[leaveEntryCount];
  const previousCount = transition ? transition.previousCount : 0;

  // plan buffer = [mask | offset | entries | outputs | parents | anchors | leave | leaveSlotStart
  //                | zone cells (3 per entry, with a field)]
  const entriesAt = tables.mask.length + tables.offset.length;
  const outputsAt = entriesAt + entries.length;
  const parentsAt = outputsAt + outputs.length;
  const anchorsAt = parentsAt + capacity;
  const leaveAt = anchorsAt + anchorCount * ANCHOR_WORDS;
  const leaveSlotStartAt = leaveAt + leave.length;
  const zoneCellsAt = leaveSlotStartAt + leaveEntryCount + 1;
  const words = new Uint32Array(zoneCellsAt + (field ? 3 * entryCount : 0));
  const floats = new Float32Array(words.buffer);
  words.set(tables.mask, 0);
  words.set(tables.offset, tables.mask.length);
  words.set(entries, entriesAt);
  words.set(outputs, outputsAt);
  new Int32Array(words.buffer, parentsAt * 4, capacity).set(parents);
  // Anchor rows for the kernel: count, has lat/lng, lat sum, lng sum.
  for (let a = 0; a < anchorCount; a++) {
    const row = a * anchorStride;
    const length = anchors[row + 1];
    const located =
      place.mode === POSITION_METRICS && place.latIndex < length && place.lngIndex < length;
    const at = anchorsAt + a * ANCHOR_WORDS;
    floats[at] = anchors[row];
    floats[at + 1] = located ? 1 : 0;
    floats[at + 2] = located ? anchors[row + 2 + place.latIndex] : 0;
    floats[at + 3] = located ? anchors[row + 2 + place.lngIndex] : 0;
  }
  words.set(leave, leaveAt);
  words.set(leaveSlotStart, leaveSlotStartAt);
  const layout = field && fieldLayout(capacity);
  if (field) {
    const cells = new Map();
    for (let e = 0; e < entryCount; e++) {
      const { handle } = readEntry(entries, e);
      if (!cells.has(handle)) cells.set(handle, field.cellOf(handle));
      words.set(cells.get(handle), zoneCellsAt + 3 * e);
    }
  }

  const uniform = new ArrayBuffer(PACK_UNIFORM_BYTES);
  const f32 = new Float32Array(uniform);
  const u32 = new Uint32Array(uniform);
  const i32 = new Int32Array(uniform);
  for (let r = 0; r < MAX_RULES; r++) {
    const rule = rules[r];
    i32[4 * r] = rule ? rule.num : UNUSED;
    i32[4 * r + 1] = rule ? rule.den : UNUSED;
    f32[4 * r + 2] = rule ? rule.minDen : 0;
    u32[4 * r + 3] = rule ? rule.transform : 0;
  }
  f32.set(viewRect(plan.strictView), 12);
  u32[16] = rules.length;
  u32[17] = place.mode;
  i32[18] = place.latIndex;
  i32[19] = place.lngIndex;
  f32[20] = place.metricScale;
  f32[21] = place.latOffset;
  f32[22] = place.lngOffset;
  u32[23] = tables.maxLevels;
  u32.set([step, size, capacity, entriesAt], 24);
  u32.set([outputsAt, parentsAt, anchorsAt, leaveAt], 28);
  u32.set([leaveSlotStartAt, leaveEntryCount, leaveSlotCount, transition ? 1 : 0], 32);
  f32[36] = transition?.previousDepth ?? 0;
  f32[37] = transition?.currentDepth ?? 0;
  u32[38] = previousCount;
  u32[39] = layout ? layout.rowsAt : 0;
  u32[40] = zoneCellsAt;
  for (let r = 0; r < MAX_RULES; r++) f32[41 + r] = rules[r]?.shift ?? 0;

  return {
    uniform,
    plan: words,
    workWords: 3 * capacity,
    capacity,
    previousCount,
    leaveSlotCount,
    // Enclosing bins are only read for metric positions of virtual bins.
    virtualParents: virtualEntries > 0 && place.mode === POSITION_METRICS,
    field: layout && {
      ...layout,
      header: Uint32Array.of(layout.tableSize, capacity, entryCount > 0 ? coarsest : 0, 0),
    },
  };
}

// [south, north, west, east]; an empty rect disables the anchor nudge.
function viewRect(view) {
  if (!view) {
    return [0, 0, 0, 0];
  }
  const [south, north, west, east] = view;
  if (![south, north, west, east].every(Number.isFinite) || north <= south || east <= west) {
    return [0, 0, 0, 0];
  }
  return [south, north, west, east];
}

export const packShader = /* wgsl */ `
struct Rule {
  num: i32,
  den: i32,
  minDen: f32,
  transform: u32,
}

struct Params {
  rules: array<Rule, 3>,
  view: vec4f,
  ruleCount: u32,
  positionMode: u32,
  latIndex: i32,
  lngIndex: i32,
  metricScale: f32,
  latOffset: f32,
  lngOffset: f32,
  maxLevels: u32,
  step: u32,
  size: u32,
  capacity: u32,
  entriesAt: u32,
  outputsAt: u32,
  parentsAt: u32,
  anchorsAt: u32,
  leaveAt: u32,
  leaveSlotStartAt: u32,
  leaveEntryCount: u32,
  leaveSlotCount: u32,
  transition: u32,
  previousDepth: f32,
  currentDepth: f32,
  previousCount: u32,
  fieldRows: u32,
  zoneCellsAt: u32,
  // Heat shift of each rule (scalars: a uniform array would need a 16-byte stride).
  shift0: f32,
  shift1: f32,
  shift2: f32,
}

struct Entry {
  blockHandle: u32,
  firstRow: u32,
  rowCount: u32,
  slot: i32,
  resolution: u32,
  flags: u32,
  outBase: u32,
  binCapacity: u32,
}

struct Block {
  keysOff: u32,
  countOff: u32,
  metricsOff: u32,
  n: u32,
  keyWords: u32,
  suffixChars: u32,
  metricCount: u32,
  depth: u32,
  origin: vec4f,
}

// Two runs of rows of one block: [a.x, a.y) then [b.x, b.y).
struct Runs {
  a: vec2u,
  b: vec2u,
}

// One output: its first entry and block, the geometric bits of its cell
// below the block's parent and, for a virtual bin, its bin and its rows.
struct Cell {
  entryCount: u32,
  firstEntry: u32,
  entry: Entry,
  blk: Block,
  bits: u32,
  isVirtual: bool,
  bin: u32,
  runs: Runs,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> plan: array<u32>;
@group(0) @binding(2) var<storage, read> blockTable: array<u32>;
@group(0) @binding(3) var<storage, read> keys: array<u32>;
@group(0) @binding(4) var<storage, read> counts: array<u32>;
@group(0) @binding(5) var<storage, read> metrics: array<f32>;
@group(0) @binding(6) var<storage, read_write> work: array<u32>;
@group(0) @binding(7) var<storage, read_write> instances: array<f32>;
@group(0) @binding(8) var<storage, read> previous: array<f32>;
@group(0) @binding(9) var<storage, read_write> field: array<u32>;

var<workgroup> laneCount: array<u32, 64>;
var<workgroup> laneSums: array<array<f32, 8>, 64>;

${suffixWGSL({ keys: "keys", tables: "plan" })}

fn entryAt(at: u32, e: u32) -> Entry {
  let b = at + e * 8u;
  return Entry(plan[b], plan[b + 1u], plan[b + 2u], bitcast<i32>(plan[b + 3u]), plan[b + 4u], plan[b + 5u],
               plan[b + 6u], plan[b + 7u]);
}

fn blockAt(h: u32) -> Block {
  let b = h * ${TABLE_WORDS}u;
  let origin = vec4f(bitcast<f32>(blockTable[b + 8u]), bitcast<f32>(blockTable[b + 9u]),
                     bitcast<f32>(blockTable[b + 10u]), bitcast<f32>(blockTable[b + 11u]));
  return Block(blockTable[b], blockTable[b + 1u], blockTable[b + 2u], blockTable[b + 3u], blockTable[b + 4u],
               blockTable[b + 5u], blockTable[b + 6u], blockTable[b + 7u], origin);
}

fn keyOf(blk: Block, row: u32) -> u32 {
  return blk.keysOff + row * blk.keyWords;
}

// First row of [start, stop) whose characters 1..k are not below want, in
// routing order. A wanted digit of 64 is above every character.
fn lowerBound(blk: Block, start: u32, stop: u32, want: array<u32, 6>, k: u32) -> u32 {
  var digits = want;
  var lo = start;
  var hi = stop;
  while (lo < hi) {
    let mid = (lo + hi) >> 1u;
    let key = keyOf(blk, mid);
    var under = false;
    for (var i = 0u; i < k; i++) {
      let digit = suffixDigit(key, i + 1u);
      if (digit != digits[i]) {
        under = digit < digits[i];
        break;
      }
    }
    if (under) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// Rows of a virtual entry whose geometric bits [6, bits) are bin. The entry
// holds one first character; below it, the full characters of the bin are
// exact routing digits and its last bits are a range of geometric digits,
// which the level's offset rotates into one or two ranges of routing digits.
fn binRuns(entry: Entry, blk: Block, bits: u32, bin: u32) -> Runs {
  var runs: Runs;
  let start = entry.firstRow;
  let stop = start + entry.rowCount;
  if (bits <= 6u) {
    runs.a = vec2u(start, stop);
    return runs;
  }
  let below = bits - 6u;
  let k = (below + 5u) / 6u;
  let take = below - (k - 1u) * 6u;
  let offsetBase = params.maxLevels * 6u + blk.depth + 1u;
  var want = array<u32, 6>(0u, 0u, 0u, 0u, 0u, 0u);
  for (var i = 0u; i + 1u < k; i++) {
    let exact = (bin >> (below - (i + 1u) * 6u)) & 63u;
    want[i] = (exact + plan[offsetBase + i]) & 63u;
  }
  let width = 1u << (6u - take);
  let low = (bin & ((1u << take) - 1u)) << (6u - take);
  let digit = (low + plan[offsetBase + k - 1u]) & 63u;
  want[k - 1u] = digit;
  let a0 = lowerBound(blk, start, stop, want, k);
  if (digit + width <= 64u) {
    want[k - 1u] = digit + width;
    runs.a = vec2u(a0, lowerBound(blk, a0, stop, want, k));
    return runs;
  }
  want[k - 1u] = 64u;
  runs.a = vec2u(a0, lowerBound(blk, a0, stop, want, k));
  want[k - 1u] = 0u;
  let b0 = lowerBound(blk, start, a0, want, k);
  want[k - 1u] = digit + width - 64u;
  runs.b = vec2u(b0, lowerBound(blk, b0, a0, want, k));
  return runs;
}

fn cellAt(index: u32) -> Cell {
  var cell: Cell;
  cell.firstEntry = plan[params.outputsAt + 2u * index];
  cell.entryCount = plan[params.outputsAt + 2u * index + 1u];
  if (cell.entryCount == 0u) {
    return cell;
  }
  cell.entry = entryAt(params.entriesAt, cell.firstEntry);
  cell.blk = blockAt(cell.entry.blockHandle);
  cell.bits = (cell.entry.resolution - cell.blk.depth * params.step) * params.size;
  cell.isVirtual = (cell.entry.flags & ${FLAG_VIRTUAL}u) != 0u;
  if (cell.isVirtual) {
    cell.bin = index - cell.entry.outBase;
    cell.runs = binRuns(cell.entry, cell.blk, cell.bits, cell.bin);
  }
  return cell;
}

fn outputIndex(group: vec3u) -> u32 {
  return group.y * ${MAX_GROUPS}u + group.x;
}

// Columns 0..5: numerator and denominator of each rule; 6, 7: lat, lng.
fn column(k: u32) -> i32 {
  if (k == 6u) {
    return params.latIndex;
  }
  if (k == 7u) {
    return params.lngIndex;
  }
  let rule = params.rules[k >> 1u];
  if ((k & 1u) == 0u) {
    return rule.num;
  }
  return rule.den;
}

fn metricAt(blk: Block, col: i32, row: u32) -> f32 {
  if (col < 0 || u32(col) >= blk.metricCount) {
    return 0.0;
  }
  return metrics[blk.metricsOff + u32(col) * blk.n + row];
}

// One lane's share of a run: rows span.x + lane, then every 64th; columns
// [head, head + width).
fn addRows(blk: Block, span: vec2u, lane: u32, head: u32, width: u32, count: ptr<function, u32>,
           acc: ptr<function, array<f32, 8>>) {
  for (var r = span.x + lane; r < span.y; r += 64u) {
    *count += counts[blk.countOff + r];
    for (var k = head; k < head + width; k++) {
      (*acc)[k] += metricAt(blk, column(k), r);
    }
  }
}

fn treeReduce(lane: u32) {
  for (var s = 32u; s > 0u; s >>= 1u) {
    if (lane < s) {
      laneCount[lane] += laneCount[lane + s];
      for (var k = 0u; k < 8u; k++) {
        laneSums[lane][k] += laneSums[lane + s][k];
      }
    }
    workgroupBarrier();
  }
}

fn hasMetricPosition(blk: Block) -> bool {
  return params.positionMode == ${POSITION_METRICS}u && u32(params.latIndex) < blk.metricCount &&
         u32(params.lngIndex) < blk.metricCount;
}

// Sums of the enclosing bin of each group of sibling virtual bins, written
// by the first sibling's workgroup at work[3·index].
@compute @workgroup_size(64)
fn reduceParents(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let index = outputIndex(group);
  if (index >= params.capacity) {
    return;
  }
  let cell = cellAt(index);
  let siblings = (1u << params.size) - 1u;
  let lead = cell.entryCount > 0u && cell.isVirtual && (cell.bin & siblings) == 0u && hasMetricPosition(cell.blk);
  var count = 0u;
  var acc = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  if (lead) {
    let runs = binRuns(cell.entry, cell.blk, cell.bits - params.size, cell.bin >> params.size);
    addRows(cell.blk, runs.a, lid.x, 6u, 2u, &count, &acc);
    addRows(cell.blk, runs.b, lid.x, 6u, 2u, &count, &acc);
  }
  laneCount[lid.x] = count;
  laneSums[lid.x] = acc;
  workgroupBarrier();
  treeReduce(lid.x);
  if (lid.x == 0u && lead) {
    work[index * 3u] = laneCount[0];
    work[index * 3u + 1u] = bitcast<u32>(laneSums[0][6]);
    work[index * 3u + 2u] = bitcast<u32>(laneSums[0][7]);
  }
}

struct Place {
  pos: vec2f,
  rect: vec4f,
}

// Centre and bounds (south, north, west, east) of the first bits of row.
fn cellPlace(blk: Block, row: u32, bits: u32) -> Place {
  var box = decodeBits(keyOf(blk, row), bits, blk.depth, params.maxLevels);
  let o = blk.origin;
  let latExtent = o.y - o.x;
  let lngExtent = o.w - o.z;
  var place: Place;
  place.pos = vec2f(o.x + (box.lo[0] + box.size[0] * 0.5) * latExtent,
                    o.z + (box.lo[1] + box.size[1] * 0.5) * lngExtent);
  place.rect = vec4f(o.x + box.lo[0] * latExtent, o.x + (box.lo[0] + box.size[0]) * latExtent,
                     o.z + box.lo[1] * lngExtent, o.z + (box.lo[1] + box.size[1]) * lngExtent);
  return place;
}

fn metricCentroid(count: f32, latSum: f32, lngSum: f32) -> vec2f {
  var scale = 1.0;
  if (abs(latSum) / count > ${SCALED_DETECTION_THRESHOLD}.0) {
    scale = params.metricScale;
  }
  let weight = scale * count;
  return vec2f(latSum / weight - params.latOffset, lngSum / weight - params.lngOffset);
}

// The anchor nudge of the v1 worker: a point outside the view moves to the
// centre of the cell's intersection with the view, when there is one.
fn nudge(pos: vec2f, rect: vec4f) -> vec2f {
  let v = params.view;
  if (v.y <= v.x || v.w <= v.z) {
    return pos;
  }
  if (pos.x >= v.x && pos.x <= v.y && pos.y >= v.z && pos.y <= v.w) {
    return pos;
  }
  let south = max(rect.x, v.x);
  let north = min(rect.y, v.y);
  let west = max(rect.z, v.z);
  let east = min(rect.w, v.w);
  if (north <= south || east <= west) {
    return pos;
  }
  return vec2f((south + north) * 0.5, (west + east) * 0.5);
}

fn ruleShift(r: u32) -> f32 {
  if (r == 0u) {
    return params.shift0;
  }
  if (r == 1u) {
    return params.shift1;
  }
  return params.shift2;
}

fn ruleValue(col: i32, count: f32, value: f32) -> f32 {
  if (col == -1) {
    return count;
  }
  return value;
}

@compute @workgroup_size(64)
fn writeOutputs(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let index = outputIndex(group);
  if (index >= params.capacity) {
    return;
  }
  let cell = cellAt(index);
  var count = 0u;
  var acc = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  var located = false;
  if (cell.isVirtual) {
    addRows(cell.blk, cell.runs.a, lid.x, 0u, 8u, &count, &acc);
    addRows(cell.blk, cell.runs.b, lid.x, 0u, 8u, &count, &acc);
    located = hasMetricPosition(cell.blk);
  } else {
    for (var e = 0u; e < cell.entryCount; e++) {
      let entry = entryAt(params.entriesAt, cell.firstEntry + e);
      let blk = blockAt(entry.blockHandle);
      addRows(blk, vec2u(entry.firstRow, entry.firstRow + entry.rowCount), lid.x, 0u, 8u, &count, &acc);
      located = located || hasMetricPosition(blk);
    }
  }
  laneCount[lid.x] = count;
  laneSums[lid.x] = acc;
  workgroupBarrier();
  treeReduce(lid.x);

  // The first row of the cell gives its geometry; an empty virtual bin has none.
  var row = cell.entry.firstRow;
  var rows = cell.entryCount;
  if (cell.isVirtual) {
    rows = (cell.runs.a.y - cell.runs.a.x) + (cell.runs.b.y - cell.runs.b.x);
    row = cell.runs.a.x;
    if (cell.runs.a.y == cell.runs.a.x) {
      row = cell.runs.b.x;
    }
  }
  if (lid.x != 0u || rows == 0u) {
    return;
  }

  let total = f32(laneCount[0]);
  var n = 0.0;
  var d = 0.0;
  for (var r = 0u; r < params.ruleCount; r++) {
    let rule = params.rules[r];
    let num = ruleValue(rule.num, total, laneSums[0][2u * r]);
    let den = ruleValue(rule.den, total, laneSums[0][2u * r + 1u]);
    if (num > 0.0 && den > rule.minDen) {
      n = num - ruleShift(r) * den;
      d = den;
      if (rule.transform == 1u) {
        n = log(1.0 + num);
        d = 1.0;
      }
      break;
    }
  }

  let blk = cell.blk;
  // The field row of the output: its Cell and the value of the rules, before
  // any transition marker.
  if (params.fieldRows != 0u) {
    let zone = params.zoneCellsAt + cell.firstEntry * 3u;
    let key = decodeCell(keyOf(blk, row), cell.bits, blk.depth, params.maxLevels,
                         vec3u(plan[zone], plan[zone + 1u], plan[zone + 2u]));
    let at = params.fieldRows + index * ${FIELD_ROW_WORDS}u;
    field[at] = key.x;
    field[at + 1u] = key.y;
    field[at + 2u] = key.z;
    field[at + 3u] = cell.entry.resolution + 1u;
    field[at + 4u] = bitcast<u32>(n);
    field[at + 5u] = bitcast<u32>(d);
  }
  let own = cellPlace(blk, row, cell.bits);
  var pos = own.pos;
  if (located && total > 0.0) {
    pos = metricCentroid(total, laneSums[0][6], laneSums[0][7]);
  }
  var parent = pos;
  var parentRect = own.rect;
  let anchor = bitcast<i32>(plan[params.parentsAt + index]);
  if (cell.isVirtual || anchor >= 0) {
    let above = cellPlace(blk, row, cell.bits - params.size);
    parent = above.pos;
    parentRect = above.rect;
    if (cell.isVirtual) {
      let at = (index - (cell.bin & ((1u << params.size) - 1u))) * 3u;
      let parentCount = f32(work[at]);
      if (located && parentCount > 0.0) {
        parent = metricCentroid(parentCount, bitcast<f32>(work[at + 1u]), bitcast<f32>(work[at + 2u]));
      }
    } else {
      let at = params.anchorsAt + u32(anchor) * ${ANCHOR_WORDS}u;
      let parentCount = bitcast<f32>(plan[at]);
      if (bitcast<f32>(plan[at + 1u]) > 0.0 && parentCount > 0.0) {
        parent = metricCentroid(parentCount, bitcast<f32>(plan[at + 2u]), bitcast<f32>(plan[at + 3u]));
      }
    }
  }
  if ((cell.entry.flags & ${FLAG_NUDGE}u) != 0u) {
    pos = nudge(pos, own.rect);
    parent = nudge(parent, parentRect);
  }

  let resolution = f32(cell.entry.resolution);
  var previousN = n;
  var previousD = d;
  if (params.transition == 1u) {
    previousN = 0.0;
    previousD = 0.0;
    if ((cell.entry.flags & ${FLAG_ENTER}u) != 0u && d > 0.0) {
      previousN = resolution;
      previousD = -1.0;
    }
  }
  let o = index * ${INSTANCE_FLOATS}u;
  instances[o] = pos.x;
  instances[o + 1u] = pos.y;
  instances[o + 2u] = parent.x;
  instances[o + 3u] = parent.y;
  instances[o + 4u] = pos.x;
  instances[o + 5u] = pos.y;
  instances[o + 6u] = parent.x;
  instances[o + 7u] = parent.y;
  instances[o + 8u] = n;
  instances[o + 9u] = d;
  instances[o + 10u] = resolution;
  instances[o + 11u] = f32(cell.entry.slot);
  instances[o + 12u] = previousN;
  instances[o + 13u] = previousD;
}

@compute @workgroup_size(256)
fn shiftPrevious(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.previousCount) {
    return;
  }
  let src = i * ${INSTANCE_FLOATS}u;
  let dst = (params.capacity + i) * ${INSTANCE_FLOATS}u;
  for (var k = 0u; k < 4u; k++) {
    instances[dst + k] = previous[src + k];
    instances[dst + 4u + k] = previous[src + k];
  }
  instances[dst + 8u] = 0.0;
  instances[dst + 9u] = 0.0;
  instances[dst + 10u] = previous[src + 10u];
  instances[dst + 11u] = previous[src + 11u];
  instances[dst + 12u] = previous[src + 8u];
  instances[dst + 13u] = previous[src + 9u];
}

// Largest e in [0, count) with plan[at + e] <= x: the entry owning slot x.
fn findEntry(at: u32, count: u32, x: u32) -> u32 {
  var lo = 0u;
  var hi = count - 1u;
  while (lo < hi) {
    let mid = (lo + hi + 1u) >> 1u;
    if (plan[at + mid] <= x) {
      lo = mid;
    } else {
      hi = mid - 1u;
    }
  }
  return lo;
}

// Merge markers on the previous half, for the outputs of the FLAG_LEAVE
// entries of the previous plan.
@compute @workgroup_size(256)
fn markLeave(@builtin(global_invocation_id) gid: vec3u) {
  let w = gid.x;
  if (w >= params.leaveSlotCount) {
    return;
  }
  let e = findEntry(params.leaveSlotStartAt, params.leaveEntryCount, w);
  let entry = entryAt(params.leaveAt, e);
  if ((entry.flags & ${FLAG_LEAVE}u) == 0u) {
    return;
  }
  let slot = entry.outBase + (w - plan[params.leaveSlotStartAt + e]);
  if (slot >= params.previousCount) {
    return;
  }
  let dst = (params.capacity + slot) * ${INSTANCE_FLOATS}u;
  if (instances[dst + 13u] <= 0.0) {
    return;
  }
  instances[dst + 8u] = -params.previousDepth;
  instances[dst + 9u] = -params.currentDepth;
}
`;

// Bindings each entry point uses; layout "auto" drops the others.
export const PACK_STAGES = [
  { entryPoint: "reduceParents", bindings: [0, 1, 2, 3, 4, 5, 6] },
  { entryPoint: "writeOutputs", bindings: [0, 1, 2, 3, 4, 5, 6, 7, 9] },
  { entryPoint: "shiftPrevious", bindings: [0, 7, 8] },
  { entryPoint: "markLeave", bindings: [0, 1, 7] },
];

/**
 * Dispatches of one pack, in order, as [entryPoint, x, y]. Stages with no
 * work are left out.
 */
export function packDispatches(job) {
  const dispatches = [];
  if (job.capacity > 0) {
    const x = Math.min(job.capacity, MAX_GROUPS);
    const y = Math.ceil(job.capacity / MAX_GROUPS);
    if (job.virtualParents) {
      dispatches.push(["reduceParents", x, y]);
    }
    dispatches.push(["writeOutputs", x, y]);
  }
  if (job.previousCount > 0) {
    dispatches.push(["shiftPrevious", Math.ceil(job.previousCount / ROW_GROUP), 1]);
    if (job.leaveSlotCount > 0) {
      dispatches.push(["markLeave", Math.ceil(job.leaveSlotCount / ROW_GROUP), 1]);
    }
  }
  return dispatches;
}

/** Usage of the instance buffer: drawn, packed into, copied for transitions. */
function instanceUsage() {
  return bufferUsage.VERTEX | bufferUsage.STORAGE | bufferUsage.COPY_SRC | bufferUsage.COPY_DST;
}

/** An instance buffer for `instances` instances, with the usage the pack needs. */
export function createInstanceBuffer(device, instances) {
  return device.createBuffer({
    label: "pack-instances",
    size: Math.max(INSTANCE_BYTES, instances * INSTANCE_BYTES),
    usage: instanceUsage(),
  });
}

/**
 * Compiles the pack kernel on `device` (the shared device of gpu/device.js).
 * After a device loss, create a new kernel on the new device.
 * @returns {Promise<{encode: Function, destroy: Function}>}
 */
export async function createPackKernel(device) {
  const module = await compileShader(device, "pack", packShader);
  const pipelines = {};
  await Promise.all(
    PACK_STAGES.map(async ({ entryPoint }) => {
      pipelines[entryPoint] = await device.createComputePipelineAsync({
        label: `pack-${entryPoint}`,
        layout: "auto",
        compute: { module, entryPoint },
      });
    }),
  );
  const bindings = Object.fromEntries(
    PACK_STAGES.map((stage) => [stage.entryPoint, stage.bindings]),
  );
  const indexPipeline = await device.createComputePipelineAsync({
    label: "pack-indexField",
    layout: "auto",
    compute: {
      module: device.createShaderModule({ label: "field-index", code: indexShader }),
      entryPoint: "indexField",
    },
  });

  const uniform = device.createBuffer({
    label: "pack-params",
    size: PACK_UNIFORM_BYTES,
    usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST,
  });
  const owned = { plan: null, work: null, previous: null, field: null };

  // Kernel-owned scratch, grown by doubling, never shrunk.
  function scratch(name, bytes) {
    const current = owned[name];
    if (current && current.size >= bytes) {
      return current;
    }
    current?.destroy();
    const size = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(4, bytes))));
    owned[name] = device.createBuffer({
      label: `pack-${name}`,
      size,
      usage: bufferUsage.STORAGE | bufferUsage.COPY_DST,
    });
    return owned[name];
  }

  /**
   * Encodes one pack into `encoder`. Submit it before the next encode: the
   * uniform and the plan are written with queue.writeBuffer.
   *
   * @param {GPUCommandEncoder} encoder
   * @param {object} request
   * @param request.arena        createArena(...) holding every handle of the plan
   * @param request.tables       spaceTables(space) of gpu/cells.js
   * @param request.plan         walkViewport(...) result (after planMotion for a transition)
   * @param request.heat         rules, see normalizeHeat
   * @param request.position     see normalizePosition
   * @param request.output       instance buffer (createInstanceBuffer)
   * @param request.transition   null for a steady target, or {previous: {buffer, count},
   *   previousEntries, previousDepth, currentDepth}: the buffer holding the
   *   last target, the last plan's entries and planMotion's depths
   * @param request.field        null, or {buffer, cellOf}: also writes and indexes the
   *   field of the plan (gpu/field.js) into `buffer` (createFieldBuffer)
   * @returns {{currentCount: number, instanceCount: number}}
   */
  function encode(encoder, request) {
    const { arena, tables, plan, heat, position, output, transition = null } = request;
    const field = request.field ?? null;
    if (arena.device && arena.device !== device) {
      throw new Error("pack: the arena lives on another device");
    }
    const job = preparePack({
      info: arena.info,
      tables,
      plan,
      heat,
      position,
      transition: transition && { ...transition, previousCount: transition.previous.count },
      field,
    });
    const instanceCount = job.capacity + job.previousCount;
    if (field && field.buffer.size < job.field.words * 4) {
      throw new RangeError(
        `pack: the field holds ${field.buffer.size} bytes, the plan needs ${job.field.words * 4}`,
      );
    }
    if (output.size < instanceCount * INSTANCE_BYTES) {
      throw new RangeError(
        `pack: output holds ${output.size} bytes, ${instanceCount} instances need ${instanceCount * INSTANCE_BYTES}`,
      );
    }
    if (output.usage !== undefined && (output.usage & instanceUsage()) !== instanceUsage()) {
      throw new RangeError("pack: output needs VERTEX | STORAGE | COPY_SRC | COPY_DST");
    }

    device.queue.writeBuffer(uniform, 0, job.uniform);
    const planBuffer = scratch("plan", job.plan.byteLength);
    device.queue.writeBuffer(planBuffer, 0, job.plan);
    const previousBytes = job.previousCount * INSTANCE_BYTES;
    const resources = {
      0: uniform,
      1: planBuffer,
      2: arena.table,
      3: arena.buffers.keys,
      4: arena.buffers.count,
      5: arena.buffers.metrics,
      6: scratch("work", job.workWords * 4),
      7: output,
      8: scratch("previous", previousBytes),
      // Without a field the binding is bound and never written.
      9: field ? field.buffer : scratch("field", 4),
    };
    if (field) {
      device.queue.writeBuffer(field.buffer, 0, job.field.header);
      encoder.clearBuffer(field.buffer, 16, job.field.words * 4 - 16);
    }

    // The previous target is read before the pack overwrites it.
    if (previousBytes > 0) {
      encoder.copyBufferToBuffer(transition.previous.buffer, 0, resources[8], 0, previousBytes);
    }
    // Outputs no row reaches (unused virtual bins) stay zero: the renderer drops them.
    if (job.capacity > 0) {
      encoder.clearBuffer(output, 0, job.capacity * INSTANCE_BYTES);
    }
    for (const [entryPoint, x, y] of packDispatches(job)) {
      const pipeline = pipelines[entryPoint];
      const bindGroup = device.createBindGroup({
        label: `pack-${entryPoint}`,
        layout: pipeline.getBindGroupLayout(0),
        entries: bindings[entryPoint].map((binding) => ({
          binding,
          resource: { buffer: resources[binding] },
        })),
      });
      const pass = encoder.beginComputePass({ label: `pack-${entryPoint}` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(x, y);
      pass.end();
    }
    if (field && job.capacity > 0) {
      const pass = encoder.beginComputePass({ label: "pack-indexField" });
      pass.setPipeline(indexPipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          label: "pack-indexField",
          layout: indexPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: field.buffer } }],
        }),
      );
      pass.dispatchWorkgroups(...indexDispatch(job.capacity));
      pass.end();
    }
    return { currentCount: job.capacity, instanceCount };
  }

  function destroy() {
    uniform.destroy();
    for (const buffer of Object.values(owned)) {
      buffer?.destroy();
    }
  }

  return { encode, destroy };
}

/**
 * Copies `count` instances of an instance buffer back to the CPU. For tests
 * and the browser check only: the render path never maps its instances.
 * @returns {Promise<Float32Array>}
 */
export async function readBackInstancesForCheck(device, buffer, count) {
  const bytes = Math.max(4, count * INSTANCE_BYTES);
  const flags = globalThis.GPUBufferUsage;
  const read = device.createBuffer({
    label: "pack-readback",
    size: bytes,
    usage: flags.MAP_READ | flags.COPY_DST,
  });
  try {
    const encoder = device.createCommandEncoder({ label: "pack-readback" });
    encoder.copyBufferToBuffer(buffer, 0, read, 0, count * INSTANCE_BYTES);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(globalThis.GPUMapMode.READ);
    const data = new Float32Array(read.getMappedRange(), 0, count * INSTANCE_FLOATS).slice();
    read.unmap();
    return data;
  } finally {
    read.destroy();
  }
}
