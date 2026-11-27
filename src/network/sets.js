// Children of one zone, or of many.

import { zoneKey } from "../tree/alphabet.js";
import { checkRead } from "../utilities/sharedRead.js";

/**
 * Children of one zone — permanent convenience alias over
 * {@link getSets}([location]). Shares wire protocol, cache, and navigation.
 * @param {string} collection
 * @param {string} location
 * @param {{ navigation?: ReadNavigation, method?: ReadMethod, refresh?: boolean }} [options]
 * @returns {Promise<any[]>}
 */
export async function getSet(collection, location, options = {}) {
  const map = await this.getSets(collection, [location], options);
  const bucket = map.get(location);
  return Array.isArray(bucket) ? bucket : [];
}

/**
 * Batch retrieval via GET `/sets` (IXB2). Zones not in the cache are read as raw
 * answers (`_getSetsRaw`, which merges concurrent callers into shared batches), then
 * kept in the LRU cache as Items and Sets. Returns a map parent → children.
 *
 * @param {string} collection
 * @param {string[]} locations
 * @param {{
 *   refresh?: boolean,
 *   navigation?: ReadNavigation,
 *   method?: ReadMethod,
 *   metrics?: "f32" | "f64",
 *   raw?: boolean,
 * }} [options] - `metrics` overrides the session's IXB2 metric width
 *   (`setsPool.metrics`, f32 by default; see wire/block.js). `raw` returns the
 *   IXB2 answers themselves, see `_getSetsRaw` (network/setsRaw.js).
 * @returns {Promise<Map<string, import("../tree/item.js").Item[] | import("../tree/set.js").Set[]>>}
 */
export async function getSets(collection, locations, options = {}) {
  checkRead(options.signal);
  if (options.raw === true) return this._getSetsRaw(collection, locations, options);
  if (!Array.isArray(locations) || locations.length === 0) {
    return new Map();
  }

  const refresh = options.refresh === true;
  // Re-read without deleting the cache entry first (so zone deltas are real).
  const force = options.force === true;
  const uniqInput = [...new Set(locations.map((s) => String(s)))];
  /** @type {Map<string, any[]>} */
  const result = new Map();

  const missingForFetch = [];
  const cachedHits = [];
  const ttlHits = [];
  const now = Date.now();

  for (const location of uniqInput) {
    if (!location) {
      result.set(location, []);
      continue;
    }
    // Include ROOT `@` — Aggregate drills from `@` and child locations do
    // not start with `@` (handled in distributeElementsByParent).
    const cacheKey = zoneKey(collection, location);
    const cached = this._touchCacheEntry(cacheKey);
    if (cached === undefined) {
      missingForFetch.push(location);
    } else if (refresh && (force || !this._refreshWithinTtl(cacheKey, now))) {
      missingForFetch.push(location);
    } else {
      if (refresh) ttlHits.push(location);
      else cachedHits.push(location);
      result.set(location, Array.isArray(cached) ? cached : []);
    }
  }

  if (cachedHits.length) this._metrics.onCacheHit(cachedHits.length);
  if (ttlHits.length) {
    this._metrics.onCacheHit(ttlHits.length, { ttl: true });
  }

  if (missingForFetch.length === 0) {
    // Cache hits are counted in metrics — do not log or push per call. A pan
    // over warm zones is nothing but this branch, and pushing a snapshot
    // here re-rendered the side panel on every cached read.
    return result;
  }

  // The raw read joins the waves already on the wire for these zones and
  // merges concurrent callers; the elements are built here, for the cache.
  let chunk = null;
  let failure = null;
  try {
    chunk = await this._getSetsRaw(collection, missingForFetch, options);
  } catch (error) {
    failure = error;
  }
  checkRead(options.signal);
  if (chunk) this._storeElements(collection, missingForFetch, chunk, refresh);
  // A wave that joined someone else's failure must not mask the zones the
  // other waves did resolve; only a read that produced nothing at all fails.
  if (failure && !this._anyCached(collection, missingForFetch)) throw failure;

  return this._finalizeSetsWaiter(collection, {
    partialPrefix: result,
    uniqInput,
  });
}
