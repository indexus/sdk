// One node session: peers, zones, items and content.
// The cube and the screen do not belong here.

import { Table } from "./table.js";
import { Throttler } from "./throttler.js";
import { ReadMetrics } from "./readMetrics.js";
import {
  normalizeNavigation,
  normalizeMethod,
  normalizeMetrics,
  randomRoutingKey,
} from "./helpers.js";

// The methods of Network, one module per concern; each exports methods only.
import * as session from "./session.js";
import * as wire from "./wire.js";
import * as peers from "./peers.js";
import * as items from "./items.js";
import * as owners from "./owners.js";
import * as setsCache from "./setsCache.js";
import * as setsFetch from "./setsFetch.js";
import * as sets from "./sets.js";
import * as setsRaw from "./setsRaw.js";
import * as contentRead from "./contentRead.js";
import * as collection from "./collection.js";

/** @typedef {import("../api/index.js").API} API */
/** @typedef {"ingress" | "direct"} ReadNavigation */
/** @typedef {"getSet" | "getSets"} ReadMethod */

/**
 * Represents the network abstraction that manages peer-to-peer interactions.
 * This class handles peer selection, retries,
 * and maintaining the routing table with throttled network calls.
 */
class Network {
  /**
   * Constructs a new Network instance.
   * @param {string} protocol - The protocol identifier.
   * @param {API} api - The API instance used for network requests.
   * @param {string[]} hosts - An array of bootstrap hosts to initialize the network.
   * @param {number} concurrency - The maximum number of concurrent network calls.
   * @param {number} cacheSize - The maximum number of sets to keep in the cache.
   * @param {{
   *   setsMaxChunkSize?: number,
   *   setsMaxParallelChunks?: number,
   *   navigation?: ReadNavigation,
   *   method?: ReadMethod,
   *   refreshTtlMs?: number,
   *   meshDiscovery?: boolean,
   *   meshDiscoveryIntervalMs?: number,
   *   thinDiscoveryMs?: number,
   *   meshDiscoveryMax?: number,
   *   gateway?: string,
   *   metrics?: "f32" | "f64",
   * }} [setsPoolOptions] - tuning for merged `/sets` batching and shared read modes.
   *   `gateway` (e.g. `http://127.0.0.1:5173/api/p2p`) routes every peer call
   *   through one origin so the browser is not capped at ~6 sockets per node.
   *   `metrics` is the width of IXB2 metrics, `"f32"` (default) or `"f64"`.
   */
  constructor(protocol, api, hosts, concurrency = 50, cacheSize = 1000, setsPoolOptions = {}) {
    this._protocol = protocol;
    this._api = api;
    this._hosts = hosts;
    this._table = new Table();
    this._attempts = 3;

    this._concurrency = concurrency;

    // Initialize the throttler with the specified concurrency limit.
    // All wire reads (getSets / getNeighbors) take a slot here — the grid
    // asyncPool alone was not enough: Promise.all across peers bypassed it.
    this._throttler = new Throttler(this._concurrency);
    /** Monotonic id so getSets slots are concurrency-limited, not deduped. */
    this._wireSeq = 0;

    // Session seed: the XOR-nearest peer is the read ingress, and every read
    // goes through getSets → ingressPeer(), so a session stays on one node.
    this._routingKey = randomRoutingKey(16);

    // Hinted peers unreachable from this client. Without it the server keeps
    // re-advertising them and the ingress flaps across the whole mesh.
    this._hintRejected = new Set();

    // Zone key → the peer that last answered it with data. The XOR guess does
    // not learn from an IXS1 redirect, so without this the same zone pays the
    // same extra hop on every read. Insertion-ordered, oldest evicted.
    /** @type {Map<string, import("../wire/peer.js").Peer>} */
    this._owners = new Map();
    this._ownersMax = 4096;

    // Initialize the cache with a maximum size
    this._cache = new Map();
    this._cacheSize = cacheSize;
    /** zone key → wall clock of the answer that filled `_cache`. */
    this._cacheFetchedAt = new Map();
    /** zone key → the read wave currently on the wire for that zone. */
    this._inflight = new Map();
    this._metrics = new ReadMetrics();
    /** @type {null | ((snap: object) => void)} */
    this._onMetrics = null;

    const poolCfg = setsPoolOptions && typeof setsPoolOptions === "object" ? setsPoolOptions : {};

    this._contentRecords = poolCfg.contentRecords === true;

    // A zone re-read within this window is served from cache even when the
    // caller asks for `refresh`. The Aggregate repair pass walks the whole
    // visible tree every time it runs, and without a floor those passes chain
    // into a permanent `/sets` storm.
    this._refreshTtlMs =
      Number.isFinite(poolCfg.refreshTtlMs) && poolCfg.refreshTtlMs >= 0
        ? Math.floor(poolCfg.refreshTtlMs)
        : 5000;

    // Contacts a previous session ended on. The SDK does not pick a store — the
    // host app owns that, since this runs in a browser worker and in Node — it
    // only takes them back; apps store what listPeers() and the peers handler give.
    this._seedPeers = Array.isArray(poolCfg.seedPeers) ? poolCfg.seedPeers.filter(Boolean) : [];

    // Both navigations route out of `_table`, but only `direct` refills it as
    // it reads: every IXS1 redirect names an owner. An `ingress` session never
    // sees a redirect, so its table stays at the bootstrap hosts plus whatever
    // the ingress hint happens to name, and the client cannot reach a node it
    // was not handed. `/neighbors` keeps one shared table for both.
    this._meshDiscovery = poolCfg.meshDiscovery !== false;
    this._meshDiscoveryIntervalMs =
      Number.isFinite(poolCfg.meshDiscoveryIntervalMs) && poolCfg.meshDiscoveryIntervalMs >= 0
        ? Math.floor(poolCfg.meshDiscoveryIntervalMs)
        : 30000;
    // A node answers with everything it knows; a browser reaches far fewer
    // than a node does, so the table is bounded rather than mesh-sized.
    this._meshDiscoveryMax =
      Number(poolCfg.meshDiscoveryMax) > 0 ? Math.floor(poolCfg.meshDiscoveryMax) : 64;
    this._meshDiscoveryAt = 0;
    // Thin-table discovery before direct reads (peers.js _discoverThinTable).
    this._thinDiscoveryAt = 0;
    this._thinDiscoveryMs =
      Number.isFinite(poolCfg.thinDiscoveryMs) && poolCfg.thinDiscoveryMs >= 0
        ? Math.floor(poolCfg.thinDiscoveryMs)
        : 60000;
    /** @type {Promise<number> | null} */
    this._meshDiscoveryInflight = null;

    // Same-origin peer gateway (dashboard `/api/p2p/:ip/:port`). Empty = dial the
    // peer IP:port from the browser (CORS / 6-conn-per-host apply).
    // peer host:port directly with `_protocol`.
    this._gateway =
      typeof poolCfg.gateway === "string" && poolCfg.gateway.trim()
        ? poolCfg.gateway.replace(/\/$/, "")
        : null;

    this._readNavigation = normalizeNavigation(poolCfg.navigation);
    this._readMethod = normalizeMethod(poolCfg.method);
    // IXB2 metric width: "f32" (default) or "f64" for collections whose sums
    // must stay exact past 24 bits.
    this._readMetrics = normalizeMetrics(poolCfg.metrics);
    // Parallel HTTP waves used to be hard-capped at 16 even when the Throttler
    // allowed 100 — that serialized fat Aggregate prefetches into many micro
    // waves. Default parallel chunks now track concurrency; chunk size stays
    // modest so a wrong-XOR batch does not redirect hundreds of locations.
    this._setsPoolCfg = {
      setsMaxChunkSize:
        Number(poolCfg.setsMaxChunkSize) > 0 ? Math.floor(poolCfg.setsMaxChunkSize) : 128,
      setsMaxParallelChunks:
        Number(poolCfg.setsMaxParallelChunks) > 0
          ? Math.floor(poolCfg.setsMaxParallelChunks)
          : this._concurrency,
    };
    this._setsPool = this._makeSetsPool();
    /** answer → zone → elements, built once per answer for element reads. */
    this._elements = new WeakMap();

    /** @type {null | ((ev: object) => void)} */
    this._onActivity = null;
    /** @type {null | ((peers: object[]) => void)} */
    this._onPeers = null;

    // Initialize the network by searching for peers (await via whenReady / getSets).
    this._ready = this.discoverPeers();
  }
}

Object.assign(
  Network.prototype,
  session,
  wire,
  peers,
  items,
  owners,
  setsCache,
  setsFetch,
  sets,
  setsRaw,
  contentRead,
  collection,
);

export { Network };
