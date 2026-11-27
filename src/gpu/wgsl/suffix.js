// Decoding of IXB2 wire keys, shared by the kernels that read rows blocks
// (gpu/cells.js, gpu/pack.js). Each WGSL function has a JS twin with the same
// arithmetic (suffixDigit here; decodeBits and decodeCell in
// gpu/suffix.testkit.mjs), so the CPU references and the float32 emulations
// follow the kernels step by step.
//
// A key is a bit string read MSB-first across keyWords u32 (wire-block.md,
// "Keys"); suffix character c occupies bits [6c, 6c+6). Wire keys and Space
// cells share one alphabet: the digit r at level l is the Space cell
// (r - offset[l]) mod 64, and bit n of that cell refines coordinate mask[l·6+n].
import { BITS_PER_CHAR } from "../../tree/index.js";

/**
 * WGSL source of the suffix functions. The including shader declares the
 * arrays they read, under the names given here:
 * - `keys`: `array<u32>`, the key words;
 * - `tables`: `array<u32>` holding the spaceTables of gpu/cells.js, mask at
 *   [tablesAt + l·6 + n], offset at [tablesAt + maxLevels·6 + l].
 * `base` is the index of the key's first word in `keys`.
 */
export function suffixWGSL({ keys = "keys", tables = "tables", tablesAt = "0u" } = {}) {
  return /* wgsl */ `
struct SuffixBox {
  lo: array<f32, 3>,
  size: array<f32, 3>,
}

fn suffixDigit(base: u32, c: u32) -> u32 {
  let bit = c * 6u;
  let word = base + (bit >> 5u);
  let shift = bit & 31u;
  var value = ${keys}[word] << shift;
  if (shift > 26u) {
    value = value | (${keys}[word + 1u] >> (32u - shift));
  }
  return value >> 26u;
}

// Bounds of the first bits geometric bits of a key below a parent at depth,
// relative to the parent: lo and size per coordinate, in [0, 1]. The bits of
// one character are the high bits of its cell, so a walk can stop inside a
// character (the binary levels of the Cube).
fn decodeBits(base: u32, bits: u32, depth: u32, maxLevels: u32) -> SuffixBox {
  var box: SuffixBox;
  box.lo = array<f32, 3>(0.0, 0.0, 0.0);
  box.size = array<f32, 3>(1.0, 1.0, 1.0);
  let offsetBase = ${tablesAt} + maxLevels * 6u;
  for (var c = 0u; c * 6u < bits; c++) {
    let level = depth + c;
    let cell = (suffixDigit(base, c) + 64u - ${tables}[offsetBase + level]) & 63u;
    let take = min(6u, bits - c * 6u);
    for (var bit = 0u; bit < take; bit++) {
      let axis = ${tables}[${tablesAt} + level * 6u + bit];
      box.size[axis] = box.size[axis] * 0.5;
      if (((cell >> (5u - bit)) & 1u) == 1u) {
        box.lo[axis] = box.lo[axis] + box.size[axis];
      }
    }
  }
  return box;
}

// Cell of the first bits geometric bits of a key below the parent cell:
// every bit doubles its coordinate. The integer twin of decodeBits, and the
// key two collections of one Space share for one cell (the offset is removed).
fn decodeCell(base: u32, bits: u32, depth: u32, maxLevels: u32, parent: vec3u) -> vec3u {
  var cell = parent;
  let offsetBase = ${tablesAt} + maxLevels * 6u;
  for (var c = 0u; c * 6u < bits; c++) {
    let level = depth + c;
    let digit = (suffixDigit(base, c) + 64u - ${tables}[offsetBase + level]) & 63u;
    let take = min(6u, bits - c * 6u);
    for (var bit = 0u; bit < take; bit++) {
      let axis = ${tables}[${tablesAt} + level * 6u + bit];
      cell[axis] = cell[axis] * 2u + ((digit >> (5u - bit)) & 1u);
    }
  }
  return cell;
}
`;
}

/** 6-bit alphabet index of suffix character c of the key starting at word base. */
export function suffixDigit(keys, base, c) {
  const bit = c * BITS_PER_CHAR;
  const word = base + (bit >>> 5);
  const shift = bit & 31;
  let value = (keys[word] << shift) >>> 0;
  if (shift > 32 - BITS_PER_CHAR) {
    value = (value | (keys[word + 1] >>> (32 - shift))) >>> 0;
  }
  return value >>> (32 - BITS_PER_CHAR);
}
