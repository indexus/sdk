// Float32 emulation of the pack kernel (gpu/pack.js): its entry points run in
// JS on the same bytes the GPU gets (preparePack), every f32 operation
// rounded with Math.fround and summed in the same lane order. It predicts the
// GPU output bit for bit, up to the GPU's own rounding of division and log.
// The Node tests run the fake device on emulatePackStage and compare
// packEntriesF32 with the reference, walk/pack.testkit.mjs (planToInstancesCPU); the
// browser check compares the GPU with both.
import {
  INSTANCE_FLOATS,
  FLAG_ENTER,
  FLAG_LEAVE,
  FLAG_NUDGE,
  FLAG_VIRTUAL,
  POSITION_METRICS,
  SCALED_DETECTION_THRESHOLD,
  packDispatches,
  preparePack,
  readEntry,
} from "./pack.js";
import { suffixDigit } from "./wgsl/suffix.js";
import { decodeBitsInto, decodeCellInto } from "./suffix.testkit.mjs";
import { FIELD_HEADER_WORDS, FIELD_ROW_WORDS, cellHash, indexDispatch } from "./field.js";

const TABLE_WORDS = 12;
const ANCHOR_WORDS = 4;
const LANES = 64;
const ROW_GROUP = 256;
const MAX_GROUPS = 65535;

/**
 * The pack of a walk plan, as the kernel computes it.
 * @param {object} job
 * @param {{get(handle): {rows: object, origin: ArrayLike<number>}}} job.blocks
 *   RowsBlock and parentBounds (float64) per handle
 * @param job.tables      spaceTables(space)
 * @param job.plan        walkViewport(...) result
 * @param job.heat        rules (normalizeHeat)
 * @param job.position    normalizePosition
 * @param job.transition  null, or {previous: Float32Array (the last target),
 *   previousEntries, previousDepth, currentDepth}
 * @param job.field       null, or {cellOf}: also returns the field (gpu/field.js)
 * @returns {{data: Float32Array, currentCount: number, instanceCount: number,
 *   field: Uint32Array|null}}
 */
export function packEntriesF32(job) {
  const { blocks, tables, plan, heat, position, transition = null, field = null } = job;
  const layout = layoutBlocks(blocks, plan.entries);
  const previous = transition ? Float32Array.from(transition.previous) : new Float32Array(0);
  const prepared = preparePack({
    info: layout.info,
    tables,
    plan,
    heat,
    position,
    transition: transition && { ...transition, previousCount: previous.length / INSTANCE_FLOATS },
    field,
  });
  const fieldWords = new Uint32Array(prepared.field?.words ?? 1);
  fieldWords.set(prepared.field?.header ?? []);
  const instanceCount = prepared.capacity + prepared.previousCount;
  const output = new Float32Array(Math.max(1, instanceCount * INSTANCE_FLOATS));
  const bindings = {
    0: prepared.uniform,
    1: prepared.plan.buffer,
    2: layout.table.buffer,
    3: layout.keys.buffer,
    4: layout.count.buffer,
    5: layout.metrics.buffer,
    6: new ArrayBuffer(Math.max(4, prepared.workWords * 4)),
    7: output.buffer,
    8: previous.buffer,
    9: fieldWords.buffer,
  };
  for (const [entryPoint, x, y] of packDispatches(prepared)) {
    emulatePackStage(entryPoint, bindings, x, y);
  }
  if (field && prepared.capacity > 0) {
    emulatePackStage("indexField", { 0: fieldWords.buffer }, ...indexDispatch(prepared.capacity));
  }
  return {
    field: field ? fieldWords : null,
    data: output.subarray(0, instanceCount * INSTANCE_FLOATS),
    currentCount: prepared.capacity,
    instanceCount,
  };
}

