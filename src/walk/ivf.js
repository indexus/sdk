import { exactKnn, squaredDistance, vectorLike } from "./exactKnn.js";

// Each caller-provided centroid defines a list. Rows and their vectors must
// describe one immutable view for the lifetime of this index.
export function buildIvfIndex(rows, centroids) {
  if (!Array.isArray(centroids) || !centroids.length) throw new TypeError("Expected nonempty centroids");
  const width = centroids[0]?.length;
  if (!Number.isSafeInteger(width) || !width) throw new RangeError("Expected positive vector width");

  function checkWidth(vector) {
    if (!vectorLike(vector) || vector.length !== width) throw new RangeError("IVF vector width mismatch");
  }
  const lists = Array.from(centroids, vector => {
    checkWidth(vector);
    for (const x of vector) if (!Number.isFinite(x)) throw new TypeError("Invalid centroid coordinate");
    return { center: Float64Array.from(vector), rows: [] };
  });

  for (const row of rows) {
    if (typeof row.id !== "string" || !row.id ||
        (row.location !== undefined && (typeof row.location !== "string" || !row.location)))
      throw new TypeError("Invalid IVF document key");
    checkWidth(row.vector);
    let nearest = 0, best = Infinity;
    for (let i = 0; i < lists.length; i++) {
      const dist = squaredDistance(row.vector, lists[i].center, row.id);
      if (dist < best) {
        nearest = i;
        best = dist;
      }
    }
    lists[nearest].rows.push(row);
  }

  function search(query, { probes = 1, limit = 10, filter = () => true } = {}) {
    checkWidth(query);
    if (!Number.isSafeInteger(probes) || probes < 1 || probes > lists.length)
      throw new RangeError("IVF probes must be between one and the number of centroids");
    if (typeof filter !== "function") throw new TypeError("Expected a filter predicate");
    const ordered = lists.map(({ center }, i) => ({ i, distance: squaredDistance(query, center, "query") }));
    ordered.sort((a, b) => a.distance - b.distance || a.i - b.i);
    let visitedRows = 0, candidateDistances = 0;
    function* candidates() {
      for (let p = 0; p < probes; p++) {
        for (const row of lists[ordered[p].i].rows) {
          visitedRows++;
          const eligible = filter(row);
          if (typeof eligible !== "boolean") throw new TypeError("Expected a boolean filter result");
          if (eligible) {
            candidateDistances++;
            yield row;
          }
        }
      }
    }
    const hits = exactKnn(candidates(), query, {limit});
    return { hits, centroidDistances: lists.length, candidateDistances, visitedRows };
  }
  return { search };
}
