import { compareIds } from "./compareIds.js";
import { TopK } from "./topK.js";

export function vectorLike(v) {
  return Array.isArray(v) || (ArrayBuffer.isView(v) && Number.isSafeInteger(v.length));
}

export function squaredDistance(vector, query, id) {
  let sum = 0;
  for (let i = 0; i < query.length; i++) {
    if (!Number.isFinite(vector[i])) throw new TypeError(`Invalid vector coordinate for ${id}`);
    const delta = vector[i] - query[i];
    sum += delta * delta;
  }
  if (!Number.isFinite(sum)) throw new RangeError(`Squared distance overflow for ${id}`);
  return sum;
}

// Scaling before squaring keeps both subnormal and near-maximum inputs usable.
function unitVector(vector, out, label) {
  let scale = 0;
  for (const x of vector) {
    if (!Number.isFinite(x)) throw new TypeError(`Invalid vector coordinate for ${label}`);
    scale = Math.max(scale, Math.abs(x));
  }
  if (scale === 0) throw new RangeError(`Cosine distance needs a nonzero vector for ${label}`);
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    out[i] = vector[i] / scale;
    sum += out[i] * out[i];
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < out.length; i++) out[i] /= norm;
}

// Half the squared chord length equals 1 - cosine and retains small angles.
function cosineDistance(vector, unitQuery, scratch, id) {
  unitVector(vector, scratch, id);
  let sum = 0;
  for (let i = 0; i < scratch.length; i++) {
    const delta = scratch[i] - unitQuery[i];
    sum += delta * delta;
  }
  return Math.min(2, sum / 2);
}

/** Exact top-k over the caller's eligible candidates, ordered by distance then key. */
export function exactKnn(candidates, query, { limit = 10, metric = "l2_squared" } = {}) {
  if (metric !== "l2_squared" && metric !== "cosine") throw new RangeError("Unknown kNN metric");
  const cosine = metric === "cosine";
  const field = cosine ? "cosine_distance" : "distance_squared";
  const hits = new TopK(limit, (a, b) => a[field] - b[field] ||
    compareIds(a.id, b.id) || compareIds(a.location ?? "", b.location ?? ""));
  if (!vectorLike(query) || query.length === 0) throw new TypeError("Expected a nonempty query vector");
  let unitQuery, scratch;
  if (cosine) {
    unitQuery = new Float64Array(query.length);
    scratch = new Float64Array(query.length);
    unitVector(query, unitQuery, "query");
  } else {
    for (const x of query) {
      if (!Number.isFinite(x)) throw new TypeError("Expected finite query coordinates");
    }
  }

  for (const { id, location, vector } of candidates) {
    if (typeof id !== "string" || !id) throw new TypeError("Expected a nonempty document ID");
    if (location !== undefined && (typeof location !== "string" || !location)) throw new TypeError("Invalid document location");
    if (!vectorLike(vector) || vector.length !== query.length) throw new RangeError(`Vector width mismatch for ${id}`);
    const distance = cosine ? cosineDistance(vector, unitQuery, scratch, id) : squaredDistance(vector, query, id);
    if (hits.cutoff && distance > hits.cutoff[field]) continue;
    const hit = { id, [field]: distance };
    if (location !== undefined) hit.location = location;
    hits.add(hit);
  }
  return hits.finish();
}