// The arena's layout for the handles of a plan, on the CPU.
function layoutBlocks(blocks, entries) {
  const handles = new Set();
  for (let e = 0; e < entries.length / 8; e++) {
    handles.add(readEntry(entries, e).handle);
  }
  const list = [...handles].sort((a, b) => a - b);
  const words = { keys: 0, count: 0, metrics: 0 };
  for (const handle of list) {
    const { rows } = blocks.get(handle);
    words.keys += rows.n * rows.keyWords;
    words.count += rows.n;
    words.metrics += rows.n * rows.metricCount;
  }
  const keys = new Uint32Array(Math.max(1, words.keys));
  const count = new Uint32Array(Math.max(1, words.count));
  const metrics = new Float32Array(Math.max(1, words.metrics));
  const table = new Uint32Array(((list.at(-1) ?? 0) + 1) * TABLE_WORDS);
  const tableFloats = new Float32Array(table.buffer);
  const infos = new Map();
  const at = { keys: 0, count: 0, metrics: 0 };
  for (const handle of list) {
    const { rows, origin } = blocks.get(handle);
    const depth = rows.parent ? rows.parent.length : 0;
    keys.set(rows.keys.subarray(0, rows.n * rows.keyWords), at.keys);
    count.set(rows.count.subarray(0, rows.n), at.count);
    // Float64 metrics round to f32 here, as the arena rounds them on put.
    metrics.set(rows.metrics.subarray(0, rows.n * rows.metricCount), at.metrics);
    table.set(
      [
        at.keys,
        at.count,
        at.metrics,
        rows.n,
        rows.keyWords,
        rows.suffixChars,
        rows.metricCount,
        depth,
      ],
      handle * TABLE_WORDS,
    );
    tableFloats.set(
      Array.from({ length: 4 }, (_, i) => origin[i] ?? 0),
      handle * TABLE_WORDS + 8,
    );
    at.keys += rows.n * rows.keyWords;
    at.count += rows.n;
    at.metrics += rows.n * rows.metricCount;
    infos.set(handle, { n: rows.n, depth, suffixChars: rows.suffixChars });
  }
  return { keys, count, metrics, table, info: (handle) => infos.get(handle) ?? null };
}

// struct Params of packShader, decoded by hand from its declaration order.
function readParams(bytes) {
  const f = new Float32Array(bytes);
  const u = new Uint32Array(bytes);
  const i = new Int32Array(bytes);
  const rules = [0, 1, 2].map((r) => ({
    num: i[4 * r],
    den: i[4 * r + 1],
    minDen: f[4 * r + 2],
    transform: u[4 * r + 3],
    shift: f[41 + r],
  }));
  return {
    rules,
    view: f.subarray(12, 16),
    ruleCount: u[16],
    positionMode: u[17],
    latIndex: i[18],
    lngIndex: i[19],
    metricScale: f[20],
    latOffset: f[21],
    lngOffset: f[22],
    maxLevels: u[23],
    step: u[24],
    size: u[25],
    capacity: u[26],
    entriesAt: u[27],
    outputsAt: u[28],
    parentsAt: u[29],
    anchorsAt: u[30],
    leaveAt: u[31],
    leaveSlotStartAt: u[32],
    leaveEntryCount: u[33],
    leaveSlotCount: u[34],
    transition: u[35],
    previousDepth: f[36],
    currentDepth: f[37],
    previousCount: u[38],
    fieldRows: u[39],
    zoneCellsAt: u[40],
  };
}

/**
 * Runs one entry point of packShader over a whole dispatch, on raw bindings
 * (`{binding: ArrayBuffer}`), as the WGSL does.
 */
export function emulatePackStage(entryPoint, bindings, x, y = 1) {
  if (entryPoint === "indexField") {
    indexField(new Uint32Array(bindings[0]), x, y);
    return;
  }
  STAGES[entryPoint](state(bindings), x, y);
}

/** Whether `entryPoint` is one of the pack kernel's. */
export function isPackStage(entryPoint) {
  return entryPoint === "indexField" || entryPoint in STAGES;
}

