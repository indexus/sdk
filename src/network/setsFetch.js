// Ask the ingress or a peer, and follow a redirect.

import { Peer } from "../wire/peer.js";
import { blocksToElements } from "../wire/block.js";
import { zoneKey, zoneKeyID, parent, ROOT } from "../tree/alphabet.js";
import { abelianTotal } from "../tree/abelian.js";
import { debugEnabled, debugLog, signed } from "../utilities/debug.js";
import { checkRead } from "../utilities/sharedRead.js";
import {
  normalizeNavigation,
  normalizeMetrics,
  transientReadFailure,
  zonesWithRows,
  mergeRawChunks,
} from "./helpers.js";

/**
 * Publish one read wave as the in-flight owner of every zone it covers, so
 * a parallel drill for the same zone joins it instead of duplicating it.
 * @param {string} collection
 * @param {string[]} locations
 * @param {Promise<any>} promise
 * @param {boolean} refresh
 */
export function _trackInflight(collection, locations, read, refresh) {
  const entry = { read, refresh };
  const keys = locations.map((location) => zoneKey(collection, location));
  for (const key of keys) {
    this._inflight.set(key, entry);
  }
  const release = () => {
    for (const key of keys) {
      if (this._inflight.get(key) === entry) this._inflight.delete(key);
    }
  };
  read.controller.signal.addEventListener("abort", release, { once: true });
  const finish = () => {
    read.controller.signal.removeEventListener("abort", release);
    release();
  };
  read.promise.then(finish, finish);
}

/**
 * Single `/sets` wave for one chunk of parent locations (after cache filtering).
 * @param {string} collection
 * @param {string[]} locations
 * @param {boolean} [refresh] - ask the node past its own cache too. Dropping
 *   our cache alone only re-reads the same stale answer.
 * @param {{ navigation?: ReadNavigation, metrics?: "f32" | "f64", signal?: AbortSignal }} [options]
 * @returns {Promise<import("./setsRaw.js").RawChunk>}
 */
export async function _fetchSetsChunk(collection, locations, refresh = false, options = {}) {
  checkRead(options.signal);
  this._maybeDiscoverMesh();
  const navigation = normalizeNavigation(options.navigation ?? this._readNavigation);
  const metrics = normalizeMetrics(options.metrics ?? this._readMetrics);
  const fetch = navigation === "direct" ? this._fetchSetsDirect : this._fetchSetsIngress;
  return fetch.call(this, collection, locations.slice(), refresh, options.signal, metrics);
}

/**
 * Sticky client-key ingress, deep=true, routing-key header + hint adoption.
 */
export async function _fetchSetsIngress(
  collection,
  stillMissing,
  refresh = false,
  signal,
  metrics,
) {
  let attempts = this._attempts;

  while (true) {
    checkRead(signal);
    await this.whenReady();

    let peer = this.ingressPeer();

    if (!peer) {
      await this.discoverPeers();
      peer = this.ingressPeer();
    }

    if (!peer) {
      throw new Error("Failed to find peers with bootstrap hosts.");
    }

    try {
      const answer = await this._enqueueWire(
        peer,
        "getSets",
        () =>
          this._api.getSets(
            this._protocol,
            peer,
            collection,
            stillMissing,
            this._wireOpts({
              signal,
              deep: true,
              refresh,
              envelope: false,
              routingKey: this._routingKey,
              metrics,
            }),
          ),
        {
          collection,
          location: stillMissing[0],
          locations: stillMissing,
          navigation: "ingress",
          refresh,
          deep: true,
          reason: "ingress-chunk",
        },
        signal,
      );

      checkRead(signal);
      this._adoptIngressHint(answer.ingress);
      answer.asked = stillMissing;
      const withRows = zonesWithRows(answer.blocks);
      return {
        responses: [answer],
        empty: stillMissing.filter((location) => !withRows.has(location)),
      };
    } catch (error) {
      checkRead(signal);
      const status = error?.response?.status ?? null;
      if (transientReadFailure(error)) throw error;
      this._table.remove(peer.id());
      if (status === null) {
        this._hintRejected.add(peer.hash());
      }
      this._notifyPeers();
      console.warn(
        `Failed to get sets via peer ${peer.hash()}${
          status === null ? " (unreachable)" : ` (HTTP ${status})`
        }. Retrying with a different peer...`,
      );
      if (debugEnabled("sets")) {
        debugLog("sets", "peer dropped for this read", {
          peer: peer.hash(),
          status,
          blacklisted: status === null,
          locations: stillMissing.length,
          first: stillMissing[0],
          attemptsLeft: attempts - 1,
          navigation: "ingress",
        });
      }

      attempts--;
      if (attempts === 0) {
        throw new Error("Failed to retrieve sets after multiple attempts.");
      }
    }
  }
}

