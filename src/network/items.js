// A write tries one peer, then the next.

import { zoneKeyID } from "../tree/alphabet.js";

/**
 * Adds an item to a collection at a specific location in the network.
 * If the operation fails, it retries with a different peer.
 * @param {string} collection - The name of the collection.
 * @param {string} root - The targeted root set.
 * @param {string} location - The location identifier within the collection.
 * @param {number[]} metrics - The metrics of the item to add.
 * @param {string} reference - The unique identifier of the item to add.
 * @returns {Promise<void>}
 */
export async function addItem(collection, root, location, metrics, reference, payload) {
  let attempts = this._attempts;

  const id = zoneKeyID(collection, location);

  while (true) {
    await this.whenReady();

    // A write goes to the peer nearest the zone, not to the read ingress.
    let peer = this._table.nearest(id);

    if (!peer) {
      await this.discoverPeers();
      peer = this._table.nearest(id);
    }

    if (!peer) {
      throw new Error("Failed to find peers with bootstrap hosts.");
    }

    try {
      // Generate a unique key for addItem
      const addItemKey = `addItem:${collection}:${root}:${location}:${reference}`;

      // Wrap the addItem API call with the throttler's enqueue method
      await this._throttler.enqueue(addItemKey, () =>
        this._withActivity(
          peer,
          "addItem",
          () =>
            this._api.addItem(
              this._protocol,
              peer,
              collection,
              root,
              location,
              metrics,
              reference,
              { ...this._wireOpts(), payload },
            ),
          { collection, location },
        ),
      );
      return;
    } catch (error) {
      // If the request fails, remove the peer from the table and retry
      this._table.remove(peer.id());
      this._notifyPeers();
      console.warn(`Failed to add item via peer ${peer.hash()}. Retrying with a different peer...`);

      attempts--;
      if (attempts === 0) {
        // If all attempts fail, throw an error
        throw new Error("Failed to add item after multiple attempts.");
      }
    }
  }
}

/**
 * Delete an item through the peer nearest its zone key.
 * @param {string} collection
 * @param {string} root
 * @param {string} location
 * @param {string} reference
 * @returns {Promise<void>}
 */
export async function deleteItem(collection, root, location, reference) {
  let attempts = this._attempts;
  const id = zoneKeyID(collection, location);

  while (true) {
    await this.whenReady();
    let peer = this._table.nearest(id);

    if (!peer) {
      await this.discoverPeers();
      peer = this._table.nearest(id);
    }
    if (!peer) {
      throw new Error("Failed to find peers with bootstrap hosts.");
    }

    try {
      const key = `deleteItem:${collection}:${root}:${location}:${reference}`;
      await this._throttler.enqueue(key, () =>
        this._withActivity(
          peer,
          "deleteItem",
          () =>
            this._api.deleteItem(
              this._protocol,
              peer,
              collection,
              root,
              location,
              reference,
              this._wireOpts(),
            ),
          { collection, location },
        ),
      );
      this.invalidate(collection, location);
      return;
    } catch (error) {
      this._table.remove(peer.id());
      this._notifyPeers();
      console.warn(
        `Failed to delete item via peer ${peer.hash()}. Retrying with a different peer...`,
      );
      attempts--;
      if (attempts === 0) {
        throw new Error("Failed to delete item after multiple attempts.");
      }
    }
  }
}
