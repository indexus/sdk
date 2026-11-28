import { compareIds } from "./compareIds.js";

export function checkedCriterion({ select, order = "asc", nulls = "last" }) {
  if (typeof select !== "function") throw new TypeError("Expected an attribute selector");
  if (order !== "asc" && order !== "desc") throw new RangeError("Expected asc or desc");
  if (nulls !== "first" && nulls !== "last") throw new RangeError("Expected nulls first or last");
  let type;
  return {
    read(record) {
      const value = select(record);
      if (value == null) return null;
      const kind = typeof value;
      if (!Number.isFinite(value) && kind !== "string" && kind !== "boolean")
        throw new TypeError("Invalid attribute value");
      if (type !== undefined && type !== kind)
        throw new TypeError("Attribute values must have one scalar type");
      type = kind;
      return value;
    },
    direction: order === "asc" ? 1 : -1,
    nulls,
  };
}

export function compareValue(x, y, direction, nulls = "last") {
  if (x === y) return 0;
  if (x === null) return nulls === "first" ? -1 : 1;
  if (y === null) return nulls === "first" ? 1 : -1;
  const order = typeof x === "string" ? compareIds(x, y) : (x < y ? -1 : 1);
  return direction * order;
}
