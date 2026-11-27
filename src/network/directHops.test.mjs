/**
 * Direct navigation over a batch that straddles owners: one answer names one
 * peer per missed location, the client folds them all into its table and
 * regroups the leftovers by owner instead of walking one location at a time.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Network } from "./index.js";
import { Peer } from "../wire/peer.js";
import { Set as SetEntity } from "../tree/set.js";
import { withBlocks } from "./stub.testkit.mjs";

const BOOT = "AAAAAAAAAAAAAAAA";
const OWNER_1 = "BBBBBBBBBBBBBBBB";
const OWNER_2 = "CCCCCCCCCCCCCCCC";
const HOST = "127.0.0.1|21000";
/** 16-char collection so zoneKeyID matches peer id width. */
const COLLECTION = "demoCollection00";

/**
 * @param {object} plan
 * @param {Record<string, string>} plan.owners location → owner hash
 * @param {Record<string, {ip: string, port: number}>} plan.hosts owner → address
 * @param {Record<string, string[]>} [plan.alsoServes] owner → locations it answers
 *   with data *and* a redirect, so a named peer arrives for a resolved location.
 */
function stubApi({ owners, hosts, alsoServes = {} }) {
  const requests = [];
  return {
    requests,
    async pingPeer(_protocol, ip, port) {
      return new Peer(BOOT, { [ip]: null }, Number(port), ip);
    },
    async getSets(_protocol, peer, collection, locations, options = {}) {
      const asked = peer.hash();
      requests.push({
        peer: asked,
        locations: [...locations],
        deep: options.deep !== false,
        envelope: options.envelope === true,
      });

      const elements = [];
      const redirects = [];
      for (const location of locations) {
        const owner = owners[location];
        const serves = owner === asked || (alsoServes[asked] || []).includes(location);
        if (serves) {
          elements.push(new SetEntity(collection, `${location}X`, 1, [1]));
        }
        // A node that does not hold the zone names the peer that should.
        if (owner && owner !== asked) {
          redirects.push({ location, name: owner, ...hosts[owner] });
        }
      }
      return { elements, redirects, ingress: null };
    },
  };
}

async function connected(api) {
  const net = new Network("http", withBlocks(api), [HOST], 4, 100, {
    navigation: "direct",
    method: "getSets",
    meshDiscovery: false,
    refreshTtlMs: 0,
  });
  await net.whenReady();
  return net;
}

test("one answer names several owners and the batch finishes in one more round", async () => {
  const hosts = {
    [OWNER_1]: { ip: "10.0.0.2", port: 21002 },
    [OWNER_2]: { ip: "10.0.0.3", port: 21003 },
  };
  const api = stubApi({
    owners: { aa: OWNER_1, ab: OWNER_1, ac: OWNER_2, ad: OWNER_2 },
    hosts,
  });
  const net = await connected(api);
  assert.equal(net.listPeers().length, 1, "table starts at the bootstrap node");

  const map = await net.getSets(COLLECTION, ["aa", "ab", "ac", "ad"]);

  for (const location of ["aa", "ab", "ac", "ad"]) {
    assert.deepEqual(
      map.get(location)?.map((c) => c.hash()),
      [`${location}X`],
      `${location} came back with its data`,
    );
  }

  // Round 1 asks the bootstrap node for the whole batch; round 2 asks each owner
  // once for the locations it owns. One request per owner, not per location.
  assert.equal(api.requests.length, 3, `requests: ${JSON.stringify(api.requests)}`);
  assert.deepEqual(api.requests[0], {
    peer: BOOT,
    locations: ["aa", "ab", "ac", "ad"],
    deep: false,
    envelope: true,
  });

  const second = api.requests.slice(1).sort((a, b) => a.peer.localeCompare(b.peer));
  assert.deepEqual(second[0].locations, ["aa", "ab"]);
  assert.equal(second[0].peer, OWNER_1);
  assert.deepEqual(second[1].locations, ["ac", "ad"]);
  assert.equal(second[1].peer, OWNER_2);

  // Both owners the read named are now routable for later waves.
  const hashes = net
    .listPeers()
    .map((p) => p.hash)
    .sort();
  assert.deepEqual(hashes, [BOOT, OWNER_1, OWNER_2].sort());
});

test("a peer named for a location served in the same answer is still learned", async () => {
  const hosts = {
    [OWNER_1]: { ip: "10.0.0.2", port: 21002 },
    [OWNER_2]: { ip: "10.0.0.3", port: 21003 },
  };
  // The bootstrap node still holds a stale copy of `aa` and hands it over while
  // naming OWNER_1 as the zone's peer. The data wins the read; the peer must not
  // be dropped on the floor with it.
  const api = stubApi({
    owners: { aa: OWNER_1, ab: OWNER_2 },
    hosts,
    alsoServes: { [BOOT]: ["aa"] },
  });
  const net = await connected(api);

  const map = await net.getSets(COLLECTION, ["aa", "ab"]);
  assert.deepEqual(
    map.get("aa")?.map((c) => c.hash()),
    ["aaX"],
    "stale local copy answered aa",
  );
  assert.deepEqual(
    map.get("ab")?.map((c) => c.hash()),
    ["abX"],
  );

  const hashes = net
    .listPeers()
    .map((p) => p.hash)
    .sort();
  assert.deepEqual(
    hashes,
    [BOOT, OWNER_1, OWNER_2].sort(),
    "the owner named for the already-served zone is in the table",
  );

  // aa was resolved on the first round, so nobody re-asked for it.
  assert.ok(
    api.requests.slice(1).every((r) => !r.locations.includes("aa")),
    `aa was re-asked: ${JSON.stringify(api.requests)}`,
  );
});

test("a peer this client already failed to reach is not re-pinned by a read", async () => {
  const hosts = { [OWNER_1]: { ip: "10.0.0.2", port: 21002 } };
  const api = stubApi({ owners: { aa: OWNER_1 }, hosts });
  const net = await connected(api);
  net._hintRejected.add(OWNER_1);

  await assert.rejects(net.getSets(COLLECTION, ["aa"]), { name: "IncompleteReadError" });

  assert.ok(
    api.requests.every((r) => r.peer !== OWNER_1),
    `dialled a known-dead peer: ${JSON.stringify(api.requests)}`,
  );
  assert.deepEqual(
    net.listPeers().map((p) => p.hash),
    [BOOT],
  );
});
