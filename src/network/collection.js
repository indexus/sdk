// The description of a collection (tree/description.js), read once from a
// peer and kept: it never changes under its name.
import { zoneKey, zoneKeyID, ROOT } from "../tree/alphabet.js";

/**
 * @param {string} collection
 * @returns {Promise<null | ReturnType<import("../tree/description.js").decodeDescription>>}
 *   null for a legacy collection
 */
export async function collectionDescription(collection, options = {}) {
  this._descriptions ??= new Map();
  let pending = this._descriptions.get(collection);
  if (!pending) {
    pending = (async () => {
      await this.whenReady();
      const peer = this._knownOwner(zoneKey(collection, ROOT), new Set()) || this._table.nearest(zoneKeyID(collection, ROOT));
      if (!peer) throw new Error("No peer for a collection description");
      return this._api.getCollection(this._protocol, peer, collection, { gateway: this._gateway, signal: options.signal });
    })();
    this._descriptions.set(collection, pending);
    // A failed read is not remembered: the next call asks again.
    pending.catch(() => {
      if (this._descriptions.get(collection) === pending) this._descriptions.delete(collection);
    });
  }
  return pending;
}
