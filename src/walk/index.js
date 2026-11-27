// The walk: one descent of the tree per viewport, from per-zone summaries to a
// PLAN that names the rows to draw (docs/heat-pipeline.md §b, §c). It
// reproduces Cube.retrieve/display and the worker's collectSlot on the binary
// tree that the Cube materialised: inside one character the Space refines
// every coordinate `step` times, and each of those binary levels is a bin of
// the zone's rows by the first bits of their geometric digit.
import { ROOT, ROUTING_ALPHABET, BITS_PER_CHAR, parent } from "../tree/index.js";
import { suffixAt } from "../wire/block.js";
import { CHARS, childLocation, refineXyz, zoneDepth, zoneLevels } from "./zones.js";
import { allSums, combineColumns, kindsOf, resetColumns } from "./columns.js";

export { createZoneIndex } from "./zones.js";
export {
  ENTRY_WORDS,
  FLAG_ENTER,
  FLAG_LEAVE,
  FLAG_NUDGE,
  FLAG_VIRTUAL,
  FLOATS_PER_INSTANCE,
} from "./pack.js";

import { ENTRY_WORDS, FLAG_ENTER, FLAG_LEAVE, FLAG_NUDGE, FLAG_VIRTUAL } from "./pack.js";

// Same limits as the v1 worker's child virtualisation.
const MAX_VIRTUAL_CHILD_DEPTH_DELTA = 4;
const MAX_VIRTUAL_CELLS_PER_SLOT = 20000;

/**
 * @typedef {object} Plan
 * @property {Uint32Array} entries ENTRY_WORDS per entry (pack.js). A plain
 *   entry is one cell, or one run of its rows: entries may share an output and
 *   then add up. A FLAG_VIRTUAL entry bins one character's rows directly.
 * @property {number} capacity outputs (instances) the entries write
 * @property {Int32Array} parents per output: its anchor row, or -1 (itself, or
 *   the enclosing bin of a FLAG_VIRTUAL entry)
 * @property {Float64Array} anchors anchorStride per row: count, metric length,
 *   metric sums of the parent cell, from the zone summaries
 * @property {Uint32Array} pinned handles the entries read
 * @property {string[]} missing zones the descent wanted and does not hold
 * @property {{totalCount: number, metricSums: Float64Array}} stats
 * @property {string} signature equal plans have equal signatures
 * @property {string[]} zones, @property {Uint32Array} entryZone owner zone per entry
 * @property {number} centerDepth, @property {number} cameraDepth, @property {number} step
 * @property {Float64Array|null} strictView [south, north, west, east] (nudge)
 */

/**
 * @param {ReturnType<import("./zones.js").createZoneIndex>} index
 * @param {object} options
 * @param {number} options.zoom display zoom
 * @param {number} options.resolution algorithm resolution (Cube option)
 * @param {Array} options.bounds Space segments of the render window
 * @param {Array} [options.strictBounds] Space segments of the visible view (stats, nudge)
 * @param {number} [options.limit] stop when covered and count <= limit
 * @param {number} [options.children] stop when covered and fewer children
 * @param {(cell: {xyz, bounds, count}) => boolean} [options.isCovered] polygon test;
 *   the default (always covered) is the Cube's, the v1 worker passes false without polygon
 * @param {number} [options.parentFallbackDepth] empty slot: look this many tiers up
 * @param {boolean} [options.virtualize] split coarse cells down to their slot
 * @param {boolean} [options.nudgeAnchors] slide virtual anchors into the view
 * @param {number} [options.statsZoom] zoom of the viewport stats (default zoom)
 * @returns {Plan}
 */
