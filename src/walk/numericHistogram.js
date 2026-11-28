// Buckets are [-infinity,b0), [b0,b1), ..., [bLast,+infinity).
function checkBounds(bounds) {
  if (!Array.isArray(bounds) || !bounds.length) throw new TypeError("Expected nonempty histogram bounds");
  let previous = -Infinity;
  for (const value of bounds) {
    if (!Number.isFinite(value) || value <= previous)
      throw new RangeError("Histogram bounds must be finite and strictly increasing");
    previous = value;
  }
}

function addCount(total, value) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value))
    throw new RangeError("Invalid or overflowing histogram count");
  return total + value;
}

function presentCount({ bounds, counts, missing }) {
  checkBounds(bounds);
  if (!Array.isArray(counts) || counts.length !== bounds.length + 1)
    throw new TypeError("Expected one count per histogram bucket");
  let present = 0;
  for (const count of counts) present = addCount(present, count);
  addCount(present, missing);
  return present;
}

function bucketIndex(edges, value) {
  let low = 0, high = edges.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (value < edges[mid]) high = mid;
    else low = mid + 1;
  }
  return low;
}

function hasExtrema(part, present) {
  if (!Object.hasOwn(part,"min") && !Object.hasOwn(part,"max")) return false;
  const { min, max, bounds, counts } = part;
  if (!present && min === null && max === null) return true;
  if (!present || !Number.isFinite(min) || !Number.isFinite(max) || min > max ||
      bucketIndex(bounds,min) !== counts.findIndex(n => n > 0) ||
      bucketIndex(bounds,max) !== counts.findLastIndex(n => n > 0) ||
      (present === 1 && min !== max))
    throw new RangeError("Histogram extrema disagree with bucket counts");
  return true;
}

export function numericHistogram(records, valueOf, bounds, { trackExtrema = false } = {}) {
  if (typeof trackExtrema !== "boolean") throw new TypeError("Expected a boolean trackExtrema");
  checkBounds(bounds);
  if (typeof valueOf !== "function") throw new TypeError("Expected a numeric selector");
  const edges = [...bounds];
  const counts = Array(edges.length + 1).fill(0);
  let missing = 0, matched = 0;
  let min = Infinity, max = -Infinity;
  for (const row of records) {
    matched = addCount(matched, 1);
    const value = valueOf(row);
    if (!Number.isFinite(value)) {
      missing++;
      continue;
    }
    counts[bucketIndex(edges,value)]++;
    if (trackExtrema) {
      min = Math.min(min,value);
      max = Math.max(max,value);
    }
  }
  const histogram = { bounds: edges, counts, missing };
  if (trackExtrema) {
    histogram.min = min === Infinity ? null : min;
    histogram.max = max === -Infinity ? null : max;
  }
  return histogram;
}

export function mergeNumericHistograms(parts) {
  let merged;
  let matched = 0, min = Infinity, max = -Infinity;
  let anyTracked = false, untrackedValues = false;
  for (const part of parts) {
    const present = presentCount(part);
    matched = addCount(matched, present + part.missing);
    if (hasExtrema(part,present)) {
      anyTracked = true;
      if (present) {
        min = Math.min(min,part.min);
        max = Math.max(max,part.max);
      }
    } else if (present) {
      untrackedValues = true;
    }
    if (!merged) {
      merged = { bounds: [...part.bounds], counts: [...part.counts], missing: part.missing };
      continue;
    }
    if (part.bounds.length !== merged.bounds.length || part.bounds.some((x, i) => x !== merged.bounds[i]))
      throw new RangeError("Cannot merge different histogram bounds");
    for (let i = 0; i < merged.counts.length; i++) merged.counts[i] += part.counts[i];
    merged.missing += part.missing;
  }
  if (!merged) throw new RangeError("Expected at least one histogram");
  if (anyTracked && !untrackedValues) {
    merged.min = min === Infinity ? null : min;
    merged.max = max === -Infinity ? null : max;
  }
  return merged;
}

// Report the bucket spanning the nearest rank among finite values (one-based).
// Null endpoints denote unbounded sides and remain JSON-safe.
export function histogramQuantile(histogram, q, { estimate } = {}) {
  if (estimate !== undefined && estimate !== "midpoint")
    throw new RangeError("Expected the midpoint histogram estimate");
  if (!Number.isFinite(q) || q < 0 || q > 1) throw new RangeError("Expected a quantile in [0,1]");
  const present = presentCount(histogram);
  const tracked = hasExtrema(histogram,present);
  if (present === 0) return null;
  const rank = Math.max(1, Math.ceil(q * present));
  let prior = 0;
  for (let i = 0; i < histogram.counts.length; i++) {
    const lastRank = prior + histogram.counts[i];
    if (rank <= lastRank) {
      const lowerInclusive = histogram.bounds[i - 1] ?? null;
      const upperExclusive = histogram.bounds[i] ?? null;
      const interval = { rank, firstRank: prior + 1, lastRank, lowerInclusive, upperExclusive };
      if (estimate === "midpoint") {
        let low = lowerInclusive, high = upperExclusive, upperInclusive = false;
        if (tracked) {
          low = Math.max(low ?? -Infinity, histogram.min);
          upperInclusive = high === null || histogram.max < high;
          high = Math.min(high ?? Infinity, histogram.max);
          if (rank === 1 || rank === present) {
            low = high = rank === 1 ? histogram.min : histogram.max;
            upperInclusive = true;
          }
          interval.estimateRange = { lower: low, upper: high, upperInclusive };
        }
        interval.estimate = bucketMidpoint(low, high, !upperInclusive);
      }
      return interval;
    }
    prior = lastRank;
  }
}

// Midpoint minimizes worst-case absolute error given only two finite edges.
function bucketMidpoint(low, high, upperIsExclusive) {
  if (low === null || high === null) return null;
  const width = high - low;
  const middle = Number.isFinite(width) ? low + width / 2 : low / 2 + high / 2;
  // Binary64 can round the midpoint of adjacent edges to the excluded edge.
  return upperIsExclusive && middle >= high ? low : middle;
}
