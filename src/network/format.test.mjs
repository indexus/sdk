// The IXB2 metric width is a session option (`setsPool.metrics`, f32 by
// default) that reaches the wire call through the coalesce pool; a per-call
// `metrics` still works, and only bypasses the pool when it differs.

import test from "node:test";
import assert from "node:assert/strict";

import { Network } from "./index.js";
import { Peer } from "../wire/peer.js";
import { Set } from "../tree/index.js";
import { withBlocks } from "./stub.testkit.mjs";

const BOOT = "AAAAAAAAAAAAAAAA";
// 16 characters, so a zone id has the width of a peer id.
const COLLECTION = "demoCollection00";

function stubApi() {
  const widths = [];
  const api = {
    widths,
    async pingPeer(_protocol, ip, port) {
      return new Peer(BOOT, { [ip]: null }, Number(port), ip);
    },
    async getNeighbors() {
      return [];
    },
    async getSets(_protocol, _peer, _collection, locations, options) {
      widths.push(options.metrics);
      // A child per zone, so a direct read settles on its first peer.
      const elements = locations.map((location) => new Set(COLLECTION, `${location}x`, 2, []));
      return { elements, redirects: [], ingress: null };
    },
  };
  return api;
}

for (const navigation of ["ingress", "direct"]) {
  test(`${navigation}: the session metric width reaches getSets, f32 by default`, async () => {
    const api = stubApi();
    const net = new Network("http", withBlocks(api), ["127.0.0.1|21000"], 4, 100, {
      navigation,
      meshDiscovery: false,
    });
    await net.whenReady();
    await net.getSets(COLLECTION, ["a"]);
    await net.getSets(COLLECTION, ["b"], { metrics: "f64" });
    assert.deepEqual(api.widths, ["f32", "f64"]);

    const wide = stubApi();
    const f64 = new Network("http", withBlocks(wide), ["127.0.0.1|21000"], 4, 100, {
      navigation,
      meshDiscovery: false,
      metrics: "f64",
    });
    await f64.whenReady();
    await f64.getSets(COLLECTION, ["a"]);
    await f64.getSets(COLLECTION, ["b"], { metrics: "f32" });
    assert.deepEqual(wide.widths, ["f64", "f32"]);
  });
}

test("a per-call metric width bypasses the pool only when it differs", async () => {
  const api = stubApi();
  const net = new Network("http", withBlocks(api), ["127.0.0.1|21000"], 4, 100, {
    meshDiscovery: false,
    metrics: "f64",
  });
  await net.whenReady();
  let pooled = 0;
  const submit = net._setsPool.submit.bind(net._setsPool);
  net._setsPool.submit = (...args) => {
    pooled++;
    return submit(...args);
  };
  await net.getSets(COLLECTION, ["a"]);
  await net.getSets(COLLECTION, ["b"], { metrics: "f64" });
  await net.getSets(COLLECTION, ["c"], { metrics: "f32" });
  assert.equal(pooled, 2);
  assert.deepEqual(api.widths, ["f64", "f64", "f32"]);
});