export function walkViewport(index, options) {
  const {
    zoom,
    resolution,
    bounds,
    strictBounds = bounds,
    limit = 0,
    children = 1,
    isCovered = () => true,
    parentFallbackDepth = 6,
    virtualize = false,
    nudgeAnchors = false,
    statsZoom = zoom,
  } = options;
  const policy = { limit, children, isCovered };
  const missing = new Set();
  const tiers = new Map();
  const tier = (depth) => {
    if (!tiers.has(depth)) tiers.set(depth, descend(index, depth, bounds, policy, false, missing));
    return tiers.get(depth);
  };
  const builder = createBuilder(index);
  const center = Math.floor(zoom + resolution);
  const minDepth = Math.max(0, center - parentFallbackDepth);
  // v1 also splits cells when the subdivision limit is at most one.
  const virtual = virtualize || limit <= 1;
  // v1 anchors a cell on its parent only when the display holds the parent:
  // the tiers of the three slots, the fallback tiers it walked and the tier
  // above each one it drew.
  const displayed = new Set([center - 1, center, center + 1]);
  const ids = new Map();
  const shown = (depth) => {
    if (!displayed.has(depth) || depth < 0) return null;
    if (!ids.has(depth)) ids.set(depth, new Set(tier(depth).map((n) => cellId(index.space, n))));
    return ids.get(depth);
  };
  const picked = [];
  for (let slot = center - 1; slot <= center + 1; slot++) {
    for (let depth = slot; depth >= minDepth; depth--) {
      if (depth < slot) displayed.add(depth);
      const cells = tier(depth);
      if (cells.length === 0) continue;
      displayed.add(depth - 1);
      picked.push([slot, depth, cells]);
      break;
    }
  }
  const emission = { virtual, virtualize, nudge: nudgeAnchors };
  for (const [slot, depth, cells] of picked) {
    const itemCells = () => descend(index, depth, bounds, policy, true, null);
    emitSlot(builder, cells, slot, emission, shown, itemCells);
  }
  const statsDepth = Math.floor(statsZoom + resolution);
  const stats = viewportStats(
    index,
    descend(index, statsDepth, strictBounds, policy, true, null),
    strictBounds,
  );
  return builder.finish({
    centerDepth: center,
    cameraDepth: zoom + resolution,
    missing: [...missing],
    stats,
    strictView: rectOf(strictBounds),
  });
}

// ----------------------------------------------------------------------------
// Descent (Cube.retrieve)
// ----------------------------------------------------------------------------

// A node is a cell of the Cube's binary tree: level j (0..step) of `zone`,
// prefix p of the first j·size geometric bits; at j = step it is the child
// character r, i.e. the child zone as its parent's row sees it.
function node(zone, j, p, r, base, xyz, bypass) {
  return { zone, j, p, r, base, xyz, bypass };
}

function nodeRows(space, n) {
  return n.j === space.step ? n.zone.children.rows[n.r] : zoneLevels(space, n.zone)[n.j].rows[n.p];
}

function nodeCount(space, n) {
  return n.j === space.step
    ? n.zone.children.count[n.r]
    : zoneLevels(space, n.zone)[n.j].count[n.p];
}

/** Metric sums of a node as [array, offset]; length is zone.metricCount. */
function nodeMetrics(space, n) {
  const m = n.zone.metricCount;
  if (n.j === space.step) return [n.zone.children.metricSums, n.r * m];
  return [zoneLevels(space, n.zone)[n.j].metricSums, n.p * m];
}

function pushChildren(space, stack, zone, base, j, p, bypass) {
  const size = space.size;
  const next = j + 1;
  const levels = zoneLevels(space, zone);
  if (next < space.step) {
    for (let q = (1 << size) - 1; q >= 0; q--) {
      const child = (p << size) | q;
      if (levels[next].rows[child] === 0) continue;
      const xyz = refineXyz(
        space,
        base,
        zone.depth,
        child << (BITS_PER_CHAR - next * size),
        next * size,
      );
      stack.push(node(zone, next, child, -1, base, xyz, bypass));
    }
    return;
  }
  const shift = BITS_PER_CHAR - j * size;
  for (let r = CHARS - 1; r >= 0; r--) {
    const digit = levels.digit[r];
    if (zone.children.rows[r] === 0 || digit >> shift !== p) continue;
    const xyz = refineXyz(space, base, zone.depth, digit, BITS_PER_CHAR);
    stack.push(node(zone, next, digit, r, base, xyz, bypass));
  }
}

