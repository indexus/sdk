// Content bytes and terminal records.

import { MAX_CONTENT_RECORDS } from "../api/wire.js";
import { zoneKey, zoneKeyID } from "../tree/alphabet.js";
import { RecordReader } from "./records.js";

export function _recordReader() {
  return (this._records ??= new RecordReader(async (collection, location, options = {}) => {
    if (this._contentRecords) {
      const rows = await this.getContentRecords(collection, location, options.maxItems, options);
      const set = Object.create(null);
      for (const row of rows) {
        if (
          row.collection !== collection ||
          typeof row.location !== "string" ||
          !row.location ||
          row.location.includes(":") ||
          typeof row.id !== "string" ||
          !row.id ||
          !Array.isArray(row.metrics)
        ) {
          throw new Error("Invalid terminal record");
        }
        const key = row.location + ":" + row.id;
        if (Object.hasOwn(set, key)) throw new Error("Duplicate terminal record");
        set[key] = { count: 1, metrics: row.metrics };
      }
      return set;
    }
    await this.whenReady();
    const peer =
      this._knownOwner(zoneKey(collection, location), new Set()) ||
      this._table.nearest(zoneKeyID(collection, location));
    if (!peer) throw new Error("No peer for terminal record read");
    return this._enqueueWire(
      peer,
      "getZone",
      () =>
        this._api.getZone(this._protocol, peer, collection, location, {
          gateway: this._gateway,
          signal: options.signal,
        }),
      { collection, location },
      options.signal,
    );
  }));
}

export async function readContent(collection, location, options = {}) {
  if (typeof options.consume !== "function")
    throw new Error("Content read requires a stream consumer");
  await this.whenReady();
  const peer =
    this._knownOwner(zoneKey(collection, location), new Set()) ||
    this._table.nearest(zoneKeyID(collection, location));
  if (!peer) throw new Error("No peer for content read");
  return this._enqueueWire(
    peer,
    "getContent",
    () =>
      this._api.getContent(this._protocol, peer, collection, location, {
        ...options,
        gateway: this._gateway,
      }),
    { collection, location },
    options.signal,
  );
}

export async function getContentRecords(collection, location, limit = 1000, options = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTENT_RECORDS)
    throw new Error("Invalid content record budget");
  await this.whenReady();
  const peer =
    this._knownOwner(zoneKey(collection, location), new Set()) ||
    this._table.nearest(zoneKeyID(collection, location));
  if (!peer) throw new Error("No peer for content record read");
  return this._enqueueWire(
    peer,
    "getContentRecords",
    () =>
      this._api.getContentRecords(this._protocol, peer, collection, location, limit, {
        gateway: this._gateway,
        signal: options.signal,
      }),
    { collection, location },
    options.signal,
  );
}

export function peekRecords(collection, location) {
  return this._recordReader().peek(collection, location);
}

export function getRecords(collection, location, maxItems = 1000, options = {}) {
  return this._recordReader().load(collection, location, maxItems, options);
}

// Probe one peer's retained zone. Keep this outside terminal record caches:
// a response can be older than the latest writes and a miss is normal.
export async function getCachedZone(collection, location, options = {}) {
  await this.whenReady();
  const peer =
    this._knownOwner(zoneKey(collection, location), new Set()) ||
    this._table.nearest(zoneKeyID(collection, location));
  if (!peer) throw new Error("No peer for cached zone read");
  return this._enqueueWire(
    peer,
    "getCachedZone",
    () => this._api.getCachedZone(this._protocol, peer, collection, location, {
      ...options,
      gateway: this._gateway,
    }),
    { collection, location },
    options.signal,
  );
}
