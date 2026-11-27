// How the walk combines the columns of the rows it gathers, by kind
// (tree/description.js). Without kinds every column is a sum, as before.
//
//   sum        adds, weighted by a visible fraction where the walk weighs
//   min, max   keep their extreme; a partly visible row counts whole
//   first, last, affine
//              combined in cell order where the walk holds that order (the
//              rows of one zone, its binary levels); NaN where it does not
//              (a viewport weighed by fractions): the walk does not invent
//              an order
//
// The heat (gpu/pack.js) adds the rows of an output, so it reads sum
// columns only.

const ORDERED = new Set(["first", "last", "affine.a", "affine.b"]);

/** Kinds of m columns: the description's, padded with sums. */
export function kindsOf(kinds, m) {
  const out = new Array(m);
  for (let k = 0; k < m; k++) out[k] = kinds?.[k] ?? "sum";
  return out;
}

export function isOrdered(kind) {
  return ORDERED.has(kind);
}

export function hasOrdered(kinds) {
  return Array.isArray(kinds) && kinds.some(isOrdered);
}

/** Whether every column is a sum: the walk's arithmetic is unchanged. */
export function allSums(kinds) {
  return !Array.isArray(kinds) || kinds.every((k) => k === "sum");
}

/** The identity of a column. */
export function identity(kind) {
  return kind === "min" ? Infinity : kind === "max" ? -Infinity : kind === "affine.a" ? 1 : 0;
}

/** Sets columns [offset, offset + kinds.length) of `target` to their identity. */
export function resetColumns(target, offset, kinds) {
  for (let k = 0; k < kinds.length; k++) target[offset + k] = identity(kinds[k]);
}

/**
 * target[toff + k] := target then source, for the m = kinds.length columns.
 * `targetCount` is what the target held before (0: empty, the source is
 * taken as it is); `read(k)` gives the source column k. With `weight` < 1 or
 * `ordered` false, ordered columns become NaN.
 */
export function combineColumns(target, toff, targetCount, read, kinds, weight = 1, ordered = true) {
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k];
    const x = read(k);
    switch (kind) {
      case "sum":
        target[toff + k] = (targetCount === 0 ? 0 : target[toff + k]) + x * weight;
        break;
      case "min":
        target[toff + k] = targetCount === 0 ? x : Math.min(target[toff + k], x);
        break;
      case "max":
        target[toff + k] = targetCount === 0 ? x : Math.max(target[toff + k], x);
        break;
      default: {
        if (!ordered || weight !== 1) {
          target[toff + k] = NaN;
          if (kind === "affine.a") target[toff + ++k] = NaN;
          break;
        }
        if (targetCount === 0) {
          target[toff + k] = x;
          if (kind === "affine.a") target[toff + k + 1] = read(k + 1), k++;
          break;
        }
        if (kind === "last") target[toff + k] = x;
        else if (kind === "affine.a") {
          const a1 = target[toff + k];
          const b1 = target[toff + k + 1];
          target[toff + k] = a1 * x;
          target[toff + k + 1] = x * b1 + read(k + 1);
          k++;
        }
        // first: keep the target
      }
    }
  }
}