function descend(index, resolution, bounds, policy, items, missing) {
  const space = index.space;
  const out = [];
  const root = index.get(ROOT);
  if (!root) {
    missing?.add(ROOT);
    return out;
  }
  const need = items ? 1 : (policy.children ?? 1);
  const rootXyz = space.xyz(ROOT);
  const stack = [node(root, 0, 0, -1, rootXyz, rootXyz, false)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (nodeRows(space, current) === 0) continue;
    const cellBounds = space.bounds(current.xyz);
    let bypass = current.bypass;
    if (!bypass) {
      const { overlap, contained } = space.overlap(bounds, cellBounds);
      if (!overlap) continue;
      bypass = contained;
    }
    const res = current.xyz.resolution;
    if (res === resolution || (!items && res > resolution)) {
      out.push(current);
      continue;
    }
    const count = nodeCount(space, current);
    // Children: the next binary level of the same zone, or of the child zone.
    let owner = current.zone;
    let j = current.j;
    let p = current.p;
    let base = current.base;
    let childCount;
    let complete = true;
    let location = null;
    if (current.j < space.step) {
      childCount = zoneLevels(space, owner)[j].children[p];
    } else {
      location = childLocation(owner.location, current.r);
      const child = index.get(location);
      childCount = 0;
      if (child && child.blocks.length > 0) {
        owner = child;
        j = 0;
        p = 0;
        base = current.xyz;
        childCount = zoneLevels(space, child)[0].children[0];
        // A partial delivery must not replace the parent's mass.
        complete = child.count === count;
      }
      if (child) location = null;
    }
    const covered = policy.isCovered({ xyz: current.xyz, bounds: cellBounds, count });
    if (!items && location !== null && !(covered && count <= policy.limit)) missing.add(location);
    if (
      items ? covered && childCount < 1 : covered && (count <= policy.limit || childCount < need)
    ) {
      out.push(current);
      continue;
    }
    if (childCount === 0 || !complete) {
      out.push(current);
      continue;
    }
    pushChildren(space, stack, owner, base, j, p, bypass);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Emission (collectSlot + virtualisation)
// ----------------------------------------------------------------------------

function createBuilder(index) {
  const stride = 2 + index.metricCount;
  return {
    index,
    words: [],
    entryZone: [],
    zones: [],
    zoneIds: new Map(),
    parents: [],
    anchors: [],
    anchorStride: stride,
    anchorIds: new Map(),
    capacity: 0,

    entry(zone, handle, first, rows, slot, res, flags, outBase, binCapacity) {
      let id = this.zoneIds.get(zone);
      if (id === undefined) {
        id = this.zones.length;
        this.zones.push(zone);
        this.zoneIds.set(zone, id);
      }
      this.entryZone.push(id);
      this.words.push(handle, first, rows, slot >>> 0, res, flags, outBase, binCapacity);
    },

    mark() {
      return [this.words.length, this.entryZone.length, this.parents.length, this.capacity];
    },

    reset([words, entries, parents, capacity]) {
      this.words.length = words;
      this.entryZone.length = entries;
      this.parents.length = parents;
      this.capacity = capacity;
    },

    finish(fields) {
      const entries = new Uint32Array(this.words);
      const pinned = new Set();
      for (let e = 0; e < entries.length; e += ENTRY_WORDS) pinned.add(entries[e]);
      return {
        entries,
        capacity: this.capacity,
        pinned: Uint32Array.from(pinned),
        parents: Int32Array.from(this.parents),
        anchors: Float64Array.from(this.anchors),
        anchorStride: this.anchorStride,
        metricCount: this.index.metricCount,
        kinds: this.index.kinds,
        step: this.index.space.step,
        zones: this.zones,
        entryZone: Uint32Array.from(this.entryZone),
        signature: signature(entries, this.capacity, fields.centerDepth),
        ...fields,
      };
    },
  };
}

/** Routing digits of the characters under a node, ascending. */
function nodeChars(space, n) {
  if (n.j === space.step) return [n.r];
  const levels = zoneLevels(space, n.zone);
  const shift = BITS_PER_CHAR - n.j * space.size;
  const chars = [];
  for (let r = 0; r < CHARS; r++) {
    if (n.zone.children.rows[r] > 0 && levels.digit[r] >> shift === n.p) chars.push(r);
  }
  return chars;
}

/** Identity of a binary cell, whatever the zone that names it. */
function cellId(space, n) {
  return n.j === space.step ? `${n.zone.location}/${n.r}` : `${n.zone.location}|${n.j}|${n.p}`;
}

/** The parent cell of a node (one binary level up), or null for the root. */
function parentNode(index, n) {
  const space = index.space;
  if (n.j === 0) return null;
  if (n.j >= 2) {
    const p = (n.j === space.step ? zoneLevels(space, n.zone).digit[n.r] : n.p) >> space.size;
    return node(n.zone, n.j - 1, p, -1);
  }
  // The zone itself: the Cube kept its parent's row as its mass.
  const owner = n.zone.location === ROOT ? null : index.get(parent(n.zone.location));
  const r = ROUTING_ALPHABET.indexOf(n.zone.location.at(-1));
  return owner && owner.children.rows[r] > 0
    ? node(owner, space.step, 0, r)
    : node(n.zone, 0, 0, -1);
}

/** Anchor (the parent cell) of a node: index into anchors, or -1. */
function anchorOf(builder, n) {
  const space = builder.index.space;
  const up = parentNode(builder.index, n);
  if (!up) return -1;
  const key = cellId(space, up);
  let id = builder.anchorIds.get(key);
  if (id !== undefined) return id;
  id = builder.anchorIds.size;
  builder.anchorIds.set(key, id);
  const [sums, offset] = nodeMetrics(space, up);
  const m = up.zone.metricCount;
  const row = new Array(builder.anchorStride).fill(0);
  row[0] = nodeCount(space, up);
  row[1] = m;
  for (let k = 0; k < m; k++) row[2 + k] = sums[offset + k];
  builder.anchors.push(...row);
  return id;
}

/**
 * Calls `run(first, end, chars)` for each maximal run of contiguous rows of
 * `chars` (ascending routing digits) in `block`.
 */
function forEachRun(block, chars, run) {
  let first = 0;
  let end = 0;
  let count = 0;
  for (const r of chars) {
    const from = block.ranges[2 * r];
    const to = block.ranges[2 * r + 1];
    if (from === to) continue;
    if (count > 0 && from !== end) {
      run(first, end, count);
      count = 0;
    }
    if (count === 0) first = from;
    end = to;
    count++;
  }
  if (count > 0) run(first, end, count);
}

/**
 * One output for one cell: one entry per contiguous run of its rows in each
 * block. Without `anchored` the cell is its own anchor.
 */
function emitCell(builder, n, slot, flags, anchored) {
  const space = builder.index.space;
  const out = builder.capacity++;
  builder.parents.push(anchored ? anchorOf(builder, n) : -1);
  const chars = n.j === 0 ? allChars(n.zone) : nodeChars(space, n);
  const res = n.xyz.resolution;
  for (const block of n.zone.blocks) {
    forEachRun(block, chars, (first, end) => {
      builder.entry(n.zone.location, block.handle, first, end - first, slot, res, flags, out, 1);
    });
  }
}

function emitSlot(builder, cells, slot, options, shown, itemCells) {
  const anchored = (n) => {
    const up = parentNode(builder.index, n);
    return up !== null && shown(n.xyz.resolution - 1)?.has(cellId(builder.index.space, up));
  };
  if (options.virtual) {
    if (emitVirtualSlot(builder, cells, slot, options.nudge, anchored)) return;
    // v1 retries from the item-purpose descent when nothing of the visual tier
    // could be split, and only when virtualisation was asked for.
    if (options.virtualize && emitVirtualSlot(builder, itemCells(), slot, options.nudge, anchored))
      return;
  }
  for (const n of cells) emitCell(builder, n, slot, 0, anchored(n));
}

/** @returns {boolean} false when nothing was emitted: the slot is then drawn as it is */
function emitVirtualSlot(builder, cells, slot, nudge, anchored) {
  const mark = builder.mark();
  const budget = { remaining: MAX_VIRTUAL_CELLS_PER_SLOT };
  let produced = false;
  for (const n of cells) {
    if (n.xyz.resolution >= slot) {
      emitCell(builder, n, slot, 0, anchored(n));
      produced = true;
    } else if (emitVirtual(builder, n, slot, nudge, budget, anchored)) {
      produced = true;
    } else {
      emitCell(builder, n, slot, 0, anchored(n));
    }
    if (budget.remaining < 0) break;
  }
  if (produced && budget.remaining >= 0) return true;
  builder.reset(mark);
  return false;
}

/**
 * Splits a cell coarser than its slot down to the slot, as v1 splits it from
 * its items: through every loaded zone below it, whatever the stop rules.
 * Where no zone is loaded, the rows of a character are binned by the kernel
 * if they are deep enough and sit in one block; otherwise that part is drawn
 * as it is (v1 dropped it).
 * @returns {boolean} false when the cell must be drawn as it is
 */
function emitVirtual(builder, n, slot, nudge, budget, anchored) {
  const index = builder.index;
  const space = index.space;
  const delta = slot - n.xyz.resolution;
  if (delta <= 0 || delta > MAX_VIRTUAL_CHILD_DEPTH_DELTA) return false;
  const flags = nudge ? FLAG_NUDGE : 0;
  const cells = [];
  const leaves = [];
  const whole = [];
  const stack = [n];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.xyz.resolution === slot) {
      cells.push(current);
      continue;
    }
    if (current.j < space.step) {
      pushChildren(space, stack, current.zone, current.base, current.j, current.p, true);
      continue;
    }
    const child = index.get(childLocation(current.zone.location, current.r));
    if (child && child.blocks.length > 0) {
      pushChildren(space, stack, child, current.xyz, 0, 0, true);
      continue;
    }
    const bits = (slot - current.zone.depth * space.step) * space.size;
    const r = current.r;
    const blocks = current.zone.blocks.filter(
      (block) => block.ranges[2 * r] !== block.ranges[2 * r + 1],
    );
    if (blocks.length === 1 && BITS_PER_CHAR * blocks[0].suffixChars >= bits)
      leaves.push([current, blocks[0], bits]);
    else whole.push(current);
  }
  if (cells.length === 0 && leaves.length === 0) return false;
  budget.remaining -= cells.length;
  for (const cell of cells) emitCell(builder, cell, slot, flags, true);
  for (const cell of whole) emitCell(builder, cell, slot, 0, anchored(cell));
  for (const [leaf, block, bits] of leaves) {
    const first = block.ranges[2 * leaf.r];
    const rows = block.ranges[2 * leaf.r + 1] - first;
    const capacity = 2 ** (bits - BITS_PER_CHAR);
    builder.entry(
      leaf.zone.location,
      block.handle,
      first,
      rows,
      slot,
      slot,
      flags | FLAG_VIRTUAL,
      builder.capacity,
      capacity,
    );
    for (let k = 0; k < capacity; k++) builder.parents.push(-1);
    builder.capacity += capacity;
    budget.remaining -= capacity;
  }
  return true;
}

