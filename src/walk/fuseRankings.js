import { compareIds } from "./compareIds.js";

function nonempty(value, field) {
  if (typeof value !== "string" || !value.length) throw new TypeError(`Invalid ${field}`);
  return value;
}

// Contributions are nonnegative. Sort a private array then compensate for
// roundoff, so permuting the retrieval methods gives identical scores.
function total(parts) {
  let sum = 0;
  let correction = 0;
  for (const x of parts.sort((a, b) => a - b)) {
    const next = sum + x;
    if (!Number.isFinite(next)) throw new RangeError("RRF score overflow");
    correction += sum >= x ? (sum - next) + x : (x - next) + sum;
    sum = next;
  }
  const score = sum + correction;
  if (!Number.isFinite(score)) throw new RangeError("RRF score overflow");
  return score;
}

/** Weighted reciprocal rank fusion on ordered global result lists from one view. */
export function fuseRankings(rankings, { limit = 10, constant = 60, identity = "id" } = {}) {
  if (!Array.isArray(rankings) || rankings.length === 0) throw new TypeError("Expected rankings");
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(constant) || constant < 0) {
    throw new RangeError("Expected a positive limit and nonnegative RRF constant");
  }
  if (identity !== "id" && identity !== "location-id") throw new RangeError("Invalid document identity");
  const parts = new Map();
  const locations = new Map();
  let active = false;
  for (const ranking of rankings) {
    const collection = nonempty(ranking.collection, "collection");
    const snapshot = nonempty(ranking.snapshot, "snapshot");
    if (collection !== rankings[0].collection || snapshot !== rankings[0].snapshot) {
      throw new RangeError("Rankings must share a collection and snapshot");
    }
    const { weight = 1, hits } = ranking;
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError("Invalid ranking weight");
    if (!Array.isArray(hits)) throw new TypeError("Expected ordered hits");
    if (weight === 0) continue;
    active = true;
    const seen = new Set();
    for (const hit of hits) {
      const id = nonempty(hit.id, "document ID");
      let key = id;
      if (identity === "location-id") {
        key = JSON.stringify([nonempty(hit.location, "location"), id]);
      } else if (Object.hasOwn(hit, "location")) {
        const location = nonempty(hit.location, "location");
        if (locations.has(id) && locations.get(id) !== location) {
          throw new RangeError(`Ambiguous document ID ${id}`);
        }
        locations.set(id, location);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      if (!parts.has(key)) parts.set(key, { id, location: hit.location, values: [] });
      parts.get(key).values.push(weight / (constant + seen.size));
    }
  }
  if (!active) throw new RangeError("At least one ranking must have a positive weight");
  const result = Array.from(parts.values(), ({ id, location, values }) =>
    identity === "location-id" ? { id, location, score: total(values) } : { id, score: total(values) });
  result.sort((a, b) => b.score - a.score || compareIds(a.id, b.id) || compareIds(a.location ?? "", b.location ?? ""));
  return result.slice(0, limit);
}
