// A field: what one collection says of the cells of a view, in one GPU
// buffer other kernels can join on (docs/compose.md). The pack kernel writes
// one row per output — the Cell (integer coordinates and resolution, the
// collection's offset removed) and the value of the heat rules — and
// indexField builds a hash table over the rows, so that gpu/combine.js finds
// the row of a Cell without leaving the GPU.
//
// Layout, in u32 words:
//   [0, 4)                 header: tableSize, capacity, coarsest, 0
//   [4, 4 + tableSize)     table: row + 1 of a Cell, 0 when free (open
//                          addressing, linear probing; tableSize is a power
//                          of two, at least twice the capacity)
//   then 6 per output      row: c0, c1, c2, resolution + 1, num, den (f32)
// `coarsest` is the lowest resolution of the rows. A row whose fourth word is
// 0 is an output no row of the collection reached.
import { bufferUsage } from "./device.js";

export const FIELD_HEADER_WORDS = 4;
export const FIELD_ROW_WORDS = 6;
/** Cells are u32 per coordinate: a field holds resolutions up to this. */
export const FIELD_MAX_RESOLUTION = 32;

const LANES = 64;
const MAX_GROUPS = 65535;

/** Where the table and the rows of a field of `capacity` outputs sit. */
export function fieldLayout(capacity) {
  const tableSize = Math.max(4, 2 ** Math.ceil(Math.log2(2 * capacity)));
  const rowsAt = FIELD_HEADER_WORDS + tableSize;
  return { tableSize, rowsAt, words: rowsAt + capacity * FIELD_ROW_WORDS };
}

/** A field buffer able to hold `capacity` outputs. */
export function createFieldBuffer(device, capacity) {
  return device.createBuffer({
    label: "field",
    size: fieldLayout(Math.max(1, capacity)).words * 4,
    usage: bufferUsage.STORAGE | bufferUsage.COPY_SRC | bufferUsage.COPY_DST,
  });
}

/** Table slot a Cell starts probing at, before the mask; cellHashWGSL in JS. */
export function cellHash(c0, c1, c2, resolution) {
  let h = Math.imul(c0, 0x9e3779b1) >>> 0;
  h = ((h ^ (h >>> 15)) + Math.imul(c1, 0x85ebca77)) >>> 0;
  h = ((h ^ (h >>> 13)) + Math.imul(c2, 0xc2b2ae3d) + Math.imul(resolution, 0x27d4eb2f)) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export const cellHashWGSL = /* wgsl */ `
fn cellHash(c: vec3u, resolution: u32) -> u32 {
  var h = c.x * 0x9E3779B1u;
  h = (h ^ (h >> 15u)) + c.y * 0x85EBCA77u;
  h = (h ^ (h >> 13u)) + c.z * 0xC2B2AE3Du + resolution * 0x27D4EB2Fu;
  return h ^ (h >> 16u);
}
`;

// Atomics give every output its own slot whatever the order of the lanes.
// Which slot a Cell lands in depends on that order; what a lookup returns
// does not (gpu/combine.js keeps the last row of a Cell).
export const indexShader = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> field: array<atomic<u32>>;

${cellHashWGSL}

@compute @workgroup_size(${LANES})
fn indexField(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let size = atomicLoad(&field[0]);
  let index = (group.y * ${MAX_GROUPS}u + group.x) * ${LANES}u + lid.x;
  if (index >= atomicLoad(&field[1])) {
    return;
  }
  let row = ${FIELD_HEADER_WORDS}u + size + index * ${FIELD_ROW_WORDS}u;
  let level = atomicLoad(&field[row + 3u]);
  if (level == 0u) {
    return;
  }
  let cell = vec3u(atomicLoad(&field[row]), atomicLoad(&field[row + 1u]), atomicLoad(&field[row + 2u]));
  var slot = cellHash(cell, level - 1u) & (size - 1u);
  // The weak exchange may fail on a free slot: such a turn tries it again.
  for (var turn = 0u; turn < 2u * size; turn++) {
    let result = atomicCompareExchangeWeak(&field[${FIELD_HEADER_WORDS}u + slot], 0u, index + 1u);
    if (result.exchanged) {
      return;
    }
    if (result.old_value != 0u) {
      slot = (slot + 1u) & (size - 1u);
    }
  }
}
`;

/** Dispatch of indexField for `capacity` outputs, as [x, y]. */
export function indexDispatch(capacity) {
  const groups = Math.ceil(capacity / LANES);
  return [Math.min(groups, MAX_GROUPS), Math.ceil(groups / MAX_GROUPS)];
}