// indexShader, lane after lane: the slots differ from a GPU's, the rows a
// lookup finds do not.
function indexField(field, x, y) {
  const [size, capacity] = field;
  for (let index = 0; index < Math.min(capacity, x * y * LANES); index++) {
    const row = FIELD_HEADER_WORDS + size + index * FIELD_ROW_WORDS;
    const level = field[row + 3];
    if (level === 0) {
      continue;
    }
    let slot = cellHash(field[row], field[row + 1], field[row + 2], level - 1) & (size - 1);
    while (field[FIELD_HEADER_WORDS + slot] !== 0) {
      slot = (slot + 1) & (size - 1);
    }
    field[FIELD_HEADER_WORDS + slot] = index + 1;
  }
}

function state(bindings) {
  const p = readParams(bindings[0]);
  const plan = bindings[1] && new Uint32Array(bindings[1]);
  return {
    p,
    plan,
    planFloats: bindings[1] && new Float32Array(bindings[1]),
    planInts: bindings[1] && new Int32Array(bindings[1]),
    tables: plan && {
      mask: plan.subarray(0, p.maxLevels * 6),
      offset: plan.subarray(p.maxLevels * 6, p.maxLevels * 7),
    },
    table: bindings[2] && new Uint32Array(bindings[2]),
    tableFloats: bindings[2] && new Float32Array(bindings[2]),
    keys: bindings[3] && new Uint32Array(bindings[3]),
    counts: bindings[4] && new Uint32Array(bindings[4]),
    metrics: bindings[5] && new Float32Array(bindings[5]),
    work: bindings[6] && new Uint32Array(bindings[6]),
    workFloats: bindings[6] && new Float32Array(bindings[6]),
    instances: bindings[7] && new Float32Array(bindings[7]),
    previous: bindings[8] && new Float32Array(bindings[8]),
    field: bindings[9] && new Uint32Array(bindings[9]),
    fieldFloats: bindings[9] && new Float32Array(bindings[9]),
  };
}

function entryAt(s, at, e) {
  return readEntry(s.plan.subarray(at), e);
}

function blockAt(s, handle) {
  const b = handle * TABLE_WORDS;
  const t = s.table;
  return {
    keysOff: t[b],
    countOff: t[b + 1],
    metricsOff: t[b + 2],
    n: t[b + 3],
    keyWords: t[b + 4],
    suffixChars: t[b + 5],
    metricCount: t[b + 6],
    depth: t[b + 7],
    origin: s.tableFloats.subarray(b + 8, b + 12),
  };
}

function keyOf(blk, row) {
  return blk.keysOff + row * blk.keyWords;
}

function lowerBound(s, blk, start, stop, want, k) {
  let lo = start;
  let hi = stop;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const key = keyOf(blk, mid);
    let under = false;
    for (let i = 0; i < k; i++) {
      const digit = suffixDigit(s.keys, key, i + 1);
      if (digit !== want[i]) {
        under = digit < want[i];
        break;
      }
    }
    if (under) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// Twin of binRuns: [a0, a1, b0, b1].
function binRuns(s, entry, blk, bits, bin) {
  const start = entry.firstRow;
  const stop = start + entry.rowCount;
  if (bits <= 6) {
    return [start, stop, 0, 0];
  }
  const below = bits - 6;
  const k = Math.floor((below + 5) / 6);
  const take = below - (k - 1) * 6;
  const offsetBase = s.p.maxLevels * 6 + blk.depth + 1;
  const want = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i + 1 < k; i++) {
    // Not a 32-bit shift: a bin has up to 30 bits.
    const exact = Math.floor(bin / 2 ** (below - (i + 1) * 6)) & 63;
    want[i] = (exact + s.plan[offsetBase + i]) & 63;
  }
  const width = 1 << (6 - take);
  const low = (bin & ((1 << take) - 1)) << (6 - take);
  const digit = (low + s.plan[offsetBase + k - 1]) & 63;
  want[k - 1] = digit;
  const a0 = lowerBound(s, blk, start, stop, want, k);
  if (digit + width <= 64) {
    want[k - 1] = digit + width;
    return [a0, lowerBound(s, blk, a0, stop, want, k), 0, 0];
  }
  want[k - 1] = 64;
  const a1 = lowerBound(s, blk, a0, stop, want, k);
  want[k - 1] = 0;
  const b0 = lowerBound(s, blk, start, a0, want, k);
  want[k - 1] = digit + width - 64;
  return [a0, a1, b0, lowerBound(s, blk, b0, a0, want, k)];
}

