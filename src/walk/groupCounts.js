import { checkedCriterion, compareValue } from "./scalarAttributes.js";

// Count rows from a fixed candidate selection. Each column has a single
// scalar type. Missing values share a null bucket and sort last per column.
function groupingColumns(selectors) {
  if (!Array.isArray(selectors) || !selectors.length)
    throw new TypeError("Expected at least one grouping selector");
  return Array.from(selectors, select => checkedCriterion({ select }));
}

export function groupCounts(records, selectors, { offset = 0, limit } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)))
    throw new RangeError("Expected nonnegative safe integer group offset and limit");
  const columns = groupingColumns(selectors);
  const groups = new Map();
  for (const record of records) {
    const values = columns.map(column => {
      const value = column.read(record);
      return value === 0 ? 0 : value; // Canonicalize negative zero.
    });
    // With finite numbers, strings, booleans and null, JSON arrays preserve
    // column boundaries and types even for strings containing separators.
    const key = JSON.stringify(values);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { values, count: 1 });
  }
  const ordered = [...groups.values()].sort((a, b) => {
    for (let i = 0; i < columns.length; i++) {
      const order = compareValue(a.values[i], b.values[i], 1);
      if (order) return order;
    }
    return 0;
  });
  if (!offset && limit === undefined) return ordered;
  return ordered.slice(offset, limit === undefined ? undefined : offset + limit);
}

// Input order defines rank. Apply this to the full ranked candidate stream
// so lower-ranked groups can fill the result after another group hits its cap.
export function limitPerGroup(ranked, selectors, { perGroup, limit }) {
  const columns = groupingColumns(selectors);
  if (!Number.isSafeInteger(perGroup) || perGroup < 1 ||
      !Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError("Expected a positive group limit and a nonnegative total limit");
  const result = [];
  if (limit === 0) return result;
  const counts = new Map();
  for (const row of ranked) {
    const key = JSON.stringify(columns.map(column => column.read(row)));
    const count = counts.get(key) ?? 0;
    if (count === perGroup) continue;
    counts.set(key, count + 1);
    result.push(row);
    if (result.length === limit) break;
  }
  return result;
}
