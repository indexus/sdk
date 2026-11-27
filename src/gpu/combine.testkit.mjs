// The combine kernel (gpu/combine.js) in JS, twice: emulateCombineStage runs
// the WGSL's steps on the bytes the GPU gets, in float32; combineCPU is the
// reference, a join on cell keys in a Map and float64. Not shipped.
import { MAX_OPS, evaluate } from "./combine.js";
import { FIELD_HEADER_WORDS, FIELD_ROW_WORDS, cellHash } from "./field.js";
import { INSTANCE_FLOATS } from "./pack.js";
import { isPackStage, emulatePackStage } from "./pack.testkit.mjs";

/** `run` of a fake device (device.testkit.mjs) that packs and combines. */
export function emulateStage(entryPoint, bindings, x, y) {
  if (isPackStage(entryPoint)) emulatePackStage(entryPoint, bindings, x, y);
  else emulateCombineStage(entryPoint, bindings, x, y);
}

/** The rows of a field buffer: {cell: [c0, c1, c2], resolution, num, den}, or null per empty output. */
export function fieldRows(buffer) {
  const words = new Uint32Array(buffer);
  const floats = new Float32Array(buffer);
  const [size, capacity] = words;
  return Array.from({ length: capacity }, (_, index) => {
    const row = FIELD_HEADER_WORDS + size + index * FIELD_ROW_WORDS;
    if (words[row + 3] === 0) return null;
    return {
      cell: Array.from(words.subarray(row, row + 3)),
      resolution: words[row + 3] - 1,
      num: floats[row + 4],
      den: floats[row + 5],
    };
  });
}

function find(words, cell, resolution) {
  const size = words[0];
  let slot = cellHash(cell[0], cell[1], cell[2], resolution) & (size - 1);
  let best = 0;
  for (let turn = 0; turn < size; turn++) {
    const owner = words[FIELD_HEADER_WORDS + slot];
    if (owner === 0) break;
    const row = FIELD_HEADER_WORDS + size + (owner - 1) * FIELD_ROW_WORDS;
    const same = cell.every((c, axis) => words[row + axis] === c);
    if (same && words[row + 3] === resolution + 1) best = Math.max(best, owner);
    slot = (slot + 1) & (size - 1);
  }
  return best;
}

function valueAt(buffer, first, firstResolution) {
  const words = new Uint32Array(buffer);
  const floats = new Float32Array(buffer);
  const [size, , coarsest] = words;
  if (size === 0 || firstResolution < coarsest) return null;
  let cell = first;
  for (let resolution = firstResolution; ; resolution--) {
    const owner = find(words, cell, resolution);
    if (owner !== 0) {
      const row = FIELD_HEADER_WORDS + size + (owner - 1) * FIELD_ROW_WORDS;
      if (floats[row + 5] > 0) return Math.fround(floats[row + 4] / floats[row + 5]);
    }
    if (resolution === coarsest) return null;
    cell = cell.map((c) => c >>> 1);
  }
}

/** The `combine` entry point over a whole dispatch, on raw bindings. */
export function emulateCombineStage(entryPoint, bindings, x, y = 1) {
  if (entryPoint !== "combine") throw new Error(`combine: no entry point ${entryPoint}`);
  const u32 = new Uint32Array(bindings[0]);
  const f32 = new Float32Array(bindings[0]);
  const at = MAX_OPS * 2;
  const [count, capacity, steady, fieldCount] = u32.subarray(at + 8, at + 12);
  const program = { ops: u32.subarray(0, at), count };
  const instances = new Float32Array(bindings[1]);
  const rows = fieldRows(bindings[2]);
  for (let index = 0; index < Math.min(capacity, x * y * 64); index++) {
    const own = rows[index];
    if (!own) continue;
    let drawn = own.den > 0;
    const values = [own.den === 0 ? 0 : Math.fround(own.num / own.den), 0, 0, 0];
    for (let k = 1; k < fieldCount; k++) {
      const found = valueAt(bindings[2 + k], own.cell, own.resolution);
      values[k] = found ?? f32[at + k];
      drawn = drawn && (found !== null || u32[at + 4 + k] === 2);
    }
    const num = drawn ? Math.fround(Math.max(evaluate(program, values), 0) * own.den) : 0;
    const weight = drawn ? own.den : 0;
    const o = index * INSTANCE_FLOATS;
    instances.set([num, weight], o + 8);
    if (steady === 1) instances.set([num, weight], o + 12);
  }
}

const keyOf = (cell, resolution) => `${resolution}:${cell.join(",")}`;

/**
 * The reference: per output of the first field, [num, den] of the combined
 * cell ([0, 0] when it is not drawn), or null for an output without rows.
 * @param fields  per field {rows: fieldRows(...), missing?: number}
 * @param program compileExpression(...)
 */
export function combineCPU({ fields, program }) {
  const maps = fields.slice(1).map(({ rows }) => {
    const map = new Map();
    for (const row of rows) {
      // Rows of one cell hold the same sums: the last one, as the kernel.
      if (row) map.set(keyOf(row.cell, row.resolution), row);
    }
    return map;
  });
  return fields[0].rows.map((own) => {
    if (!own) return null;
    let drawn = own.den > 0;
    const values = [drawn ? own.num / own.den : 0];
    maps.forEach((map, k) => {
      let value = null;
      for (let up = 0; up <= own.resolution && value === null; up++) {
        const cell = own.cell.map((c) => Math.floor(c / 2 ** up));
        const row = map.get(keyOf(cell, own.resolution - up));
        if (row && row.den > 0) value = row.num / row.den;
      }
      const { missing } = fields[k + 1];
      if (value === null && !Number.isFinite(missing)) drawn = false;
      values.push(value ?? missing ?? 0);
    });
    if (!drawn) return [0, 0];
    return [
      Math.max(
        evaluate(program, values, (v) => v),
        0,
      ) * own.den,
      own.den,
    ];
  });
}