function cellAt(s, index) {
  const { p, plan } = s;
  const cell = {
    firstEntry: plan[p.outputsAt + 2 * index],
    entryCount: plan[p.outputsAt + 2 * index + 1],
    isVirtual: false,
  };
  if (cell.entryCount === 0) {
    return cell;
  }
  cell.entry = entryAt(s, p.entriesAt, cell.firstEntry);
  cell.blk = blockAt(s, cell.entry.handle);
  cell.bits = (cell.entry.targetResolution - cell.blk.depth * p.step) * p.size;
  cell.isVirtual = (cell.entry.flags & FLAG_VIRTUAL) !== 0;
  if (cell.isVirtual) {
    cell.bin = index - cell.entry.outBase;
    cell.runs = binRuns(s, cell.entry, cell.blk, cell.bits, cell.bin);
  }
  return cell;
}

function column(p, k) {
  if (k === 6) {
    return p.latIndex;
  }
  if (k === 7) {
    return p.lngIndex;
  }
  const rule = p.rules[k >> 1];
  return k & 1 ? rule.den : rule.num;
}

function metricAt(s, blk, index, row) {
  if (index < 0 || index >= blk.metricCount) {
    return 0;
  }
  return s.metrics[blk.metricsOff + index * blk.n + row];
}

function hasMetricPosition(p, blk) {
  return (
    p.positionMode === POSITION_METRICS &&
    p.latIndex >>> 0 < blk.metricCount &&
    p.lngIndex >>> 0 < blk.metricCount
  );
}

// The 64 lanes of one workgroup: each sums its share of every run, in f32
// (addRows), then the lanes fold as a tree (treeReduce).
function laneReduce(s, runs, head, width) {
  const counts = new Uint32Array(LANES);
  const sums = new Float32Array(LANES * 8);
  const columns = Array.from({ length: 8 }, (_, k) => column(s.p, k));
  for (let lane = 0; lane < LANES; lane++) {
    for (const [blk, start, stop] of runs) {
      for (let row = start + lane; row < stop; row += LANES) {
        counts[lane] = (counts[lane] + s.counts[blk.countOff + row]) >>> 0;
        for (let k = head; k < head + width; k++) {
          sums[lane * 8 + k] = Math.fround(sums[lane * 8 + k] + metricAt(s, blk, columns[k], row));
        }
      }
    }
  }
  for (let stride = LANES / 2; stride > 0; stride >>= 1) {
    for (let lane = 0; lane < stride; lane++) {
      counts[lane] = (counts[lane] + counts[lane + stride]) >>> 0;
      for (let k = 0; k < 8; k++) {
        sums[lane * 8 + k] = Math.fround(sums[lane * 8 + k] + sums[(lane + stride) * 8 + k]);
      }
    }
  }
  return { count: counts[0], sums: sums.subarray(0, 8) };
}

function cellPlace(s, blk, row, bits) {
  const lo = new Float32Array(3);
  const size = new Float32Array(3);
  decodeBitsInto(s.keys, keyOf(blk, row), bits, blk.depth, s.tables, lo, size, Math.fround);
  const f = Math.fround;
  const o = blk.origin;
  const latExtent = f(o[1] - o[0]);
  const lngExtent = f(o[3] - o[2]);
  return {
    pos: [
      f(o[0] + f(f(lo[0] + f(size[0] * 0.5)) * latExtent)),
      f(o[2] + f(f(lo[1] + f(size[1] * 0.5)) * lngExtent)),
    ],
    rect: [
      f(o[0] + f(lo[0] * latExtent)),
      f(o[0] + f(f(lo[0] + size[0]) * latExtent)),
      f(o[2] + f(lo[1] * lngExtent)),
      f(o[2] + f(f(lo[1] + size[1]) * lngExtent)),
    ],
  };
}