function allChars(zone) {
  const chars = [];
  for (let r = 0; r < CHARS; r++) if (zone.children.rows[r] > 0) chars.push(r);
  return chars;
}

// ----------------------------------------------------------------------------
// Stats, signature, motion
// ----------------------------------------------------------------------------

function rectOf(bounds) {
  const values = bounds?.[0]?.value?.();
  return Array.isArray(values) && values.length === 4 ? Float64Array.from(values) : null;
}

function intersectionFraction(cell, view) {
  const south = Math.max(cell[0], view[0]);
  const north = Math.min(cell[1], view[1]);
  const west = Math.max(cell[2], view[2]);
  const east = Math.min(cell[3], view[3]);
  if (north <= south || east <= west) return 0;
  const area = (cell[1] - cell[0]) * (cell[3] - cell[2]);
  return area > 0 ? ((north - south) * (east - west)) / area : 0;
}

/**
 * Count and metric sums of a region from the zones the index holds, as the
 * viewport stats: cells of `resolution` (or the finest held above it), weighted
 * by their fraction inside `bounds` (Space segments).
 */
export function regionStats(index, { bounds, resolution }) {
  const policy = { limit: 0, children: 1, isCovered: () => false };
  return viewportStats(index, descend(index, resolution, bounds, policy, true, null), bounds);
}

