import { glob } from "./glob.js";
import { compareValue } from "./scalarAttributes.js";
import { rangeFilter, epochMillis, finiteNumber } from "./rangeFilter.js";
import { valueSet } from "./valueSet.js";

const isScalar = value => typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);

function requireFunction(fn) {
  if (typeof fn !== "function") throw new TypeError("Expected a selector or predicate function");
}

function matches(predicate, row) {
  const result = predicate(row);
  if (typeof result !== "boolean") throw new TypeError("Expected a boolean predicate result");
  return result;
}

// Validate every element, including any following a successful match.
function anyElement(select, predicate) {
  requireFunction(select);
  return row => {
    const values = select(row);
    if (values == null) return false;
    if (!Array.isArray(values)) throw new TypeError("Expected an array field");
    let found = false;
    for (const value of values) {
      if (!isScalar(value)) throw new TypeError("Expected scalar array elements");
      if (predicate(value)) found = true;
    }
    return found;
  };
}

function orderedElement(select, threshold, accepts) {
  if (typeof threshold !== "string" && !Number.isFinite(threshold))
    throw new TypeError("Expected a string or finite numeric threshold");
  return anyElement(select, value => {
    if (typeof value !== typeof threshold) throw new TypeError("Expected array elements of the threshold's type");
    return accepts(compareValue(value, threshold, 1));
  });
}

export const documentFilter = Object.freeze({
  glob,
  numberRange(select, bounds) { return rangeFilter(select, bounds, finiteNumber); },
  timeRange(select, bounds) { return rangeFilter(select, bounds, epochMillis); },
  and(...predicates) {
    predicates.forEach(requireFunction);
    return row => predicates.every(p => matches(p, row));
  },
  or(...predicates) {
    predicates.forEach(requireFunction);
    return row => predicates.some(p => matches(p, row));
  },
  not(predicate) {
    requireFunction(predicate);
    return row => !matches(predicate, row);
  },
  missing(select) {
    requireFunction(select);
    return row => select(row) == null;
  },
  oneOf(select, values) {
    requireFunction(select);
    const wanted = valueSet(values, value => value === null || isScalar(value));
    return row => {
      const value = select(row);
      if (value == null) return wanted.has(null);
      if (!isScalar(value)) throw new TypeError("Expected a scalar field");
      return wanted.has(value);
    };
  },
  contains(select, wanted) {
    if (!isScalar(wanted)) throw new TypeError("Expected a scalar search value");
    return anyElement(select, value => value === wanted);
  },
  containsAny(select, values) {
    const wanted = valueSet(values, isScalar);
    return anyElement(select, value => wanted.has(value));
  },
  anyLt(select, threshold) { return orderedElement(select, threshold, order => order < 0); },
  anyLte(select, threshold) { return orderedElement(select, threshold, order => order <= 0); },
  anyGt(select, threshold) { return orderedElement(select, threshold, order => order > 0); },
  anyGte(select, threshold) { return orderedElement(select, threshold, order => order >= 0); },
});
