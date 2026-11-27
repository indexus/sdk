// The peer that last answered a zone.

import { putLru } from "../utilities/lru.js";

/**
 * XOR-nearest peer for `id`, skipping peers already on the redirect path.
 * Must not await while peers are temporarily removed from the table.
 * @param {Uint8Array} id
 * @param {Set<string>} viaSet
 * @returns {import("../wire/peer.js").Peer | null}
 */
/**
 * Remember who served a zone, so the next read skips the redirect.
 * @param {string} cacheKey
 * @param {import("../wire/peer.js").Peer} peer
 */
export function _rememberOwner(cacheKey, peer) {
  if (!peer) return;
  putLru(this._owners, cacheKey, peer, this._ownersMax);
}

/**
 * The remembered owner, when it is still a peer we hold and have not
 * already tried on this read.
 * @param {string} cacheKey
 * @param {Set<string>} viaSet
 * @returns {import("../wire/peer.js").Peer | null}
 */
export function _knownOwner(cacheKey, viaSet) {
  const peer = this._owners.get(cacheKey);
  if (!peer) return null;
  if (viaSet && viaSet.has(peer.hash())) return null;
  const held = this._table.nearest(peer.id());
  if (!held || held.hash() !== peer.hash()) {
    this._owners.delete(cacheKey);
    return null;
  }
  return peer;
}

export function _nearestExcluding(id, viaSet) {
  if (!viaSet || viaSet.size === 0) {
    return this._table.nearest(id);
  }
  const removed = [];
  for (const peer of this._table.peers()) {
    if (viaSet.has(peer.hash())) {
      this._table.remove(peer.id());
      removed.push(peer);
    }
  }
  try {
    return this._table.nearest(id);
  } finally {
    for (const peer of removed) {
      this._table.insert(peer.id(), peer);
    }
  }
}