/**
 * The zones that cover `view` (Space segments) for a coarse read of its own:
 * one level deeper while that stays within `maxZones` zones and depth 12.
 */
export function coverZones(space, view, maxZones) {
  const overlaps = (zone) => space.overlap(view, space.decode(zone)).overlap;
  let zones = [ROOT];
  for (;;) {
    const next = [];
    for (const zone of zones) {
      for (let r = 0; r < CHARS; r++) {
        const child = childLocation(zone, r);
        if (overlaps(child)) next.push(child);
      }
    }
    if (next.length > maxZones || zoneDepth(next[0] ?? ROOT) > 12) return zones;
    zones = next;
  }
}

/**
 * Count and metric sums of the rows of `blocks` (RowsBlocks), each row
 * weighted by the fraction of its cell inside `view` (Space segments).
 */
export function blockSums(space, blocks, view, kinds = null) {
  const rect = view[0].value();
  let totalCount = 0;
  let sums = [];
  if (!allSums(kinds)) {
    // Typed columns (walk/columns.js): sums weighted by the visible fraction,
    // extremes over the rows that show at all, ordered columns NaN.
    const m = Math.max(0, ...blocks.map((b) => b.metricCount));
    const K = kindsOf(kinds, m);
    sums = new Array(m);
    resetColumns(sums, 0, K);
    let seen = 0;
    for (const block of blocks) {
      for (let row = 0; row < block.n; row++) {
        const cell = space.decode(block.parent + suffixAt(block, row))[0].value();
        const f = intersectionFraction(cell, rect);
        if (!(f > 0)) continue;
        totalCount += block.count[row] * f;
        combineColumns(sums, 0, seen++, (j) => (j < block.metricCount ? block.metrics[j * block.n + row] : 0), K, f, false);
      }
    }
    return { totalCount, metricSums: sums };
  }
  for (const block of blocks) {
    if (sums.length < block.metricCount) {
      sums = [...sums, ...new Array(block.metricCount - sums.length).fill(0)];
    }
    for (let row = 0; row < block.n; row++) {
      const cell = space.decode(block.parent + suffixAt(block, row))[0].value();
      const f = intersectionFraction(cell, rect);
      if (!(f > 0)) continue;
      totalCount += block.count[row] * f;
      for (let j = 0; j < block.metricCount; j++) sums[j] += block.metrics[j * block.n + row] * f;
    }
  }
  return { totalCount, metricSums: sums };
}