function metricCentroid(p, count, latSum, lngSum) {
  const f = Math.fround;
  const scale = f(Math.abs(latSum) / count) > SCALED_DETECTION_THRESHOLD ? p.metricScale : 1;
  const weight = f(scale * count);
  return [f(f(latSum / weight) - p.latOffset), f(f(lngSum / weight) - p.lngOffset)];
}

function nudge(p, pos, rect) {
  const v = p.view;
  if (v[1] <= v[0] || v[3] <= v[2]) {
    return pos;
  }
  if (pos[0] >= v[0] && pos[0] <= v[1] && pos[1] >= v[2] && pos[1] <= v[3]) {
    return pos;
  }
  const south = Math.max(rect[0], v[0]);
  const north = Math.min(rect[1], v[1]);
  const west = Math.max(rect[2], v[2]);
  const east = Math.min(rect[3], v[3]);
  if (north <= south || east <= west) {
    return pos;
  }
  return [
    Math.fround(Math.fround(south + north) * 0.5),
    Math.fround(Math.fround(west + east) * 0.5),
  ];
}

function outputs(x, y, capacity, run) {
  for (let gy = 0; gy < y; gy++) {
    for (let gx = 0; gx < x; gx++) {
      const index = gy * MAX_GROUPS + gx;
      if (index < capacity) {
        run(index);
      }
    }
  }
}

