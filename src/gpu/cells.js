// Space tables of the GPU kernels: what a kernel needs to turn wire keys into
// Space bounds (docs/layers.md §5). The CPU computes the parent zone once, in
// float64; a kernel decodes only the suffix below it, relative to that origin,
// so float32 stays exact whatever the depth of the parent.
import { ROOT, BITS_PER_CHAR } from "../tree/index.js";

/**
 * Floats per output cell: bounds (2·C), numerator, denominator, zero padding.
 * Fixed so that a render pass reads cells with one stride (two vec4f) for
 * every Space with up to three coordinates.
 */
export const CELL_FLOATS = 8;

export const MAX_COORDINATES = (CELL_FLOATS - 2) / 2;

/**
 * Tables a kernel needs to turn wire keys into Space bounds. Wire keys and
 * Space cells share one alphabet, so a key's 6-bit digit at level l is the
 * cell index shifted by offset(l).
 * @returns {{coordinates: number, maxLevels: number, mask: Uint32Array,
 *   offset: Uint32Array}}
 */
export function spaceTables(space, maxLevels = 32) {
  const coordinates = space.size;
  if (!Number.isInteger(coordinates) || coordinates < 1 || coordinates > MAX_COORDINATES) {
    throw new RangeError(
      `cells: a Space needs 1 to ${MAX_COORDINATES} coordinates, got ${coordinates}`,
    );
  }

  const mask = new Uint32Array(maxLevels * BITS_PER_CHAR);
  const offset = new Uint32Array(maxLevels);
  for (let l = 0; l < maxLevels; l++) {
    for (let n = 0; n < BITS_PER_CHAR; n++) {
      const axis = space.mask.at(l, n);
      if (!Number.isInteger(axis) || axis < 0 || axis >= coordinates) {
        throw new RangeError(`cells: mask.at(${l}, ${n}) = ${axis} is not a coordinate`);
      }
      mask[l * BITS_PER_CHAR + n] = axis;
    }
    const value = space.offset.at(l);
    if (!Number.isInteger(value)) {
      throw new RangeError(`cells: offset.at(${l}) = ${value} is not an integer`);
    }
    offset[l] = ((value % 64) + 64) % 64;
  }

  return { coordinates, maxLevels, mask, offset };
}

/**
 * Bounds of a block's parent zone, in float64, once per block.
 * @returns {Float64Array} 2·C (min, max per coordinate)
 */
export function parentBounds(space, parentLocation) {
  const segments = space.decode(parentLocation || ROOT);
  const bounds = new Float64Array(2 * space.size);
  let at = 0;
  for (const segment of segments) {
    for (const value of segment.value()) {
      bounds[at++] = value;
    }
  }
  return bounds;
}
