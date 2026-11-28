import { exactKnn, squaredDistance, vectorLike } from "./exactKnn.js";

// Each caller-provided centroid defines a list. Keep inserted rows and vectors immutable.
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

  function listFor(row) {
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
    return nearest;
  }

  for (const row of rows) lists[listFor(row)].rows.push(row);

  // New keys only. A failed batch leaves all lists as they were before publication.
  function add(batch) {
    const pending = [];
    for (const row of batch) pending.push({ row, list: listFor(row) });
    for (const { row, list } of pending) lists[list].rows.push(row);
  }

  function search(query, { probes = 1, limit = 10, filter = () => true } = {}) {
    checkWidth(query);
    if (!Number.isSafeInteger(probes) || probes < 1 || probes > lists.length)
      throw new RangeError("IVF probes must be between one and the number of centroids");
    if (typeof filter !== "function") throw new TypeError("Expected a filter predicate");
    const ordered = lists.map(({ center }, i) => ({ i, distance: squaredDistance(query, center, "query") }));
    ordered.sort((a, b) => a.distance - b.distance || a.i - b.i);
    const ends = ordered.slice(0, probes).map(({ i }) => lists[i].rows.length);
    let visitedRows = 0, candidateDistances = 0;
    function* candidates() {
      for (let p = 0; p < probes; p++) {
        const rows = lists[ordered[p].i].rows;
        for (let j = 0; j < ends[p]; j++) {
          const row = rows[j];
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
  return { add, search };
}
