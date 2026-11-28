// Content bytes and terminal records.

import { MAX_CONTENT_RECORDS } from "../api/wire.js";
import { WIDTH, zoneKey, zoneKeyID } from "../tree/alphabet.js";
import { checkRead } from "../utilities/sharedRead.js";
import { transientReadFailure } from "./helpers.js";
import { RecordReader } from "./records.js";

export function _recordReader() {
  return (this._records ??= new RecordReader(async (collection, location, options = {}) => {
    const direct = this._readNavigation === "direct";
    const point = location.length === WIDTH;
    if (direct || point || this._contentRecords) {
      const rows = direct || point
        ? await this.getPointRecords(collection, location, options.maxItems, options)
        : await this.getContentRecords(collection, location, options.maxItems, options);
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
      if (direct && !point) {
        const groups = await this.getSet(collection, location, { ...options, refresh: true });
        for (const group of groups) {
          const child = group.hash();
          if (child !== location) set[child] = { count: group.count() };
        }
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

// An exact address may also contain records above maximum depth. Callers
// exploring descendants choose those addresses separately.
export async function getPointRecords(collection, location, limit = 1000, options = {}) {
  await this.whenReady();
  const key = zoneKey(collection, location);
  const id = zoneKeyID(collection, location);
  const tried = new Set();
  let peer = this._knownOwner(key, tried);
  let lastError;
  for (let attempt = 0; attempt < this._attempts; attempt++) {
    checkRead(options.signal);
    peer ??= this._nearestExcluding(id, tried);
    if (!peer) break;
    tried.add(peer.hash());
    try {
      const rows = await this._enqueueWire(
        peer,
        "getDirectRecords",
        () =>
          this._api.getDirectRecords(this._protocol, peer, collection, location, limit, {
            ...options,
            gateway: this._gateway,
          }),
        { collection, location },
        options.signal,
      );
      this._rememberOwner(key, peer);
      return rows;
    } catch (error) {
      checkRead(options.signal);
      const status = error?.response?.status;
      if (status !== 409 && error?.code !== "ERR_NETWORK" && !transientReadFailure(error)) throw error;
      lastError = error;
      const contact = error.response?.data?.contact;
      peer = contact ? this._foldRedirects([{ ...contact, location }]).get(location) : null;
      if (peer && tried.has(peer.hash())) peer = null;
    }
  }
  throw lastError ?? new Error("No peer for direct record read");
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