/** summarizeViewport of v1: mass of the item-purpose cells, weighted by their visible fraction. */
function viewportStats(index, cells, strictBounds) {
  const space = index.space;
  const view = rectOf(strictBounds);
  const metricSums = new Float64Array(index.metricCount);
  const K = allSums(index.kinds) ? null : kindsOf(index.kinds, index.metricCount);
  if (K) resetColumns(metricSums, 0, K);
  let totalCount = 0;
  let seen = 0;
  for (const n of cells) {
    const count = nodeCount(space, n);
    if (!(count > 0)) continue;
    const rect = rectOf(space.bounds(n.xyz));
    const fraction = view && rect ? intersectionFraction(rect, view) : 1;
    if (!(fraction > 0)) continue;
    totalCount += count * fraction;
    const [sums, offset] = nodeMetrics(space, n);
    if (K) {
      // Cells of a viewport have no single order: ordered columns are NaN.
      const m = n.zone.metricCount;
      combineColumns(metricSums, 0, seen++, (k) => (k < m && Number.isFinite(sums[offset + k]) ? sums[offset + k] : K[k] === "sum" ? 0 : NaN), K, fraction, false);
      continue;
    }
    for (let k = 0; k < n.zone.metricCount; k++) {
      if (Number.isFinite(sums[offset + k])) metricSums[k] += sums[offset + k] * fraction;
    }
  }
  return { totalCount, metricSums };
}

