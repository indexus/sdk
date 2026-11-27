// Children of many zones as the IXB2 answers themselves: the one read path.
// The network follows redirects, remembers owners and merges concurrent
// callers. A raw caller (the heat worker) keeps the blocks; an element read
// (getSets without raw) turns its zones into Items and Sets for `_cache`.

import { zoneKey } from "../tree/alphabet.js";
import { SharedRead, checkRead } from "../utilities/sharedRead.js";
import {
  normalizeNavigation,
  normalizeMethod,
  normalizeMetrics,
  zonesWithRows,
  mergeRawChunks,
} from "./helpers.js";

/**
 * One `/sets` answer to a raw read.
 * @typedef {{
 *   format: "block",
 *   buffer: ArrayBuffer,
 *   blocks: import("../wire/block.js").RowsBlock[],
 *   redirects: import("../wire/block.js").Redirect[],
 * }} RawAnswer
 * @typedef {{ responses: RawAnswer[], empty: string[] }} RawChunk
 *   `empty`: zones a node answered without rows
 */

/**
 * `getSets(collection, locations, {raw: true})`.
 *
 * A zone comes back in one of three states: rows in a block of `responses`
 * (`block.parent`, "" for the root), `empty` (a node answered without rows),
 * or `unresolved` (no peer could be asked, or its read failed: ask again
 * later). An answer is a whole response, so it can carry zones of other
 * callers merged in the same batch; two callers of one zone share the same
 * `buffer`, and transferring it detaches it for both. `format` is always
 * "block" (IXB2), kept for the callers that check it.
 *
 * @param {string} collection
 * @param {string[]} locations
 * @param {object} [options] as `getSets`
 * @returns {Promise<{ format: "block", responses: RawAnswer[], empty: string[], unresolved: string[] }>}
 */
export async function _getSetsRaw(collection, locations, options = {}) {
  const wanted = Array.isArray(locations)
    ? [...new Set(locations.map((location) => String(location)))].filter(Boolean)
    : [];
  if (wanted.length === 0) {
    return { format: "block", responses: [], empty: [], unresolved: [] };
  }

  const refresh = options.refresh === true;
  const navigation = normalizeNavigation(options.navigation ?? this._readNavigation);
  const method = normalizeMethod(options.method ?? this._readMethod);
  const metrics = normalizeMetrics(options.metrics ?? this._readMetrics);

  // reads of other columns are other answers: they never join one another
  const inflightKey = metrics.includes(";") ? `${collection};${metrics}` : collection;
  const joined = new Set();
  const toFetch = [];
  for (const location of wanted) {
    const inflight = this._inflight.get(zoneKey(inflightKey, location));
    if (inflight && !inflight.read.controller.signal.aborted && (inflight.refresh || !refresh)) {
      joined.add(inflight.read);
      this._metrics.onCoalescedJoin(1);
    } else {
      toFetch.push(location);
    }
  }

  if (toFetch.length > 0) {
    // As for elements: a per-call override cannot merge with the session's batch.
    const overridesSession =
      navigation !== this._readNavigation ||
      method !== this._readMethod ||
      metrics !== this._readMetrics;
    const wave = new SharedRead(
      (signal) =>
        this._runSetsWave(collection, toFetch, refresh, {
          signal,
          navigation,
          method,
          overridesSession,
          metrics,
        }),
      options.timeoutMs ?? 15000,
    );
    this._trackInflight(inflightKey, toFetch, wave, refresh);
    joined.add(wave);
  }

  const settled = await Promise.allSettled([...joined].map((read) => read.join(options.signal)));
  checkRead(options.signal);
  const chunks = settled
    .filter((outcome) => outcome.status === "fulfilled")
    .map((outcome) => outcome.value);
  const failure = settled.find((outcome) => outcome.status === "rejected");
  // Like the element read: one failed wave does not hide what the others brought.
  if (failure && chunks.length === 0) throw failure.reason;

  const { responses, empty } = mergeRawChunks(chunks);
  const asked = new Set(wanted);
  const resolved = new Set(empty);
  for (const response of responses) {
    for (const zone of zonesWithRows(response.blocks)) resolved.add(zone);
  }
  return {
    format: "block",
    responses,
    empty: empty.filter((location) => asked.has(location)),
    unresolved: wanted.filter((location) => !resolved.has(location)),
  };
}
