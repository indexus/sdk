import { compareIds } from "./compareIds.js";

function countFacet(records, valueOf, compare) {
  const counts = new Map();
  let matched = 0;
  let missing = 0;
  for (const record of records) {
    const value = valueOf(record);
    matched++;
    if (value == null) missing++;
    else counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const buckets = Array.from(counts, ([value, count]) => ({ value, count }));
  buckets.sort((a, b) => compare(a.value, b.value));
  return { matched, missing, buckets };
}

export function numericFacet(records, valueOf) {
  return countFacet(records, record => {
    const value = valueOf(record);
    return Number.isFinite(value) ? value : null;
  }, (a, b) => a - b);
}

// Count one scalar field on the selected documents. Each value in a field
// shares one type. Null and absent values contribute to the missing count.
export function scalarFacet(records, valueOf) {
  if (typeof valueOf !== "function") throw new TypeError("Expected a facet selector");
  let type;
  return countFacet(records, record => {
    const value = valueOf(record);
    if (value == null) return null;
    const kind = typeof value;
    if (kind !== "string" && kind !== "boolean" && !Number.isFinite(value))
      throw new TypeError("Expected a scalar facet value");
    if (type !== undefined && type !== kind) throw new TypeError("Mixed facet value types");
    type = kind;
    return value;
  }, (a, b) => type === "string" ? compareIds(a, b) : Number(a) - Number(b));
}
