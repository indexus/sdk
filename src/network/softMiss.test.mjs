/**
 * Soft-miss recovery: when direct cannot pick a peer (incomplete table), it
 * must not cache [] forever — discovery may fill owners later.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Network } from "./index.js";
import { Peer } from "../wire/peer.js";
import { Set as SetEntity } from "../tree/set.js";
import { zoneKey } from "../tree/alphabet.js";
import { withBlocks } from "./stub.testkit.mjs";

const BOOT = "AAAAAAAAAAAAAAAA";
const OWNER = "BBBBBBBBBBBBBBBB";
const HOST = "127.0.0.1|21000";
const COLLECTION = "demoCollection00";
const ZONE = "zzzz";

test("direct soft-miss stays uncached until a peer can answer", async () => {
  const calls = { sets: 0 };

  const api = {
    async pingPeer(_protocol, ip, port) {
      return new Peer(BOOT, { [ip]: null }, Number(port), ip);
    },
    async getNeighbors() {
      return [];
    },
    async getSets(_protocol, peer, _collection, locations) {
      calls.sets += 1;
      if (peer.hash() !== OWNER) {
        return { elements: [], redirects: [], ingress: null };
      }
      return {
        elements: locations.map((location) => new SetEntity(COLLECTION, `${location}0`, 1, [1])),
        redirects: [],
        ingress: null,
      };
    },
  };

  const net = new Network("http", withBlocks(api), [HOST], 4, 100, {
    navigation: "direct",
    method: "getSets",
    meshDiscovery: false,
    refreshTtlMs: 0,
  });
  await net.whenReady();

  // Empty the peer table — classic incomplete-table soft miss.
  for (const peer of [...net._table.peers()]) {
    net._table.remove(peer.id());
  }
  assert.equal(net.listPeers().length, 0);

  await assert.rejects(net.getSets(COLLECTION, [ZONE]), { name: "IncompleteReadError" });
  assert.equal(net._cache.size, 0, "soft miss must not permanently cache empty");

  // Peer table grows (owner appears).
  const owner = new Peer(OWNER, { "127.0.0.1": null }, 21001, "127.0.0.1");
  net._table.insert(owner.id(), owner);

  const warm = await net.getSets(COLLECTION, [ZONE]);
  assert.equal(warm.get(ZONE)?.length, 1, "retry after peers appear succeeds");
  assert.ok(calls.sets >= 1, "owner was dialled");
});

test("a non-empty cached zone is not erased by a later empty wire answer", async () => {
  const api = {
    async pingPeer(_protocol, ip, port) {
      return new Peer(BOOT, { [ip]: null }, Number(port), ip);
    },
    async getNeighbors() {
      return [];
    },
    async getSets(_protocol, _peer, _collection, locations) {
      return {
        elements: locations.map((location) => new SetEntity(COLLECTION, `${location}0`, 3, [3])),
        redirects: [],
        ingress: null,
      };
    },
  };

  const net = new Network("http", withBlocks(api), [HOST], 4, 100, {
    navigation: "direct",
    method: "getSets",
    meshDiscovery: false,
    refreshTtlMs: 0,
  });
  await net.whenReady();

  const warm = await net.getSets(COLLECTION, [ZONE]);
  assert.equal(warm.get(ZONE)?.length, 1);
  const cacheKey = zoneKey(COLLECTION, ZONE);
  assert.equal(net._cache.get(cacheKey)?.length, 1);

  // Simulate a redirect-loop / root-miss empty write.
  net._putCacheChildren(cacheKey, []);
  assert.equal(net._cache.get(cacheKey)?.length, 1, "warm item payload must stay in RAM");

  // Explicit wipe still works.
  net.clearSetsCache();
  assert.equal(net._cache.has(cacheKey), false);
});

test("discoverMesh invalidates cached empties when peers are added", async () => {
  const api = {
    async pingPeer(_protocol, ip, port) {
      return new Peer(BOOT, { [ip]: null }, Number(port), ip);
    },
    async getNeighbors() {
      return [new Peer(OWNER, { "127.0.0.1": null }, 21001, "127.0.0.1")];
    },
    async getSets() {
      return { elements: [], redirects: [], ingress: null };
    },
  };

  const net = new Network("http", withBlocks(api), [HOST], 4, 100, {
    navigation: "direct",
    method: "getSets",
    meshDiscovery: false,
    refreshTtlMs: 0,
  });
  await net.whenReady();

  const cacheKey = zoneKey(COLLECTION, "orphan");
  net._cache.set(cacheKey, []);
  net._cacheFetchedAt.set(cacheKey, Date.now());

  const added = await net.discoverMesh();
  assert.ok(added >= 1, `owner folded into the table (added=${added})`);
  assert.equal(net._cache.has(cacheKey), false, "empty cache entry dropped");
});

for (const navigation of ["direct", "ingress"]) {
  for (const failure of [
    { response: { status: 503 } },
    { response: { status: 429 } },
    { code: "ECONNABORTED" },
  ]) {
    test(`${navigation} retains a healthy owner after transient ${failure.code || failure.response.status}`, async () => {
      let unavailable = true;
      const api = {
        async pingPeer(_protocol, ip, port) {
          return new Peer(BOOT, { [ip]: null }, Number(port), ip);
        },
        async getNeighbors() {
          return [];
        },
        async getSets(_protocol, _peer, _collection, locations) {
          if (unavailable) throw Object.assign(new Error("temporarily busy"), failure);
          return {
            elements: locations.map(
              (location) => new SetEntity(COLLECTION, location + "0", 7, [70]),
            ),
            redirects: [],
          };
        },
      };
      const net = new Network("http", withBlocks(api), [HOST], 4, 100, {
        navigation,
        meshDiscovery: false,
      });
      await net.whenReady();
      await assert.rejects(net.getSets(COLLECTION, [ZONE]));
      assert.equal(net.listPeers().length, 1);
      assert.equal(net._hintRejected.has(BOOT), false);
      assert.equal(net._cache.has(zoneKey(COLLECTION, ZONE)), false);
      unavailable = false;
      assert.equal((await net.getSets(COLLECTION, [ZONE])).get(ZONE)[0].count(), 7);
    });
  }
}
