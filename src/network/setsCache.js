// Children kept after a read.

import { zoneKey } from "../tree/alphabet.js";
import { putLru, touchLru } from "../utilities/lru.js";
import { now } from "./helpers.js";

/**
 * LRU bump for an existing cache entry; undefined if absent.
 * @param {string} cacheKey
 * @returns {any[] | undefined}
 */
export function _touchCacheEntry(cacheKey) {
  return touchLru(this._cache, cacheKey);
}

/**
 * @param {string} cacheKey
 * @param {any[]} bucket
 *   Refuse to replace a non-empty cached zone with `[]`. Redirect loops /
 *   thin-table misses otherwise erase item values from RAM while the zone
 *   key appears to still exist. Explicit Clear cache still wipes via
 *   `clearSetsCache`.
 */
export function _putCacheChildren(cacheKey, bucket) {
  const next = Array.isArray(bucket) ? bucket : [];
  if (next.length === 0) {
    const previous = this._cache.get(cacheKey);
    if (Array.isArray(previous) && previous.length > 0) {
      // Keep the warm answer; bump LRU so it is not the next eviction.
      this._touchCacheEntry(cacheKey);
      return;
    }
  }
  putLru(this._cache, cacheKey, next, this._cacheSize, (evicted) => {
    this._cacheFetchedAt.delete(evicted);
  });
  this._cacheFetchedAt.set(cacheKey, Date.now());
}

/**
 * True while the cached answer for `cacheKey` is young enough that a
 * `refresh` read may reuse it instead of going back on the wire.
 * @param {string} cacheKey
 * @param {number} now
 */
export function _refreshWithinTtl(cacheKey, now) {
  if (this._refreshTtlMs <= 0) return false;
  const fetchedAt = this._cacheFetchedAt.get(cacheKey);
  return fetchedAt !== undefined && now - fetchedAt < this._refreshTtlMs;
}

/**
 * Drop cached empty `/sets` answers. Used when the peer table grows so
 * soft-misses from an incomplete table can be retried.
 */
export function _invalidateEmptySetsCache() {
  for (const [key, value] of this._cache) {
    if (!Array.isArray(value) || value.length > 0) continue;
    this._cache.delete(key);
    this._cacheFetchedAt.delete(key);
  }
}

/**
 * @param {string} collection
 * @param {string[]} locations
 */
export function _anyCached(collection, locations) {
  for (const location of locations) {
    if (location && this._cache.has(zoneKey(collection, location))) return true;
  }
  return false;
}

/**
 * Drop a single cached `/sets` entry so the next getSets refetches.
 * @param {string} collection
 * @param {string} location
 */
export function invalidate(collection, location) {
  if (collection == null || location == null) return;
  const key = zoneKey(collection, location);
  this._cache.delete(key);
  this._cacheFetchedAt.delete(key);
}

/**
 * Wipe the client `/sets` answer cache so the next getSet(s) hit the wire.
 * Does not remount peers or drop the Network — use for A/B of direct vs
 * ingress / gateway routing without a full Data Refresh.
 *
 * @param {{ owners?: boolean, metrics?: boolean }} [opts]
 *   `owners` (default true) also drops remembered zone→peer pins so direct
 *   re-learns owners via IXS1. `metrics` (default false) resets ReadMetrics.
 */
export function clearSetsCache(opts = {}) {
  const clearOwners = opts.owners !== false;
  const resetMetrics = opts.metrics === true;
  this._cache.clear();
  this._cacheFetchedAt.clear();
  this._inflight.clear();
  this._records?.clear();
  if (clearOwners) this._owners.clear();
  if (resetMetrics) this._metrics.reset();
  this._emitMetrics();
}