const STAGES = {
  reduceParents(s, x, y) {
    const { p } = s;
    const siblings = (1 << p.size) - 1;
    outputs(x, y, p.capacity, (index) => {
      const cell = cellAt(s, index);
      if (
        !(
          cell.entryCount > 0 &&
          cell.isVirtual &&
          (cell.bin & siblings) === 0 &&
          hasMetricPosition(p, cell.blk)
        )
      ) {
        return;
      }
      const [a0, a1, b0, b1] = binRuns(
        s,
        cell.entry,
        cell.blk,
        cell.bits - p.size,
        Math.floor(cell.bin / 2 ** p.size),
      );
      const reduced = laneReduce(
        s,
        [
          [cell.blk, a0, a1],
          [cell.blk, b0, b1],
        ],
        6,
        2,
      );
      s.work[index * 3] = reduced.count;
      s.workFloats[index * 3 + 1] = reduced.sums[6];
      s.workFloats[index * 3 + 2] = reduced.sums[7];
    });
  },

  writeOutputs(s, x, y) {
    const { p } = s;
    const f = Math.fround;
    outputs(x, y, p.capacity, (index) => {
      const cell = cellAt(s, index);
      if (cell.entryCount === 0) {
        return;
      }
      const runs = [];
      let located = false;
      let row = cell.entry.firstRow;
      let rows = cell.entryCount;
      if (cell.isVirtual) {
        const [a0, a1, b0, b1] = cell.runs;
        runs.push([cell.blk, a0, a1], [cell.blk, b0, b1]);
        located = hasMetricPosition(p, cell.blk);
        rows = a1 - a0 + (b1 - b0);
        row = a1 === a0 ? b0 : a0;
      } else {
        for (let e = 0; e < cell.entryCount; e++) {
          const entry = entryAt(s, p.entriesAt, cell.firstEntry + e);
          const blk = blockAt(s, entry.handle);
          runs.push([blk, entry.firstRow, entry.firstRow + entry.rowCount]);
          located = located || hasMetricPosition(p, blk);
        }
      }
      if (rows === 0) {
        return;
      }
      const reduced = laneReduce(s, runs, 0, 8);
      const total = f(reduced.count);
      let n = 0;
      let d = 0;
      for (let r = 0; r < p.ruleCount; r++) {
        const rule = p.rules[r];
        const num = rule.num === -1 ? total : reduced.sums[2 * r];
        const den = rule.den === -1 ? total : reduced.sums[2 * r + 1];
        if (num > 0 && den > rule.minDen) {
          n = rule.transform === 1 ? f(Math.log(f(1 + num))) : f(num - f(rule.shift * den));
          d = rule.transform === 1 ? 1 : den;
          break;
        }
      }

      const blk = cell.blk;
      if (p.fieldRows !== 0) {
        const zone = p.zoneCellsAt + cell.firstEntry * 3;
        const key = s.plan.slice(zone, zone + 3);
        decodeCellInto(s.keys, keyOf(blk, row), cell.bits, blk.depth, s.tables, key);
        const at = p.fieldRows + index * FIELD_ROW_WORDS;
        s.field.set([...key, cell.entry.targetResolution + 1], at);
        s.fieldFloats.set([n, d], at + 4);
      }
      const own = cellPlace(s, blk, row, cell.bits);
      let pos = own.pos;
      if (located && total > 0) {
        pos = metricCentroid(p, total, reduced.sums[6], reduced.sums[7]);
      }
      let parent = pos;
      let parentRect = own.rect;
      const anchor = s.planInts[p.parentsAt + index];
      if (cell.isVirtual || anchor >= 0) {
        const above = cellPlace(s, blk, row, cell.bits - p.size);
        parent = above.pos;
        parentRect = above.rect;
        if (cell.isVirtual) {
          const at = (index - (cell.bin & ((1 << p.size) - 1))) * 3;
          const parentCount = f(s.work[at]);
          if (located && parentCount > 0) {
            parent = metricCentroid(p, parentCount, s.workFloats[at + 1], s.workFloats[at + 2]);
          }
        } else {
          const at = p.anchorsAt + anchor * ANCHOR_WORDS;
          const parentCount = s.planFloats[at];
          if (s.planFloats[at + 1] > 0 && parentCount > 0) {
            parent = metricCentroid(p, parentCount, s.planFloats[at + 2], s.planFloats[at + 3]);
          }
        }
      }
      if (cell.entry.flags & FLAG_NUDGE) {
        pos = nudge(p, pos, own.rect);
        parent = nudge(p, parent, parentRect);
      }

      const resolution = cell.entry.targetResolution;
      let previousValues = [n, d];
      if (p.transition === 1) {
        previousValues = cell.entry.flags & FLAG_ENTER && d > 0 ? [resolution, -1] : [0, 0];
      }
      s.instances.set(
        [
          ...pos,
          ...parent,
          ...pos,
          ...parent,
          n,
          d,
          resolution,
          cell.entry.slot,
          ...previousValues,
        ],
        index * INSTANCE_FLOATS,
      );
    });
  },

  shiftPrevious(s, x) {
    const { p, previous, instances } = s;
    for (let i = 0; i < Math.min(p.previousCount, x * ROW_GROUP); i++) {
      const src = i * INSTANCE_FLOATS;
      const dst = (p.capacity + i) * INSTANCE_FLOATS;
      for (let k = 0; k < 4; k++) {
        instances[dst + k] = previous[src + k];
        instances[dst + 4 + k] = previous[src + k];
      }
      instances[dst + 8] = 0;
      instances[dst + 9] = 0;
      instances[dst + 10] = previous[src + 10];
      instances[dst + 11] = previous[src + 11];
      instances[dst + 12] = previous[src + 8];
      instances[dst + 13] = previous[src + 9];
    }
  },

  markLeave(s, x) {
    const { p, plan, instances } = s;
    let e = 0;
    for (let w = 0; w < Math.min(p.leaveSlotCount, x * ROW_GROUP); w++) {
      // findEntry: the last entry whose first slot is at or before w.
      while (e + 1 < p.leaveEntryCount && plan[p.leaveSlotStartAt + e + 1] <= w) {
        e++;
      }
      const entry = entryAt(s, p.leaveAt, e);
      if (!(entry.flags & FLAG_LEAVE)) {
        continue;
      }
      const slot = entry.outBase + (w - plan[p.leaveSlotStartAt + e]);
      const dst = (p.capacity + slot) * INSTANCE_FLOATS;
      if (slot >= p.previousCount || instances[dst + 13] <= 0) {
        continue;
      }
      instances[dst + 8] = -p.previousDepth;
      instances[dst + 9] = -p.currentDepth;
    }
  },
};
