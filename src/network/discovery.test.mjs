/**
 * The node table is shared by both navigations: `direct` refills it from IXS1
 * redirects, `ingress` never sees one, so both lean on `/neighbors`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Network } from "./index.js";
import { Peer } from "../wire/peer.js";
import { decodeFixed, encodeFixed } from "../tree/alphabet.js";
import { withBlocks } from "./stub.testkit.mjs";

const BOOT = "AAAAAAAAAAAAAAAA";
const NODE_B = "BBBBBBBBBBBBBBBB";
const NODE_C = "CCCCCCCCCCCCCCCC";
const HOST = "127.0.0.1|21000";
const COLLECTION = "demoCollection00";

function contact(name, port) {
  return { name, ips: { "127.0.0.1": null }, port, ip: "127.0.0.1" };
}

/**
 * @param {{ neighbors?: object[], withNeighbors?: boolean, onGetSets?: (peer: Peer) => void }} cfg
 */
function stubApi(cfg = {}) {
  const calls = { neighbors: [], sets: [] };
  const api = {
    calls,
    async pingPeer(_protocol, ip, port) {
      return new Peer(BOOT, { [ip]: null }, Number(port), ip);
    },
    async getSets(_protocol, peer) {
      calls.sets.push(peer.hash());
      cfg.onGetSets?.(peer);
      return { elements: [], redirects: [], ingress: null };
    },
  };
  if (cfg.withNeighbors !== false) {
    api.getNeighbors = async (_protocol, peer, origin) => {
      calls.neighbors.push({ peer: peer.hash(), origin });
      return (cfg.neighbors ?? [contact(NODE_B, 21001), contact(NODE_C, 21002)]).map(
        (c) => new Peer(c.name, c.ips, c.port, c.ip),
      );
    };
  }
  return api;
}

async function connected(api, options = {}) {
  const net = new Network("http", withBlocks(api), [HOST], 4, 100, options);
  await net.whenReady();
  return net;
}

/** Let a fire-and-forget discovery settle before asserting on the table. */
async function settled(net) {
  await (net._meshDiscoveryInflight ?? Promise.resolve());
}

test("ingress navigation still learns the mesh through /neighbors", async () => {
  const api = stubApi();
  const net = await connected(api, { navigation: "ingress" });

  assert.equal(net.readOptions().navigation, "ingress");
  assert.deepEqual(
    net
      .listPeers()
      .map((p) => p.hash)
      .sort(),
    [BOOT, NODE_B, NODE_C].sort(),
  );
  assert.equal(api.calls.neighbors.length, 1);
});

test("the discovery origin is cut to peer-id width", async () => {
  // A node buckets /neighbors against its own peer ids and answers an origin
  // of any other width with an empty list, so the session key cannot be sent
  // whole: 16 bytes of routing key, 12 bytes of peer id.
  const api = stubApi();
  const net = await connected(api);

  const { origin } = api.calls.neighbors[0];
  const idWidth = decodeFixed(BOOT).length;
  assert.equal(decodeFixed(origin).length, idWidth);
  assert.equal(origin, encodeFixed(net._routingKey.subarray(0, idWidth)));
});

test("discovered nodes are addressable for reads and writes", async () => {
  const api = stubApi();
  const net = await connected(api, { navigation: "ingress" });
  // Zero seed: the bootstrap peer is the nearest, so a discovered node is only
  // reachable if the table really holds it.
  net._routingKey = decodeFixed(NODE_C);

  assert.equal(net.ingressPeer().hash(), NODE_C);
  await net.getSets(COLLECTION, ["aa"]);
  assert.deepEqual(api.calls.sets, [NODE_C]);
});

test("a node this client cannot reach is not rediscovered", async () => {
  const api = stubApi({
    neighbors: [contact(NODE_B, 21001)],
    onGetSets: (peer) => {
      if (peer.hash() === NODE_B) throw new Error("connection refused");
    },
  });
  const net = await connected(api, {
    navigation: "ingress",
    meshDiscoveryIntervalMs: 0,
  });
  net._routingKey = decodeFixed(NODE_B);
  assert.equal(net.ingressPeer().hash(), NODE_B);

  await net.getSets(COLLECTION, ["aa"]);
  await settled(net);

  assert.equal(net.ingressPeer().hash(), BOOT);
  assert.ok(!net.listPeers().some((p) => p.hash === NODE_B));
});

test("discovery is throttled off the read path", async () => {
  const api = stubApi();
  const net = await connected(api, { meshDiscoveryIntervalMs: 100000 });
  assert.equal(api.calls.neighbors.length, 1);

  await net.getSets(COLLECTION, ["aa"]);
  await net.getSets(COLLECTION, ["bb"]);
  await settled(net);

  assert.equal(api.calls.neighbors.length, 1);
});

test("direct reads on a one-node table ask for neighbors at most once a minute", async () => {
  const api = stubApi({ neighbors: [] });
  const net = await connected(api, { navigation: "direct" });
  await settled(net);
  const before = api.calls.neighbors.length;
  // The stub answers nothing, so the reads end unresolved: only the
  // round trips matter here.
  const read = (zone) => net.getSets(COLLECTION, [zone]).catch(() => null);
  for (const zone of ["aa", "bb", "cc", "dd"]) await read(zone);
  await settled(net);
  assert.equal(net.listPeers().length, 1, "the mesh is one node");
  assert.ok(api.calls.sets.length >= 4);
  assert.ok(api.calls.neighbors.length - before <= 1, "one /neighbors for four reads");

  net._thinDiscoveryAt -= 60000;
  await read("ee");
  await settled(net);
  assert.ok(api.calls.neighbors.length - before <= 2, "asked again after a minute");
  assert.ok(api.calls.neighbors.length > before, "a thin table is still asked");
});

test("meshDiscovery=false keeps the bootstrap-only table", async () => {
  const api = stubApi();
  const net = await connected(api, { meshDiscovery: false });

  await net.getSets(COLLECTION, ["aa"]);
  await settled(net);

  assert.equal(api.calls.neighbors.length, 0);
  assert.deepEqual(
    net.listPeers().map((p) => p.hash),
    [BOOT],
  );
});

test("an API without getNeighbors reads exactly as before", async () => {
  const api = stubApi({ withNeighbors: false });
  const net = await connected(api);

  await net.getSets(COLLECTION, ["aa"]);
  await settled(net);

  assert.deepEqual(
    net.listPeers().map((p) => p.hash),
    [BOOT],
  );
  assert.deepEqual(api.calls.sets, [BOOT]);
});