function signature(entries, capacity, centerDepth) {
  let hash = 0x811c9dc5;
  const mix = (value) => {
    hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
  };
  for (let i = 0; i < entries.length; i++) mix(entries[i]);
  mix(capacity);
  mix(centerDepth >>> 0);
  return `${hash.toString(16)}:${entries.length / ENTRY_WORDS}:${capacity}`;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Cells of one zone at one resolution, and the group of their parents. */
function groupOf(plan, e, step) {
  const zone = plan.zones[plan.entryZone[e]];
  const res = plan.entries[e * ENTRY_WORDS + 4];
  const zoneRes = (zone === ROOT ? 0 : zone.length) * step;
  const up =
    res - 1 > zoneRes
      ? `${zone}|${res - 1}`
      : res - 1 === zoneRes && zone !== ROOT
        ? `${parent(zone)}|${res - 1}`
        : null;
  return [`${zone}|${res}`, up, res];
}

function visibleGroups(plan, depth, step) {
  const groups = new Set();
  const slots = new Int32Array(plan.entries.buffer, plan.entries.byteOffset, plan.entries.length);
  for (let e = 0; e < plan.entryZone.length; e++) {
    if (Math.abs(slots[e * ENTRY_WORDS + 3] - depth) < 1) groups.add(groupOf(plan, e, step)[0]);
  }
  return groups;
}

/**
 * Subdivision motion, decided per zone (decision 4): the cells of a zone at a
 * resolution enter from their parent when the previous plan showed the
 * parent and not them; they leave on a zoom out when the new plan shows the
 * parent instead. Sets FLAG_ENTER on `plan.entries` and FLAG_LEAVE on
 * `previous.entries`: call it before either buffer is transferred. Returns
 * the two depths the renderer blends between, which the merge markers carry.
 */
export function planMotion(previous, plan) {
  const step = plan.step;
  const currentDepth = clamp(plan.cameraDepth, plan.centerDepth - 1, plan.centerDepth + 1);
  const result = { entered: 0, left: 0, previousDepth: currentDepth, currentDepth };
  if (!previous) return result;
  const previousDepth = clamp(plan.cameraDepth, previous.centerDepth - 1, previous.centerDepth + 1);
  result.previousDepth = previousDepth;
  if (Math.abs(Math.floor(plan.cameraDepth) - previous.centerDepth) > 2) return result;
  const before = visibleGroups(previous, previousDepth, step);
  const after = visibleGroups(plan, currentDepth, step);
  for (let e = 0; e < plan.entryZone.length; e++) {
    const [id, up, res] = groupOf(plan, e, step);
    if (currentDepth > res && up && !before.has(id) && before.has(up)) {
      plan.entries[e * ENTRY_WORDS + 5] |= FLAG_ENTER;
      result.entered++;
    }
  }
  if (previousDepth <= currentDepth) return result;
  for (let e = 0; e < previous.entryZone.length; e++) {
    const [id, up, res] = groupOf(previous, e, step);
    if (previousDepth > res && up && !after.has(id) && after.has(up)) {
      previous.entries[e * ENTRY_WORDS + 5] |= FLAG_LEAVE;
      result.left++;
    }
  }
  return result;
}
