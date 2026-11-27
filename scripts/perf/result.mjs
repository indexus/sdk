// The common result format of every Indexus performance suite (docs/perf.md).
// No Node import here: the browser pages bundle this file too.

export const SCHEMA = "indexus-perf/1";

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Linear interpolation between closest ranks.
function quantile(sorted, q) {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}

/**
 * Robust dispersion of the samples, in % of their median: one standard
 * deviation estimated as the larger of 1.4826·MAD and IQR/1.349. Both ignore
 * a lone outlier (a GC pause, another process); the IQR also sees samples
 * that jump between two levels, where the MAD can be zero. 0 below three
 * samples: unknown.
 */
export function dispersion(values) {
  if (values.length < 3) return 0;
  const centre = median(values);
  if (centre === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mad = median(values.map((value) => Math.abs(value - centre)));
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  return (100 * Math.max(1.4826 * mad, iqr / 1.349)) / Math.abs(centre);
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toPrecision(6)) : value;
}

/** One metric: value is the median of the samples, noise their dispersion. */
export function metric(name, unit, samples, better = "lower") {
  const list = Array.isArray(samples) ? samples : [samples];
  const out = { name, unit, value: round(median(list)), better };
  if (list.length > 1) {
    out.samples = list.map(round);
    out.noise = round(dispersion(list));
  }
  return out;
}

export function perfResult({
  suite,
  commit = null,
  branch = null,
  date = new Date().toISOString(),
  env = {},
  metrics,
}) {
  return { schema: SCHEMA, suite, commit, branch, date, env, metrics };
}