/**
 * Client-managed ownership following: deep=false, IXS1 redirects, regroup by
 * owner, parent-key peer fallback, bounded via. Never relies on server-side
 * inter-node deep reads.
 */
export async function _fetchSetsDirect(collection, stillMissing, _refresh, signal, metrics) {
  await this.whenReady();
  if (!this.ingressPeer()) {
    await this.discoverPeers();
  } else if (this._meshDiscovery && this.listPeers().length < 2) {
    // Bootstrap-only table: XOR guesses miss owners we have not learned yet.
    // Pull neighbors before paying redirect RTTs, throttled (peers.js).
    await this._discoverThinTable();
  }

  /** @type {Map<string, { via: Set<string>, probe: string, peer: import("../wire/peer.js").Peer | null }>} */
  const pending = new Map();
  for (const location of stillMissing) {
    pending.set(location, {
      via: new Set(),
      probe: location,
      peer: null,
    });
  }

  /** @type {import("./setsRaw.js").RawChunk} */
  const out = { responses: [], empty: [] };
  const maxRounds = Math.max(8, this._attempts * stillMissing.length);
  for (let round = 0; round < maxRounds && pending.size > 0; round++) {
    checkRead(signal);
    /** @type {Map<string, { peer: import("../wire/peer.js").Peer, locations: string[], via: string[], metrics?: "f32" | "f64" }>} */
    const groups = new Map();

    for (const [location, state] of pending) {
      let peer = state.peer;
      if (!peer) {
        peer = this._knownOwner(zoneKey(collection, location), state.via);
      }
      if (!peer) {
        const id = zoneKeyID(collection, state.probe);
        peer = this._nearestExcluding(id, state.via);
      }
      if (!peer) {
        // Soft miss: peer table incomplete — do NOT cache []. Discovery may
        // fill the table later; a cached empty would stick forever.
        continue;
      }
      const key = peer.hash();
      let group = groups.get(key);
      if (!group) {
        group = {
          peer,
          locations: [],
          via: [...state.via],
          metrics,
        };
        groups.set(key, group);
      }
      group.locations.push(location);
      for (const name of state.via) {
        if (!group.via.includes(name)) group.via.push(name);
      }
    }

    if (groups.size === 0) break;

    await Promise.all(
      [...groups.values()].map((group) =>
        this._directRound(collection, group, pending, signal, out),
      ),
    );
  }

  // Leftovers that never found a peer stay uncached so a later getSets
  // retries after mesh discovery. Definitive empties (wire answer + no
  // redirect all the way to ROOT) are already cached inside _directRound.
  return out;
}

/**
 * Fold the peers a `/sets` answer named into the routing table, then say which
 * one to ask per location.
 *
 * A batch spans zones, so one answer can name several owners at once — that is
 * the only reason a client can regroup the leftovers and finish in one more
 * round. Every named peer is folded in, not just the ones we are about to
 * follow: a read is how a thin table learns the owners it never met, and a
 * location another group already resolved would otherwise drop its peer on the
 * floor. Peers we failed to reach stay out, so a dead route is not re-pinned.
 *
 * @param {Array<{ location?: string, name?: string, ip?: string, port?: number }> | undefined} redirects
 * @returns {Map<string, import("../wire/peer.js").Peer>} location → peer to ask next
 */
export function _foldRedirects(redirects) {
  /** @type {Map<string, import("../wire/peer.js").Peer>} */
  const byLocation = new Map();
  if (!redirects || redirects.length === 0) return byLocation;

  /** @type {Map<string, import("../wire/peer.js").Peer>} */
  const byName = new Map();
  const known = this._knownHashes();
  let added = 0;

  for (const redirect of redirects) {
    const location = redirect?.location;
    const name = redirect?.name;
    const ip = redirect?.ip;
    const port = Number(redirect?.port);
    if (!location || !name || !ip || !(port > 0)) continue;
    if (this._hintRejected.has(name)) continue;

    let peer = byName.get(name);
    if (!peer) {
      try {
        peer = new Peer(name, { [ip]: null }, port, ip);
      } catch {
        continue;
      }
      byName.set(name, peer);
      if (this._insertPeer(peer, known)) added++;
    }
    byLocation.set(location, peer);
  }

  if (added > 0) {
    // One notify per answer, not per location: a wide batch names many owners.
    this._invalidateEmptySetsCache();
    this._notifyPeers();
    if (debugEnabled("sets")) {
      debugLog("sets", "table learned owners from a read", {
        added,
        named: byName.size,
        locations: byLocation.size,
      });
    }
  }
  return byLocation;
}

