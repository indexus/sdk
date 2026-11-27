// JS twins of the WGSL decodeBits and decodeCell of gpu/wgsl/suffix.js, same
// arithmetic, for the CPU references and float32 emulations of the kernels.
// Test-only: the SDK itself decodes keys on the GPU.
import { BITS_PER_CHAR } from "../tree/index.js";
import { suffixDigit } from "./wgsl/suffix.js";

/**
 * JS twin of decodeBits: fills lo (0) and size (1) per coordinate.
 * `round` is identity for float64 references and Math.fround for float32
 * emulations; halving is exact either way.
 */
export function decodeBitsInto(keys, base, bits, depth, tables, lo, size, round) {
  lo.fill(0);
  size.fill(1);
  const { mask, offset } = tables;
  for (let c = 0; c * BITS_PER_CHAR < bits; c++) {
    const level = depth + c;
    const cell = (suffixDigit(keys, base, c) + 64 - offset[level]) & 63;
    const take = Math.min(BITS_PER_CHAR, bits - c * BITS_PER_CHAR);
    for (let bit = 0; bit < take; bit++) {
      const axis = mask[level * BITS_PER_CHAR + bit];
      size[axis] *= 0.5;
      if ((cell >> (BITS_PER_CHAR - 1 - bit)) & 1) {
        lo[axis] = round(lo[axis] + size[axis]);
      }
    }
  }
}

/** JS twin of decodeCell: refines `cell` (Uint32Array, the parent's on entry) in place. */
export function decodeCellInto(keys, base, bits, depth, tables, cell) {
  const { mask, offset } = tables;
  for (let c = 0; c * BITS_PER_CHAR < bits; c++) {
    const level = depth + c;
    const digit = (suffixDigit(keys, base, c) + 64 - offset[level]) & 63;
    const take = Math.min(BITS_PER_CHAR, bits - c * BITS_PER_CHAR);
    for (let bit = 0; bit < take; bit++) {
      const axis = mask[level * BITS_PER_CHAR + bit];
      cell[axis] = cell[axis] * 2 + ((digit >> (BITS_PER_CHAR - 1 - bit)) & 1);
    }
  }
}
