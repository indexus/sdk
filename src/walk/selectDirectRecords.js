import { valueSet } from "./valueSet.js";

// Select from the records the caller already read at known addresses.
// A row's identity is (collection, location, id), so an ID can match
// several addresses. Each output tuple follows the requested column order.
const fields = new Set(["collection", "location", "id", "weight"]);
const isIndex = value => Number.isSafeInteger(value) && value >= 0;

// A payload column names one literal top-level JSON key, including dots.
function columnReader(column) {
  if (isIndex(column)) return row => row.metrics[column] ?? null;
  if (column === "weight") return row => row.weight || 1;
  if (fields.has(column)) return row => row[column];
  if (column && typeof column === "object" && !Array.isArray(column) &&
      Object.hasOwn(column, "payload") && typeof column.payload === "string" &&
      Object.keys(column).length === 1) {
    const key = column.payload;
    return row => {
      const payload = row.payload;
      if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
      return Object.hasOwn(payload, key) ? payload[key] : null;
    };
  }
  throw new TypeError("Expected a metric index, direct record field, or { payload: key }");
}

export function selectDirectRecords(rows, { ids, where, columns }) {
  if (!Array.isArray(columns)) throw new TypeError("Expected an array of columns");
  const readers = Array.from(columns, columnReader);
  const wanted = ids === undefined ? null : valueSet(ids, id => typeof id === "string");
  let allowed = null;
  if (where !== undefined) {
    if (!isIndex(where?.metric)) throw new TypeError("Expected a numeric metric index");
    allowed = valueSet(where.in, Number.isFinite);
  }

  const result = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.id)) continue;
    if (allowed && !allowed.has(row.metrics[where.metric])) continue;
    result.push(readers.map(read => read(row)));
  }
  return result;
}
