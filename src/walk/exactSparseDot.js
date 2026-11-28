import { compareIds } from "./compareIds.js";
import { TopK } from "./topK.js";

function checkVector(vector) {
  if (!Array.isArray(vector)) throw new TypeError("Expected a sparse vector of coordinate pairs");
  let last = -1;
  for (const pair of vector) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError("Expected [index, weight]");
    const [index, weight] = pair;
    if (!Number.isSafeInteger(index) || index <= last)
      throw new RangeError("Sparse indices must be nonnegative, strictly increasing safe integers");
    if (!Number.isFinite(weight)) throw new TypeError("Expected a finite sparse weight");
    last = index;
  }
}

function dot(a, b) {
  let i = 0, j = 0, score = 0;
  while (i < a.length && j < b.length) {
    const [x, left] = a[i], [y, right] = b[j];
    if (x < y) i++;
    else if (y < x) j++;
    else {
      score += left * right;
      i++;
      j++;
    }
  }
  if (!Number.isFinite(score)) throw new RangeError("Sparse dot product overflow");
  return score;
}

// Missing coordinates have weight zero. Rank every supplied candidate,
// including documents with a negative score or no overlapping coordinates.
export function exactSparseDot(candidates, query, { limit = 10 } = {}) {
  checkVector(query);
  const top = new TopK(limit, (a, b) =>
    b.score - a.score || compareIds(a.id, b.id) || compareIds(a.location ?? "", b.location ?? ""));
  for (const { id, location, vector } of candidates) {
    if (typeof id !== "string" || !id) throw new TypeError("Expected a nonempty document ID");
    if (location !== undefined && (typeof location !== "string" || !location))
      throw new TypeError("Invalid document location");
    checkVector(vector);
    const score = dot(query, vector);
    const hit = { id, score };
    if (location !== undefined) hit.location = location;
    top.add(hit);
  }
  return top.finish();
}
