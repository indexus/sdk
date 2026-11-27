// One slot on the wire. Reads wait their turn.

import { debugEnabled, debugLog } from "../utilities/debug.js";
import { now } from "./helpers.js";

/**
 * @param {"start"|"end"} phase
 * @param {import("../wire/peer.js").Peer | null} peer
 * @param {{
 *   method: string,
 *   ok?: boolean,
 *   ms?: number,
 *   collection?: string,
 *   location?: string,
 *   locations?: string[],
 *   navigation?: string,
 *   refresh?: boolean,
 *   deep?: boolean,
 *   redirects?: number,
 *   reason?: string,
 * }} meta
 */
export function _emitActivity(phase, peer, meta) {
  const ip = meta.ip ?? (peer ? peer.ip() : null);
  const port = meta.port ?? (peer ? peer.port() : null);
  const hash = meta.hash ?? (peer ? peer.hash() : null);
  const host = meta.host ?? (ip != null ? `${ip}|${port}` : null);

  if (meta.method === "getSets") {
    const locs = meta.locations ?? (meta.location ? [meta.location] : []);
    if (phase === "start") {
      this._metrics.onRequestStart({
        locations: locs.length || 1,
        peer: hash,
      });
    } else {
      this._metrics.onRequestEnd({
        ok: meta.ok !== false,
        ms: meta.ms,
        redirects: meta.redirects,
      });
      if (meta.ok !== false && Number.isFinite(meta.bytes)) {
        this._metrics.onPayload({
          bytes: meta.bytes,
          wireBytes: meta.wireBytes,
          rows: meta.rows,
        });
      }
      // No push here. Counters are read on a timer by the Metrics tab;
      // emitting per response put a main-thread React render on every
      // request and that is what made panning stutter.
    }
    if (debugEnabled("sets")) {
      debugLog("sets", phase === "start" ? "wire request" : "wire response", {
        peer: hash,
        host,
        locations: locs,
        navigation: meta.navigation ?? this._readNavigation,
        refresh: meta.refresh === true,
        deep: meta.deep,
        ok: meta.ok,
        ms: meta.ms,
        redirects: meta.redirects,
        reason: meta.reason,
      });
    }
  }

  if (typeof this._onActivity !== "function") return;
  const event = {
    phase,
    method: meta.method,
    hash,
    ip,
    port,
    host,
    ok: meta.ok,
    ms: meta.ms,
    collection: meta.collection,
    location: meta.location,
    locations: meta.locations,
    navigation: meta.navigation,
    refresh: meta.refresh,
    deep: meta.deep,
    redirects: meta.redirects,
    reason: meta.reason,
    bytes: meta.bytes,
    wireBytes: meta.wireBytes,
    rows: meta.rows,
  };
  try {
    this._onActivity(event);
  } catch {
    /* ignore */
  }
}

/**
 * @template T
 * @param {import("../wire/peer.js").Peer} peer
 * @param {string} method
 * @param {() => Promise<T>} fn
 * @param {{
 *   collection?: string,
 *   location?: string,
 *   locations?: string[],
 *   navigation?: string,
 *   refresh?: boolean,
 *   deep?: boolean,
 *   reason?: string,
 * }} [meta]
 * @returns {Promise<T>}
 */
export async function _withActivity(peer, method, fn, meta = {}) {
  const started = now();
  this._emitActivity("start", peer, { method, ...meta });
  try {
    const result = await fn();
    const ms = now() - started;
    const redirects = Array.isArray(result?.redirects) ? result.redirects.length : undefined;
    this._emitActivity("end", peer, {
      method,
      ok: true,
      ms,
      redirects,
      bytes: result?.bytes,
      wireBytes: result?.wireBytes,
      rows: result?.rows,
      ...meta,
    });
    return result;
  } catch (error) {
    this._emitActivity("end", peer, {
      method,
      ok: false,
      ms: now() - started,
      ...meta,
    });
    throw error;
  }
}

/**
 * Run a peer call under the concurrency pool. Keys are unique so the
 * Throttler only limits parallelism (zone coalescing lives in `_inflight`).
 * @template T
 * @param {import("../wire/peer.js").Peer | null} peer
 * @param {string} method
 * @param {() => Promise<T>} fn
 * @param {object} [meta]
 * @returns {Promise<T>}
 */
export function _enqueueWire(peer, method, fn, meta = {}, signal) {
  const key = `${method}:${peer?.hash?.() ?? "?"}:${++this._wireSeq}`;
  return this._throttler.enqueue(key, () => this._withActivity(peer, method, fn, meta), {
    signal,
  });
}

/** Options every API call needs when a same-origin gateway is configured. */
export function _wireOpts(extra = {}) {
  return this._gateway ? { gateway: this._gateway, ...extra } : extra;
}

/**
 * Resolves once the initial bootstrap peer discovery attempt finishes.
 * @returns {Promise<void>}
 */
export function whenReady() {
  return this._ready ?? Promise.resolve();
}

export function getConcurrency() {
  return this._concurrency;
}
