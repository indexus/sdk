// Point overlay of the heat worker: when the view holds at most `maxPoints`
// items, their verified records (network.getRecords, never the lossy /sets
// rows) are drawn as points instead of the heatmap.
import { ROOT } from "../../tree/index.js";
import { CHARS, childLocation } from "../zones.js";
import { terminalPoints } from "./terminalPoints.js";
import { isCanceled } from "../../network/helpers.js";

const MAX_READS = 4;
const RETRY_MS = 2000;

/**
 * @param {object} context space, index (walk), network, collection, options
 *   ({maxPoints, valueMetricIndex}, read live), post, and onRead (a read ended)
 */
export function createPointOverlay({ space, index, network, collection, options, post, onRead }) {
  const reads = new Map();
  const retryAt = new Map();

  /** Children of the deepest loaded zones that meet the view, or null above the budget. */
  function visiblePrefixes(view, threshold) {
    if (!index.get(ROOT)) return null;
    const prefixes = [];
    let total = 0;
    const stack = [ROOT];
    while (stack.length > 0) {
      const zone = stack.pop();
      const summary = index.get(zone);
      for (let r = 0; r < CHARS; r++) {
        const count = summary.children.count[r];
        if (!(count > 0)) continue;
        const child = childLocation(zone, r);
        if (!space.overlap(view, space.decode(child)).overlap) continue;
        if (index.get(child)?.blocks.length > 0) {
          stack.push(child);
          continue;
        }
        total += count;
        if (total > threshold) return null;
        prefixes.push(child);
      }
    }
    return prefixes;
  }

  function position(record) {
    const point = space.center(space.decode(record._hash))?.[0];
    if (Number.isFinite(point?.latitude)) return { lat: point.latitude, lng: point.longitude };
    const values = point?.value?.();
    return values ? { lat: values[0], lng: values[1] } : null;
  }

  function value(record) {
    const count = record._count > 0 ? record._count : 1;
    const metric = record._metrics?.[options.valueMetricIndex];
    return (Number.isFinite(metric) ? metric : 0) / count;
  }

  function read(prefix, threshold) {
    if (reads.has(prefix) || reads.size >= MAX_READS) return;
    if ((retryAt.get(prefix) ?? 0) > Date.now()) return;
    const entry = { prefix, controller: new AbortController() };
    reads.set(prefix, entry);
    network
      .getRecords(collection, prefix, threshold, { signal: entry.controller.signal })
      .then(() => retryAt.delete(prefix))
      .catch((error) => {
        if (!isCanceled(error, entry.controller.signal)) retryAt.set(prefix, Date.now() + RETRY_MS);
      })
      .finally(() => {
        if (reads.get(prefix) === entry) reads.delete(prefix);
        onRead();
      });
  }

  return {
    /**
     * @param {{stats: {totalCount: number}}} plan
     * @param {Array} view Space segments of the visible view
     * @param {number[]} rect the same view, [south, north, west, east]
     */
    overlay(plan, view, rect) {
      const threshold = options.maxPoints;
      const visibleItemCount = Math.round(plan.stats.totalCount);
      const none = { showPoints: false, count: 0, buffer: null, visibleItemCount, threshold };
      if (!visibleItemCount || visibleItemCount > threshold) return none;
      const prefixes = visiblePrefixes(view, threshold);
      if (!prefixes) return none;
      const records = [];
      let complete = true;
      for (const prefix of prefixes) {
        const cached = network.peekRecords(collection, prefix);
        if (!cached || cached.stale) read(prefix, threshold);
        if (cached) records.push(...cached.records);
        else complete = false;
      }
      if (!complete) return { ...none, pending: true };
      try {
        const points = terminalPoints(records, rect, threshold, position, value);
        if (!points.count) return none;
        return { ...points, showPoints: true, visibleItemCount: points.count, threshold };
      } catch (error) {
        if (error?.code !== "POINT_BUDGET") {
          post({ type: "ERROR", payload: `pointOverlay: ${error?.message || error}` });
        }
        return none;
      }
    },

    /** Reads outside `view` (all of them without one) stop, without a retry penalty. */
    cancel(view = null) {
      for (const [prefix, entry] of reads) {
        if (view && space.overlap(view, space.decode(prefix)).overlap) continue;
        entry.controller.abort();
        reads.delete(prefix);
      }
    },
  };
}
