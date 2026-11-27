import test from "node:test";
import assert from "node:assert/strict";
import { GatewaySession } from "./gatewaySession.js";
import { Network } from "../network/index.js";
function fixture(options = {}) {
  const calls = [];
  let fail = false;
  let issued = 0;
  const session = new GatewaySession({
    origin: "https://app.test",
    ...options,
    request: async (url, options) => {
      calls.push([url.pathname, options?.method ?? "GET"]);
      if (fail) {
        fail = false;
        return { ok: false, status: 503 };
      }
      const bodies = {
        "/api/health": {
          network_id: "active",
          network_label: "Active",
          bootstrap: "localhost|21030",
          p2p_protocol: "http",
        },
        "/api/mesh": {
          hosts: ["localhost|21030"],
          nodes: [
            { up: true, host: "other|21031" },
            { up: false, host: "stopped|1" },
          ],
        },
        "/api/token": { token: `token-${++issued}` },
      };
      return { ok: true, json: async () => bodies[url.pathname] };
    },
  });
  return {
    session,
    calls,
    fail: () => {
      fail = true;
    },
  };
}
test("gateway session shares configuration and authentication without fixed ports", async () => {
  const { session, calls } = fixture();
  const [a, b] = await Promise.all([session.configuration(), session.configuration()]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.hosts, ["localhost|21030", "other|21031"]);
  assert.equal(a.gateway, "https://app.test/api/p2p");
  assert.equal(a.networkId, "active");
  assert.equal(calls.filter(([p]) => p === "/api/health").length, 1);
  assert.equal(calls.filter(([p]) => p === "/api/token").length, 1);
  a.hosts.length = 0;
  assert.equal((await session.configuration()).hosts.length, 2);
});
test("expired token refresh keeps the configured network", async (t) => {
  const { session, calls } = fixture();
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const a = await session.configuration();
  now = 240001;
  const b = await session.configuration();
  assert.notEqual(a.bearer, b.bearer);
  assert.equal(b.networkId, "active");
  assert.equal(calls.filter(([p]) => p === "/api/token").length, 2);
  assert.equal(globalThis.__INDEXUS_BEARER__, b.bearer);
});
test("failed gateway configuration retries instead of retaining a rejected promise", async () => {
  const { session, fail } = fixture();
  fail();
  await assert.rejects(session.configuration(), /503/);
  assert.equal((await session.configuration()).networkId, "active");
});
test("a missing token fails explicitly", async () => {
  const session = new GatewaySession({
    origin: "https://app.test",
    request: async (url) => ({
      ok: true,
      json: async () =>
        url.pathname === "/api/health" ? { network_id: "n", bootstrap: "host|12" } : {},
    }),
  });
  await assert.rejects(session.configuration(), /token missing/);
});

test("native browser fetch keeps its global receiver", async () => {
  const session = new GatewaySession({
    origin: "https://app.test",
    request: async function (url) {
      assert.equal(this, globalThis);
      return {
        ok: true,
        json: async () =>
          url.pathname === "/api/health"
            ? { network_id: "n", bootstrap: "host|12" }
            : url.pathname === "/api/token"
              ? { token: "ok" }
              : {},
      };
    },
  });
  assert.equal((await session.configuration()).bearer, "ok");
});


test("gateway sessions can resolve terminal records through the current records endpoint", async (t) => {
  t.mock.method(Network.prototype, "discoverPeers", async () => 0);
  t.mock.method(Network.prototype, "listPeers", () => [{}]);
  const reads = [];
  t.mock.method(Network.prototype, "getContentRecords", async (collection, location, limit) => {
    reads.push([collection, location, limit]);
    return [{ collection, location: "abc", id: "one", metrics: [7] }];
  });
  const { session } = fixture({ contentRecords: true });
  const network = await session.network();
  const records = await network.getRecords("demo", "a", 10);
  assert.deepEqual(reads, [["demo", "a", 10]]);
  assert.equal(records[0].id(), "one");
  assert.equal(records[0]._terminal, true);
});
