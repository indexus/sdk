/**
 * seedPeers: the node table a previous session ended on, handed back so the
 * first read of the next one is routable without waiting on discovery.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Network } from "./index.js";
import { Peer } from "../wire/peer.js";
import { Set as SetEntity } from "../tree/set.js";
import { withBlocks } from "./stub.testkit.mjs";

const BOOT = "AAAAAAAAAAAAAAAA";
const OWNER = "BBBBBBBBBBBBBBBB";
const HOST = "127.0.0.1|21000";
const COLLECTION = "demoCollection00";

function stubApi({ answerPing = true } = {}) {
  const requests = [];
  return {
    requests,
    async pingPeer(_protocol, ip, port) {
      if (!answerPing) throw new Error("unreachable");
      return new Peer(BOOT, { [ip]: null }, Number(port), ip);
    },
    async getSets(_protocol, peer, collection, locations) {
      requests.push({ peer: peer.hash(), locations: [...locations] });
      if (peer.hash() !== OWNER) {
        return { elements: [], redirects: [], ingress: null };
      }
      return {
        elements: locations.map((location) => new SetEntity(collection, `${location}X`, 1, [1])),
        redirects: [],
        ingress: null,
      };
    },
  };
}

function connect(api, seedPeers) {
  return new Network("http", withBlocks(api), [HOST], 4, 100, {
    navigation: "direct",
    method: "getSets",
    meshDiscovery: false,
    refreshTtlMs: 0,
    seedPeers,
  });
}

test("a restored table is routable on the first read", async () => {
  const api = stubApi();
  const net = connect(api, [{ name: OWNER, ip: "10.0.0.2", port: 21002 }]);
  await net.whenReady();

  assert.deepEqual(
    net
      .listPeers()
      .map((p) => p.hash)
      .sort(),
    [BOOT, OWNER].sort(),
    "seed and bootstrap both in the table",
  );

  const map = await net.getSets(COLLECTION, ["aa"]);
  assert.deepEqual(
    map.get("aa")?.map((c) => c.hash()),
    ["aaX"],
  );
  assert.ok(
    api.requests.some((r) => r.peer === OWNER),
    "the restored owner was asked without any discovery round",
  );
});

test("a session survives bootstrap hosts being down when a table was restored", async () => {
  const api = stubApi({ answerPing: false });
  const net = connect(api, [{ name: OWNER, ip: "10.0.0.2", port: 21002 }]);
  await net.whenReady();

  assert.deepEqual(
    net.listPeers().map((p) => p.hash),
    [OWNER],
  );
  const map = await net.getSets(COLLECTION, ["aa"]);
  assert.deepEqual(
    map.get("aa")?.map((c) => c.hash()),
    ["aaX"],
  );
});

test("listPeers round-trips through seedPeers, as the dashboard stores it", async () => {
  const api = stubApi();
  const first = connect(api, [{ name: OWNER, ip: "10.0.0.2", port: 21002 }]);
  await first.whenReady();

  // dashboard peerStore keeps {name, ip, port} of each listPeers() entry.
  const snapshot = first.listPeers().map(({ hash, ip, port }) => ({ name: hash, ip, port }));
  assert.deepEqual(snapshot.map((p) => p.name).sort(), [BOOT, OWNER].sort());
  for (const peer of snapshot) {
    assert.ok(peer.ip, "snapshot carries an address");
    assert.ok(peer.port > 0);
  }

  const second = connect(stubApi(), snapshot);
  await second.whenReady();
  assert.deepEqual(
    second
      .listPeers()
      .map((p) => p.hash)
      .sort(),
    snapshot.map((p) => p.name).sort(),
  );
});

test("malformed and duplicate seeds are ignored, not thrown", async () => {
  const api = stubApi();
  const net = connect(api, [
    { name: OWNER, ip: "10.0.0.2", port: 21002 },
    { name: OWNER, ip: "10.0.0.9", port: 21009 },
    { name: "", ip: "10.0.0.3", port: 21003 },
    { name: "CCCCCCCCCCCCCCCC", ip: "", port: 21004 },
    { name: "DDDDDDDDDDDDDDDD", ip: "10.0.0.5", port: 0 },
    null,
  ]);
  await net.whenReady();

  assert.deepEqual(
    net
      .listPeers()
      .map((p) => p.hash)
      .sort(),
    [BOOT, OWNER].sort(),
  );
});

// Seeds land during construction, when nothing has failed yet — a stale one is
// meant to cost one dial. What must not happen is it coming back afterwards:
// discoverPeers runs again on the write and read fallbacks.
test("a seed that turned out unreachable is not restored again", async () => {
  const api = stubApi();
  const net = connect(api, [{ name: OWNER, ip: "10.0.0.2", port: 21002 }]);
  await net.whenReady();
  assert.equal(net.listPeers().length, 2);

  // What _directRound does to a peer that would not answer.
  const owner = net.listPeers().find((p) => p.hash === OWNER);
  assert.ok(owner, "seed was in the table to begin with");
  net._table.remove(new Peer(OWNER, { "10.0.0.2": null }, 21002, "10.0.0.2").id());
  net._hintRejected.add(OWNER);

  await net.discoverPeers();
  assert.deepEqual(
    net.listPeers().map((p) => p.hash),
    [BOOT],
  );
});

test("forgetPeer removes contact and owner pins for the session", async () => {
  const net = connect(stubApi(), [{ name: OWNER, ip: "10.0.0.2", port: 21002 }]);
  await net.whenReady();
  const owner = net._table.peers().find((peer) => peer.hash() === OWNER);
  net._owners.set("demo/aa", owner);

  assert.equal(net.forgetPeer(OWNER), true);
  assert.ok(!net.listPeers().some((peer) => peer.hash === OWNER));
  assert.equal(net._owners.has("demo/aa"), false);
  assert.equal(net._hintRejected.has(OWNER), true);
});

test("a manually forgotten bootstrap is not re-added by discoverPeers", async () => {
  const net = connect(stubApi(), []);
  await net.whenReady();
  assert.deepEqual(
    net.listPeers().map((peer) => peer.hash),
    [BOOT],
  );

  assert.equal(net.forgetPeer(BOOT), true);
  assert.deepEqual(net.listPeers(), []);
  await net.discoverPeers();
  assert.deepEqual(net.listPeers(), []);
});