/**
 * @param {string} collection
 * @param {{ peer: import("../wire/peer.js").Peer, locations: string[], via: string[], metrics?: "f32" | "f64" }} group
 * @param {Map<string, { via: Set<string>, probe: string, peer: import("../wire/peer.js").Peer | null }>} pending
 * @param {import("./setsRaw.js").RawChunk} out takes the answers that carry
 *   rows, and the zones found empty
 */
export async function _directRound(collection, group, pending, signal, out) {
  const { peer, locations, via, metrics } = group;
  try {
    const answer = await this._enqueueWire(
      peer,
      "getSets",
      () =>
        this._api.getSets(
          this._protocol,
          peer,
          collection,
          locations,
          this._wireOpts({
            signal,
            deep: false,
            readMode: "local",
            envelope: true,
            via,
            metrics,
          }),
        ),
      {
        collection,
        location: locations[0],
        locations,
        navigation: "direct",
        deep: false,
        reason: "direct-round",
      },
      signal,
    );

    checkRead(signal);
    // Blocks go to the caller and only the zone's owner is remembered here.
    answer.asked = locations;
    const withRows = zonesWithRows(answer.blocks);
    const redirectByLoc = this._foldRedirects(answer.redirects);
    if (answer.blocks.length > 0) out.responses.push(answer);
    const settleEmpty = (location) => {
      out.empty.push(location);
      pending.delete(location);
    };

    for (const location of locations) {
      const state = pending.get(location);
      if (!state) continue;
      const cacheKey = zoneKey(collection, location);
      state.via.add(peer.hash());

      if (withRows.has(location)) {
        this._rememberOwner(cacheKey, peer);
        pending.delete(location);
        continue;
      }

      const next = redirectByLoc.get(location);
      if (next) {
        if (state.via.has(next.hash())) {
          // A routing cycle proves no emptiness. Leave the zone unresolved
          // so callers keep their parent and retry after discovery.
          pending.delete(location);
          continue;
        }
        state.peer = next;
        this._metrics.onRedirectFollow();
        if (debugEnabled("sets")) {
          debugLog("sets", "direct redirect follow", {
            location,
            from: peer.hash(),
            to: next.hash(),
            toHost: `${next.ip()}|${next.port()}`,
            via: [...state.via],
          });
        }
        continue;
      }

      // Parent-key peer fallback while still requesting the original location.
      if (state.probe === ROOT) {
        settleEmpty(location);
        continue;
      }
      const nextProbe = parent(state.probe);
      if (!nextProbe) {
        settleEmpty(location);
        continue;
      }
      state.probe = nextProbe;
      state.peer = null;
    }
  } catch (error) {
    checkRead(signal);
    const status = error?.response?.status ?? null;
    if (!transientReadFailure(error)) {
      this._table.remove(peer.id());
      if (status === null) this._hintRejected.add(peer.hash());
      this._notifyPeers();
    }
    for (const location of locations) {
      const state = pending.get(location);
      if (!state) continue;
      state.via.add(peer.hash());
      state.peer = null;
    }
    if (debugEnabled("sets")) {
      debugLog("sets", "direct read failed", {
        peer: peer.hash(),
        status,
        locations: locations.length,
        first: locations[0],
      });
    }
  }
}

/**
 * @param {string} collection
 * @param {{ partialPrefix: Map<string, any[]>, uniqInput: string[] }} waiter
 */
export function _finalizeSetsWaiter(collection, waiter) {
  const out = new Map(waiter.partialPrefix);
  for (const location of waiter.uniqInput) {
    if (out.has(location)) continue;
    const cached = location ? this._touchCacheEntry(zoneKey(collection, location)) : null;
    if (!Array.isArray(cached)) {
      const error = new Error(`Read unavailable for ${collection}/${location}`);
      error.name = "IncompleteReadError";
      error.collection = collection;
      error.location = location;
      throw error;
    }
    out.set(location, cached);
  }
  return out;
}

