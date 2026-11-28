// Reduce an iterable of document rows in one pass. Each row counts once,
// regardless of weight. As in numericFacet, only finite Numbers are present.
// Empty or all-missing input has sum 0 and null avg/min/max. Sums use
// compensated binary64 arithmetic. Throw if an intermediate or final sum
// overflows, even when later values might otherwise cancel it.
export function numericStats(records, valueOf) {
  if (typeof valueOf !== "function") throw new TypeError("Expected a numeric selector");
  let matched = 0;
  let present = 0;
  let sum = 0;
  let correction = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const row of records) {
    matched++;
    if (!Number.isSafeInteger(matched))
      throw new RangeError("Document count exceeds safe integer range");
    const value = valueOf(row);
    if (!Number.isFinite(value)) continue;
    const next = sum + value;
    if (!Number.isFinite(next)) throw new RangeError("Numeric sum overflow");
    // Neumaier compensation retains the low-order part of this addition.
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    if (!Number.isFinite(correction)) throw new RangeError("Numeric sum overflow");
    sum = next;
    present++;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  sum += correction;
  if (!Number.isFinite(sum)) throw new RangeError("Numeric sum overflow");
  return {
    matched,
    present,
    missing: matched - present,
    sum,
    avg: present ? sum / present : null,
    min: present ? min : null,
    max: present ? max : null,
  };
}
