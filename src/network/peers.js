// Who we know, and who answers first.

import { Peer } from "../wire/peer.js";
import { encodeFixed } from "../tree/alphabet.js";
import { now, commonPrefixBits } from "./helpers.js";

// Display the session seed in the Indexus alphabet, so the UI can
// compare it with the ingress node name.
export function routingKeyHash() {
  return encodeFixed(this._routingKey);
}

export function ingressPeer() {
  return this._table.nearest(this._routingKey);
}

/**
 * @returns {{ hash: string, ip: string, port: number, host: string, ingress: boolean }[]}
 */
export function listPeers() {
  const peers = this._table.peers();
  const ingress = this.ingressPeer();
  const ingressHash = ingress ? ingress.hash() : null;
  const out = [];
  for (let i = 0; i < peers.length; i++) {
    const p = peers[i];
    const hash = p.hash();
    out.push({
      hash,
      ip: p.ip(),
      port: p.port(),
      host: `${p.ip()}|${p.port()}`,
      ingress: ingressHash != null && hash === ingressHash,
    });
  }
  return out;
}

/**
 * Remove one contact from this client's routing table and refuse hints for it
 * for the rest of the session. This is deliberately stronger than a transient
 * remove: discovery and IXS1 answers would otherwise put it straight back.
 * @param {string} hash
 * @returns {boolean} true when the table contained the peer
 */
export function forgetPeer(hash) {
  const name = String(hash || "").trim();
  if (!name) return false;
  this._hintRejected.add(name);

  let removed = false;
  for (const peer of this._table.peers()) {
    if (peer.hash() !== name) continue;
    // Table.remove returns whether the parent branch became empty, not whether
    // this leaf existed; matching the peer above is the membership verdict.
    this._table.remove(peer.id());
    removed = true;
  }
  for (const [key, owner] of this._owners) {
    if (owner?.hash?.() === name) this._owners.delete(key);
  }
  if (removed) this._notifyPeers();
  return removed;
}

export function _notifyPeers() {
  if (typeof this._onPeers !== "function") return;
  try {
    this._onPeers(this.listPeers());
  } catch {
    /* ignore UI bridge errors */
  }
}

// Opportunistic ingress from `/sets` response headers, so a client follows
// mesh growth without discovery pings. Only strictly closer peers are
// adopted: the server ranks against its own table, and trusting it blindly
// would bounce the ingress back and forth.
export function _adoptIngressHint(hint) {
  if (!hint || !hint.name || !hint.ip || !(hint.port > 0)) return;
  if (this._hintRejected.has(hint.name)) return;

  const current = this.ingressPeer();
  if (current && current.hash() === hint.name) return;

  try {
    const next = new Peer(hint.name, { [hint.ip]: null }, hint.port, hint.ip);
    if (current) {
      const currentBits = commonPrefixBits(current.id(), this._routingKey);
      const nextBits = commonPrefixBits(next.id(), this._routingKey);
      if (nextBits <= currentBits) return;
    }
    this._table.insert(next.id(), next);
    this._notifyPeers();
  } catch {
    /* ignore malformed hint */
  }
}

/**
 * Peer hashes currently in the routing table.
 * @returns {Set<string>}
 */
export function _knownHashes() {
  const known = new Set();
  for (const peer of this._table.peers()) known.add(peer.hash());
  return known;
}

/**
 * Route one discovered contact into the table. Peers this client already
 * failed to reach stay out: discovery answers name every node the mesh
 * knows, including ones only reachable from inside it.
 * @param {{ name?: string, hash?: string, ip?: string, port?: number } | import("../wire/peer.js").Peer} contact
 * @param {Set<string>} [known] - hashes already in the table, updated in place
 * @returns {boolean} true when the table gained a peer
 */
export function _insertPeer(contact, known) {
  if (!contact) return false;
  try {
    const peer =
      contact instanceof Peer
        ? contact
        : new Peer(
            contact.name ?? contact.hash,
            contact.ips ?? { [contact.ip]: null },
            Number(contact.port),
            contact.ip,
          );
    const hash = peer.hash();
    if (!hash || !peer.ip() || !(peer.port() > 0)) return false;
    if (this._hintRejected.has(hash)) return false;
    const seen = known ?? this._knownHashes();
    if (seen.has(hash)) return false;
    this._table.insert(peer.id(), peer);
    seen.add(hash);
    return true;
  } catch {
    return false;
  }
}

/**
 * A node buckets `/neighbors` against its own peer ids, so an origin of any
 * other width falls outside every bucket and the answer comes back empty.
 * The session key is wider than a peer id: cut it to the width of the peer
 * being asked.
 * @param {import("../wire/peer.js").Peer} peer
 * @returns {string} Indexus-encoded origin, with the Go peer alphabet and width
 */
export function _discoveryOrigin(peer) {
  return encodeFixed(this._routingKey, peer.hash().length);
}

