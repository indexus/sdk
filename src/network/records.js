import { SharedRead, checkRead } from "../utilities/sharedRead.js";
import { Item } from "../tree/item.js";
import { parent, zoneKey } from "../tree/alphabet.js";

const under = (location, prefix) => prefix === "@" || location.startsWith(prefix);

// A cache entry is a complete record list for one prefix, never a projected
// cell. Cached ancestors also answer finer zooms without moving their records.
export class RecordReader {
  constructor(readZone, { maxCachedRecords = 20000, ttlMs = 5000, now = Date.now } = {}) {
    this.readZone = readZone;
    this.maxCachedRecords = maxCachedRecords;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
    this.size = 0;
    this.epoch = 0;
  }

  clear() {
    this.epoch++;
    this.cache.clear();
    this.inflight.clear();
    this.size = 0;
  }

  peek(collection, location) {
    for (let prefix = location; prefix; prefix = parent(prefix)) {
      const key = zoneKey(collection, prefix),
        entry = this.cache.get(key);
      if (!entry) continue;
      this.cache.delete(key);
      this.cache.set(key, entry);
      return {
        records:
          prefix === location
            ? entry.records
            : entry.records.filter((r) => under(r._hash, location)),
        stale: this.now() - entry.at >= this.ttlMs,
      };
    }
    return null;
  }

  async load(collection, location, maxItems = 1000, options = {}) {
    checkRead(options.signal);
    if (!location || !(maxItems > 0) || maxItems > 10000)
      throw new Error("Invalid record read budget");
    const cached = this.peek(collection, location);
    if (cached && !cached.stale) {
      if (cached.records.length > maxItems) throw new Error("Record budget exceeded");
      return cached.records;
    }
    const key = zoneKey(collection, location),
      requestKey = `${key}|${maxItems}`;
    const existing = this.inflight.get(requestKey);
    if (existing && !existing.controller.signal.aborted) return existing.join(options.signal);
    const epoch = this.epoch;
    const task = new SharedRead(
      (signal) =>
        this.read(collection, location, maxItems, signal).then((records) => {
          checkRead(signal);
          if (epoch !== this.epoch) return records;
          this.size -= this.cache.get(key)?.records.length || 0;
          this.cache.delete(key);
          this.cache.set(key, { records, at: this.now() });
          this.size += records.length;
          while (this.size > this.maxCachedRecords || this.cache.size > 8192) {
            const oldest = this.cache.keys().next().value;
            this.size -= this.cache.get(oldest).records.length;
            this.cache.delete(oldest);
          }
          return records;
        }),
      options.timeoutMs ?? 15000,
    );
    this.inflight.set(requestKey, task);
    const release = () => {
      if (this.inflight.get(requestKey) === task) this.inflight.delete(requestKey);
    };
    task.controller.signal.addEventListener("abort", release, { once: true });
    const finish = () => {
      task.controller.signal.removeEventListener("abort", release);
      release();
    };
    task.promise.then(finish, finish);
    return task.join(options.signal);
  }

  async read(collection, location, maxItems, signal) {
    const pending = [location],
      visited = new Set(),
      records = new Map();
    let expectedCount = 0;
    while (pending.length) {
      checkRead(signal);
      const prefix = pending.pop();
      if (visited.has(prefix)) continue;
      visited.add(prefix);
      if (visited.size > 128) throw new Error("Record query budget exceeded");
      const rows = await this.readZone(collection, prefix, { signal, maxItems });
      checkRead(signal);
      let mass = 0;
      for (const [key, value] of Object.entries(rows)) {
        if (!Number.isSafeInteger(value?.count) || value.count < 0)
          throw new Error("Invalid record mass");
        mass += value.count;
        if (mass > maxItems) throw new Error("Record budget exceeded");
        if (value.count === 0) continue;
        const colon = key.indexOf(":");
        if (colon > 0 && colon < key.length - 1 && value.count === 1) {
          const hash = key.slice(0, colon),
            id = key.slice(colon + 1);
          if (!under(hash, prefix)) throw new Error("Record outside requested prefix");
          const identity = JSON.stringify([collection, hash, id]);
          if (!records.has(identity)) {
            const record = new Item(collection, hash, value.metrics, id);
            record._terminal = true;
            records.set(identity, record);
          }
          if (records.size > maxItems) throw new Error("Record budget exceeded");
        } else {
          // Count=1 is still a zone unless an explicit record ID proves otherwise.
          if (colon >= 0 || !under(key, prefix) || key === prefix || key === "@") {
            throw new Error("Unresolved record branch");
          }
          pending.push(key);
          if (pending.length > maxItems) throw new Error("Record query budget exceeded");
        }
      }
      if (prefix === location) expectedCount = mass;
    }
    if (records.size !== expectedCount) throw new Error("Incomplete terminal record inventory");
    return [...records.values()].sort((a, b) => {
      const x = JSON.stringify([a._collection, a._hash, a._id]);
      const y = JSON.stringify([b._collection, b._hash, b._id]);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
}
