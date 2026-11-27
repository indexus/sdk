// Read options, activity and counters.

import { SetsCoalescePool } from "./setsCoalescePool.js";
import { mergeRawChunks } from "./helpers.js";

/** The coalesce pool: one batch of zones per tick, its answers handed back raw. */
export function _makeSetsPool() {
  const chunkSize = this._readMethod === "getSet" ? 1 : this._setsPoolCfg.setsMaxChunkSize;
  return new SetsCoalescePool({
    maxChunkSize: chunkSize,
    maxParallelChunks: this._setsPoolCfg.setsMaxParallelChunks,
    fetchChunk: (coll, locs, refresh, signal) =>
      this._fetchSetsChunk(coll, locs, refresh, { signal }),
    finalizeWaiter: (_coll, waiter) => mergeRawChunks(waiter.chunks),
  });
}

/**
 * Shared Nearby/Aggregate read configuration.
 * @returns {{ navigation: ReadNavigation, method: ReadMethod }}
 */
export function readOptions() {
  return {
    navigation: this._readNavigation,
    method: this._readMethod,
  };
}

export function setActivityHandler(handler) {
  this._onActivity = typeof handler === "function" ? handler : null;
}

export function setPeersHandler(handler) {
  this._onPeers = typeof handler === "function" ? handler : null;
}

export function setMetricsHandler(handler) {
  this._onMetrics = typeof handler === "function" ? handler : null;
}

/** @returns {object} */
export function readMetrics() {
  return this._metrics.snapshot({
    cacheSize: this._cache.size,
    cacheCapacity: this._cacheSize,
    inflightZones: this._inflight.size,
    navigation: this._readNavigation,
    method: this._readMethod,
    refreshTtlMs: this._refreshTtlMs,
  });
}

/** Push a metrics snapshot to the Aggregate side panel. */
export function _emitMetrics() {
  if (typeof this._onMetrics !== "function") return;
  try {
    this._onMetrics(this.readMetrics());
  } catch {
    /* ignore */
  }
}
