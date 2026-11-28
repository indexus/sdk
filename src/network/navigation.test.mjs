/**
 * Caller-facing 2×2 matrix: navigation × method, one `/sets` engine.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Network } from "./index.js";
import { Peer } from "../wire/peer.js";
import { Set as SetEntity } from "../tree/set.js";
import { withBlocks } from "./stub.testkit.mjs";

const NODE_A = "AAAAAAAAAAAAAAAA";
const NODE_B = "BBBBBBBBBBBBBBBB";
const HOST = "127.0.0.1|21000";
/** 16-char collection so zoneKeyID matches peer id width. */
const COLLECTION = "demoCollection00";

function stubApi({ childrenByLocation = {}, redirectsByPeer = {}, deepFlags = [] } = {}) {
  const requests = [];
  return {
    requests,
    deepFlags,
    async pingPeer(_protocol, ip, port) {
      return new Peer(NODE_A, { [ip]: null }, Number(port), ip);
    },
    async getSets(_protocol, peer, collection, locations, options = {}) {
      requests.push({
        peer: peer.hash(),
        locations: [...locations],
        deep: options.deep !== false,
        readMode: options.readMode,
        refresh: options.refresh === true,
        envelope: options.envelope === true,
        via: options.via || "",
        routingKey: options.routingKey instanceof Uint8Array,
      });
      deepFlags.push(options.deep !== false);

      const elements = [];
      const redirects = [];
      const peerRedirects = redirectsByPeer[peer.hash()] || {};
      for (const location of locations) {
        const kids =
          childrenByLocation[`${peer.hash()}:${location}`] ?? childrenByLocation[location] ?? [];
        for (const child of kids) {
          elements.push(new SetEntity(collection, child, 1, [1]));
        }
        const redirect = peerRedirects[location];
        if (redirect) redirects.push({ location, ...redirect });
      }
      return { elements, redirects, ingress: null };
    },
  };
}

async function connected(api, readOptions = {}) {
  const net = new Network("http", withBlocks(api), [HOST], 4, 100, readOptions);
  await net.whenReady();
  return net;
}

test("default shared config is ingress + getSets", async () => {
  const api = stubApi({ childrenByLocation: { aa: ["aaX"] } });
  const net = await connected(api);
  assert.deepEqual(net.readOptions(), {
    navigation: "ingress",
    method: "getSets",
  });
  await net.getSets(COLLECTION, ["aa"]);
  assert.equal(api.requests[0].deep, true);
  assert.equal(api.requests[0].envelope, false);
  assert.equal(api.requests[0].routingKey, true);
});

test("getSet is a one-location alias over the same /sets engine", async () => {
  const api = stubApi({ childrenByLocation: { aa: ["aaX", "aaY"] } });
  const net = await connected(api);
  const kids = await net.getSet(COLLECTION, "aa");
  assert.deepEqual(
    kids.map((c) => c.hash()),
    ["aaX", "aaY"],
  );
  assert.equal(api.requests.length, 1);
  assert.deepEqual(api.requests[0].locations, ["aa"]);
});

test("method=getSet disables coalesced multi-location batches", async () => {
  const api = stubApi({
    childrenByLocation: { aa: ["aaX"], ab: ["abX"], ac: ["acX"] },
  });
  const net = await connected(api, { method: "getSet" });
  await net.getSets(COLLECTION, ["aa", "ab", "ac"]);
  assert.equal(api.requests.length, 3);
  assert.ok(api.requests.every((r) => r.locations.length === 1));
});

test("navigation=direct uses deep=false envelope and follows redirects", async () => {
  const api = stubApi({
    childrenByLocation: {
      [`${NODE_B}:aa`]: ["aaX"],
    },
    redirectsByPeer: {
      [NODE_A]: {
        aa: { name: NODE_B, ip: "10.0.0.2", port: 21002 },
      },
    },
  });
  const net = await connected(api, { navigation: "direct" });
  // Seed the owner so redirect insert is not the only path.
  net._table.insert(
    new Peer(NODE_B, { "10.0.0.2": null }, 21002, "10.0.0.2").id(),
    new Peer(NODE_B, { "10.0.0.2": null }, 21002, "10.0.0.2"),
  );

  const map = await net.getSets(COLLECTION, ["aa"]);
  assert.deepEqual(
    map.get("aa").map((c) => c.hash()),
    ["aaX"],
  );
  assert.ok(api.deepFlags.every((d) => d === false));
  assert.ok(api.requests.some((r) => r.envelope));
  assert.ok(api.requests.some((r) => r.peer === NODE_B));
});

test("ingress and getSets share cache across alias and batch", async () => {
  const api = stubApi({ childrenByLocation: { aa: ["aaX"] } });
  const net = await connected(api);
  await net.getSet(COLLECTION, "aa");
  await net.getSets(COLLECTION, ["aa"]);
  assert.equal(api.requests.length, 1);
});

test("refreshing a direct read bypasses the client cache without a server refresh", async () => {
  const api = stubApi({ childrenByLocation: { aa: ["aaX"] } });
  const net = await connected(api, { navigation: "direct" });
  await net.getSet(COLLECTION, "aa");
  await net.getSet(COLLECTION, "aa", { refresh: true, force: true });
  assert.equal(api.requests.length, 2);
  assert.ok(api.requests.every((request) =>
    !request.deep && !request.refresh && request.readMode === "local"));
});

test("point reads follow an owner referral and remember the serving peer", async () => {
  const api = stubApi();
  const calls = [];
  api.getDirectRecords = async (_protocol, peer, collection, location) => {
    calls.push(peer.hash());
    if (peer.hash() === NODE_A) {
      const contact = { name: NODE_B, ip: "10.0.0.2", port: 21002 };
      throw Object.assign(new Error("not owner"), { response: { status: 409, data: { contact } } });
    }
    return [{ collection, location, id: "one", metrics: [] }];
  };
  const net = await connected(api, { navigation: "direct" });
  assert.equal((await net.getPointRecords(COLLECTION, "aa"))[0].id, "one");
  assert.equal((await net.getPointRecords(COLLECTION, "aa"))[0].id, "one");
  assert.deepEqual(calls, [NODE_A, NODE_B, NODE_B]);
});
