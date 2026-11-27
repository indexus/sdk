/**
 * getSets must take a Throttler slot — otherwise Promise.all across peers
 * ignores Network.concurrency and the browser opens unbounded sockets.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Network } from "./index.js";
import { Peer } from "../wire/peer.js";
import { Set as SetEntity } from "../tree/set.js";
import { withBlocks } from "./stub.testkit.mjs";

const NODE = "AAAAAAAAAAAAAAAA";
const HOST = "127.0.0.1|21000";

test("getSets respects the concurrency pool", async () => {
  let inFlight = 0;
  let peak = 0;
  const api = {
    async pingPeer(_protocol, ip, port) {
      return new Peer(NODE, { [ip]: null }, Number(port), ip);
    },
    async getSets(_protocol, _peer, collection, locations) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return {
        elements: (locations || []).map((loc) => new SetEntity(collection, `${loc}0`, 1, [1])),
        redirects: [],
        ingress: null,
      };
    },
  };

  const poolLimit = 3;
  const net = new Network("http", withBlocks(api), [HOST], poolLimit, 100, {
    navigation: "direct",
    method: "getSets",
    meshDiscovery: false,
    refreshTtlMs: 0,
  });
  await net.whenReady();

  // Collection id must be peer-id width (16 chars → 12-byte XOR keys) or
  // `_nearestExcluding` returns null and the round never hits the wire.
  const collection = "demoCollection00";
  // Force distinct wire rounds: different location sets, no cache reuse.
  // Bypass the coalesce pool's single merged chunk so each call needs a slot.
  const jobs = [];
  for (let i = 0; i < 12; i++) {
    jobs.push(
      net.getSets(collection, [`z${i}`], {
        refresh: true,
        force: true,
        // Different method override forces _fetchSetsChunk per call.
        method: "getSet",
      }),
    );
  }
  await Promise.all(jobs);

  assert.ok(peak > 1, `expected parallel getSets (peak ${peak})`);
  assert.ok(peak <= poolLimit, `getSets peak ${peak} exceeded concurrency ${poolLimit}`);
});

test("peerUrl gateway keeps one browser origin and encodes peer IP", async () => {
  const { peerUrl } = await import("../api/transport.js");
  assert.equal(
    peerUrl("http", "10.0.0.1", 21014, "/sets", "http://127.0.0.1:5173/api/p2p"),
    "http://127.0.0.1:5173/api/p2p/10.0.0.1/21014/sets",
  );
  assert.equal(
    peerUrl("http", "51.44.108.166", 21000, "/sets", "http://127.0.0.1:3847/api/p2p"),
    "http://127.0.0.1:3847/api/p2p/51.44.108.166/21000/sets",
  );
  assert.equal(peerUrl("https", "10.0.0.1", 21014, "/sets", null), "https://10.0.0.1:21014/sets");
});

test("content body consumers retain their wire slot until preparation ends", async () => {
  let active = 0,
    peak = 0;
  const api = {
    async pingPeer(_p, ip, port) {
      return new Peer(NODE, { [ip]: null }, Number(port), ip);
    },
    async getContent(_p, _peer, _c, _l, { consume }) {
      active++;
      peak = Math.max(peak, active);
      try {
        return await consume(new Response(new Uint8Array([1])));
      } finally {
        active--;
      }
    },
  };
  const net = new Network("http", withBlocks(api), [HOST], 2, 100, {
    navigation: "direct",
    meshDiscovery: false,
  });
  await net.whenReady();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      net.readContent("demoCollection00", NODE, {
        consume: async (r) => {
          await r.arrayBuffer();
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { value: true, bytes: 1 };
        },
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test("large coalesced reads respect the Go location budget even with an oversized configuration", async () => {
  const sizes = [];
  const api = {
    async pingPeer(_protocol, ip, port) {
      return new Peer(NODE, { [ip]: null }, Number(port), ip);
    },
    async getSets(_protocol, _peer, collection, locations) {
      sizes.push(locations.length);
      return {
        elements: locations.map((location) => new SetEntity(collection, location + "0", 1, [1])),
        redirects: [],
      };
    },
  };
  const net = new Network("http", withBlocks(api), [HOST], 4, 5000, {
    setsMaxChunkSize: 100000,
    meshDiscovery: false,
    navigation: "ingress",
  });
  await net.whenReady();
  const locations = Array.from({ length: 2050 }, (_, i) => i.toString(36).padStart(3, "0"));
  const result = await net.getSets("collection", locations);
  assert.equal(result.size, locations.length);
  assert.equal(
    sizes.reduce((sum, n) => sum + n, 0),
    locations.length,
  );
  assert.ok(sizes.every((n) => n <= 1024));
  assert.equal(sizes.length, 3);
});
