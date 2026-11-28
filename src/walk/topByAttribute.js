import { compareIds } from "./compareIds.js";
import { TopK } from "./topK.js";

import { checkedCriterion, compareValue } from "./scalarAttributes.js";

function rank(records, limit, read, compare) {
  const top = new TopK(limit, (a, b) =>
    compare(a.value, b.value) || compareIds(a.record.id, b.record.id) ||
    compareIds(a.record.location ?? "", b.record.location ?? ""));
  for (const record of records) {
    if (typeof record.id !== "string" || !record.id) throw new TypeError("Expected a nonempty document ID");
    if (record.location !== undefined && (typeof record.location !== "string" || !record.location))
      throw new TypeError("Invalid document location");
    top.add({ record, value: read(record) });
  }
  return top.finish().map(row => row.record);
}

export function topByAttribute(records, valueOf, { limit = 10, order = "asc", nulls = "last" } = {}) {
  const key = checkedCriterion({ select: valueOf, order, nulls });
  return rank(records, limit, key.read, (x, y) => compareValue(x, y, key.direction, key.nulls));
}

// Each criterion accepts nulls: "first" or "last" (default), independent of order.
export function topByAttributes(records, criteria, { limit = 10 } = {}) {
  if (!Array.isArray(criteria) || !criteria.length) throw new TypeError("Expected at least one sort criterion");
  const keys = Array.from(criteria, checkedCriterion);
  return rank(records, limit, row => keys.map(key => key.read(row)), (a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const result = compareValue(a[i], b[i], keys[i].direction, keys[i].nulls);
      if (result) return result;
    }
    return 0;
  });
}
