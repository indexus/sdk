import assert from "node:assert/strict";
import test from "node:test";
import { API } from "./index.js";
import { Network } from "../network/index.js";

const peer = { ip: () => "127.0.0.1", port: () => 21000 };
const api = new API();
const net = {
  whenReady: async () => {},
  _knownOwner: () => peer,
  _protocol: "http",
  _api: api,
  _enqueueWire: (_peer, _method, call) => call(),
};
const probe = (options) =>
  Network.prototype.getCachedZone.call(net, "Demo000000000000", "aa", options);

test("a cache-only probe never follows a redirect or retries a deep read", async (t) => {
  const replies = [
    new Response(null, { status: 204 }),
    Response.json({ set: {}, source: "cache", observed_at: "2026-01-01T00:00:00Z" }),
    new Response("", { status: 404 }),
    Response.json({ set: {} }),
  ];
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    urls.push(new URL(url));
    assert.equal(init.redirect, "error");
    return replies.shift();
  });
  await assert.rejects(probe({ maxAgeMs: 0 }), /maxAgeMs/);
  assert.equal(await probe({ maxAgeMs: 500 }), null);
  assert.deepEqual(await probe({ maxAgeMs: 500 }), {
    set: {}, observedAt: "2026-01-01T00:00:00Z",
  });
  await assert.rejects(probe({ maxAgeMs: 500 }), (e) => e.response.status === 404);
  await assert.rejects(probe({ maxAgeMs: 500 }), /Invalid cached zone/);
  assert.equal(urls.length, 4);
  for (const url of urls) {
    assert.equal(url.pathname, "/set/cached");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      collection: "Demo000000000000", location: "aa", max_age: "500ms",
    });
  }
});

test("legacy terminal zone requests keep requesting a deep refresh", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const { pathname,searchParams } = new URL(url);
    assert.equal(pathname, "/set");
    assert.equal(searchParams.get("deep"), "true");
    assert.equal(searchParams.get("refresh"), "true");
    return Response.json({ set: {} });
  });
  assert.deepEqual(await api.getZone("http", peer, "Demo000000000000", "aa"), {});
});
