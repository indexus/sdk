export function valueSet(values, valid) {
  if (!Array.isArray(values)) throw new TypeError("Expected an array of selection values");
  const set = new Set();
  for (const value of values) {
    if (!valid(value)) throw new TypeError("Invalid selection value");
    set.add(value);
  }
  return set;
}