/**
 * Run one read wave for zones that are neither cached nor in flight.
 * @param {string} collection
 * @param {string[]} locations
 * @param {boolean} refresh
 * @param {{ navigation: ReadNavigation, method: ReadMethod, overridesSession: boolean, metrics?: "f32" | "f64", signal?: AbortSignal }} config
 * @returns {Promise<import("./setsRaw.js").RawChunk>}
 */
export async function _runSetsWave(collection, locations, refresh, config) {
  const { navigation, method, overridesSession, signal, metrics } = config;
  checkRead(signal);
  const options = { navigation, signal, metrics };
  if (method !== "getSet") {
    if (overridesSession) return this._fetchSetsChunk(collection, locations, refresh, options);
    return this._setsPool.submit(collection, new Map(), locations, locations, refresh, signal);
  }
  const parallel = Math.min(this._setsPoolCfg.setsMaxParallelChunks, locations.length);
  const chunks = [];
  for (let i = 0; i < locations.length; i += parallel) {
    const wave = locations.slice(i, i + parallel);
    const read = (location) => this._fetchSetsChunk(collection, [location], refresh, options);
    chunks.push(...(await Promise.all(wave.map(read))));
  }
  return mergeRawChunks(chunks);
}

/**
 * Element reads (`getSets` without `raw`): the cache takes the zones of
 * `zones` that the answers settled, as Items and Sets (wire/block.js
 * blocksToElements). A zone with rows takes its children, an empty one [],
 * an unresolved one nothing. The elements of an answer are built once,
 * whatever the number of callers that share it.
 * @param {string} collection
 * @param {string[]} zones
 * @param {import("./setsRaw.js").RawChunk} chunk
 * @param {boolean} refresh
 */
export function _storeElements(collection, zones, chunk, refresh) {
  const wanted = new Set(zones);
  for (const response of chunk.responses) {
    let byParent = this._elements.get(response);
    if (!byParent) {
      const elements = blocksToElements(collection, response.blocks);
      byParent = distributeElementsByParent(response.asked ?? zones, elements);
      this._elements.set(response, byParent);
    }
    for (const zone of zonesWithRows(response.blocks)) {
      if (!wanted.has(zone)) continue;
      this._storeZone(collection, zone, byParent.get(zone) ?? [], refresh);
      wanted.delete(zone);
    }
  }
  for (const zone of chunk.empty) {
    if (wanted.has(zone)) this._storeZone(collection, zone, [], refresh);
  }
}

/** Caches one zone's children; on a refresh, counts how much its mass moved. */
export function _storeZone(collection, location, bucket, refresh) {
  const cacheKey = zoneKey(collection, location);
  const before = this._cache.get(cacheKey);
  // Skip "was: 0" noise from cold fills / prior invalidate — only report a
  // real move when we had a previous cached answer.
  if (refresh && before !== undefined) {
    const was = abelianTotal(before).count;
    const now = abelianTotal(bucket).count;
    if (now !== was) {
      this._metrics.onZoneDelta(location, now - was);
      if (debugEnabled("refresh")) {
        debugLog("refresh", "zone moved", { location, was, now, delta: signed(now - was) });
      }
    }
  }
  this._putCacheChildren(cacheKey, bucket);
}

/**
 * Splits a merged /sets payload into per-parent buckets using longest-prefix match.
 * Skip falsy parents (e.g. avoid assigning everything under "").
 *
 * Root (`@`) is special: child hashes are bare prefixes (`7`, `a`, …) and do
 * **not** start with `@`. Always match non-root parents first (longest prefix),
 * then fall back to `@` for anything still unclaimed.
 */
function distributeElementsByParent(parentLocations, elements) {
  const uniq = [...new Set(parentLocations)].filter(Boolean);
  const nonRoot = uniq.filter((p) => p !== "@").sort((a, b) => b.length - a.length);
  const hasRoot = uniq.includes("@");
  /** @type {Map<string, Array<import("../tree/item.js").Item | import("../tree/set.js").Set>>} */
  const map = new Map();
  for (let i = 0; i < uniq.length; i++) {
    map.set(uniq[i], []);
  }

  for (let e = 0; e < elements.length; e++) {
    const el = elements[e];
    const h = el.hash();
    if (!h || h === "@") continue;

    let assigned = false;
    for (let p = 0; p < nonRoot.length; p++) {
      const parent = nonRoot[p];
      if (h.length > parent.length && h.startsWith(parent)) {
        map.get(parent).push(el);
        assigned = true;
        break;
      }
    }
    if (!assigned && hasRoot) {
      map.get("@").push(el);
    }
  }

  return map;
}