/**
 * Ask a known node for the peers nearest our session key and fold them into
 * the routing table. One round trip, and the same table both navigations
 * already route reads and writes from.
 * @param {import("../wire/peer.js").Peer | null} [from] - defaults to the ingress peer
 * @returns {Promise<number>} peers added
 */
export async function discoverMesh(from = null) {
  if (typeof this._api.getNeighbors !== "function") return 0;
  const peer = from ?? this.ingressPeer();
  if (!peer) return 0;

  let contacts;
  try {
    contacts = await this._enqueueWire(peer, "getNeighbors", () =>
      this._api.getNeighbors(this._protocol, peer, this._discoveryOrigin(peer), this._wireOpts()),
    );
  } catch {
    // Discovery is opportunistic: a node that cannot answer is still a
    // perfectly good ingress, so nothing is dropped from the table here.
    return 0;
  }

  const known = this._knownHashes();
  let added = 0;
  for (const contact of contacts || []) {
    if (added >= this._meshDiscoveryMax) break;
    if (this._insertPeer(contact, known)) added++;
  }
  if (added > 0) {
    // Soft-miss empties from an incomplete peer table must not stick after
    // we learn new owners — otherwise direct never recovers without Clear cache.
    this._invalidateEmptySetsCache();
    this._notifyPeers();
  }
  return added;
}

/**
 * Refresh the node table at most once per interval, off the read path.
 */
/**
 * A direct read on a thin table (fewer than two peers) asks for neighbors
 * first, but at most once per `_thinDiscoveryMs` (a minute by default): on a
 * one-node mesh the answer stays empty, and asking before every read doubled
 * the round trips. Joins a discovery already on the wire.
 * @returns {Promise<number>} peers added
 */
export function _discoverThinTable() {
  if (this._meshDiscoveryInflight) return this._meshDiscoveryInflight;
  const at = Date.now();
  if (at - this._thinDiscoveryAt < this._thinDiscoveryMs) return Promise.resolve(0);
  this._thinDiscoveryAt = at;
  this._meshDiscoveryAt = at;
  this._meshDiscoveryInflight = this.discoverMesh()
    .catch(() => 0)
    .finally(() => {
      this._meshDiscoveryInflight = null;
    });
  return this._meshDiscoveryInflight;
}

export function _maybeDiscoverMesh() {
  if (!this._meshDiscovery || this._meshDiscoveryInflight) return;
  const at = Date.now();
  if (at - this._meshDiscoveryAt < this._meshDiscoveryIntervalMs) return;
  this._meshDiscoveryAt = at;
  this._meshDiscoveryInflight = this.discoverMesh()
    .catch(() => 0)
    .finally(() => {
      this._meshDiscoveryInflight = null;
    });
}

/**
 * Ping one bootstrap host. The contact is only known once the ping answers,
 * so the activity pair is emitted here rather than through _withActivity.
 * @param {string} host - `ip|port`
 * @returns {Promise<import("../wire/peer.js").Peer | null>} null when unreachable
 */
export async function _pingHost(host) {
  const [ip, port] = host.split("|");
  const meta = { method: "pingPeer", host, ip, port: Number(port) };
  const started = now();

  this._emitActivity("start", null, meta);
  try {
    const peer = await this._api.pingPeer(this._protocol, ip, port, this._wireOpts());
    this._emitActivity("end", peer, { ...meta, ok: true, ms: now() - started });
    return peer;
  } catch {
    this._emitActivity("end", null, { ...meta, ok: false, ms: now() - started });
    console.warn(`Failed to add bootstrap peer with host ${host}.`);
    return null;
  }
}

/**
 * Initializes the network by searching for peers and populating the routing table.
 */
export async function discoverPeers() {
  // Seeds go in before the pings: the first read is then routable without
  // waiting on a round trip, and a session survives a bootstrap host being
  // down. They are contacts we believed in last time, not oracles — a stale
  // one is dropped on its first failure like any other.
  const known = this._knownHashes();
  let seeded = 0;
  for (const contact of this._seedPeers) {
    if (this._insertPeer(contact, known)) seeded++;
  }
  if (seeded > 0) this._notifyPeers();

  const pings = this._hosts.map((host) =>
    this._throttler.enqueue(`pingPeer:${host}`, () => this._pingHost(host)),
  );
  const peers = (await Promise.all(pings)).filter(Boolean);

  if (peers.length === 0 && seeded === 0) {
    console.error("Error initializing peers: no bootstrap host answered.");
    return;
  }
  if (peers.length === 0) {
    console.warn(`No bootstrap host answered; routing on ${seeded} restored peers.`);
  }

  const refreshed = this._knownHashes();
  peers.forEach((peer) => this._insertPeer(peer, refreshed));
  this._notifyPeers();

  // One introduction before the first read, so a session starts with the
  // mesh rather than with its bootstrap hosts.
  if (this._meshDiscovery) {
    this._meshDiscoveryAt = Date.now();
    await this.discoverMesh();
  }
}
