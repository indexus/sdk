import { test } from "node:test";
import assert from "node:assert/strict";
import { Network } from "./index.js";
import { Peer } from "../wire/peer.js";
import { Set as Zone } from "../tree/set.js";
import { SetsCoalescePool } from "./setsCoalescePool.js";
import { Throttler } from "./throttler.js";
import { RecordReader } from "./records.js";
import { withBlocks } from "./stub.testkit.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const cancelError = () => Object.assign(new Error("canceled"), { code: "ERR_CANCELED" });
async function network() {
  const calls = [];
  const api = {
    pingPeer: async (_p, ip, port) =>
      new Peer("AAAAAAAAAAAAAAAA", { [ip]: null }, Number(port), ip),
    getSets(_p, _peer, collection, locations, options) {
      return new Promise((resolve, reject) => {
        const call = {
          locations,
          signal: options.signal,
          resolve: () =>
            resolve({
              elements: locations.map((loc) => new Zone(collection, loc + "0", 1, [10])),
              redirects: [],
              ingress: null,
            }),
        };
        options.signal.addEventListener("abort", () => reject(cancelError()), { once: true });
        calls.push(call);
      });
    },
  };
  const net = new Network("http", withBlocks(api), ["127.0.0.1|21000"], 1, 100, {
    meshDiscovery: false,
    navigation: "ingress",
  });
  await net.whenReady();
  return { net, calls };
}
const collection = "demoCollection00";

test("one canceled consumer preserves a shared request; last consumer aborts and healthy peer remains", async () => {
  const { net, calls } = await network(),
    a = new AbortController(),
    b = new AbortController();
  const first = net.getSets(collection, ["a"], { signal: a.signal });
  const second = net.getSets(collection, ["a"], { signal: b.signal });
  const firstRejected = assert.rejects(first, { code: "ERR_CANCELED" });
  await turn();
  assert.equal(calls.length, 1);
  a.abort();
  await firstRejected;
  assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve();
  assert.equal((await second).get("a").length, 1);
  const c = new AbortController(),
    last = net.getSets(collection, ["b"], { signal: c.signal });
  const lastRejected = assert.rejects(last, { code: "ERR_CANCELED" });
  await turn();
  c.abort();
  await lastRejected;
  await turn();
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(net.listPeers().length, 1);
  assert.equal(net._throttler.activeCount, 0);
  assert.equal(net._inflight.size, 0);
  const retry = net.getSets(collection, ["b"]);
  await turn();
  calls[2].resolve();
  assert.equal((await retry).get("b").length, 1);
});

test("canceling a queued wire read releases it without calling the peer", async () => {
  const { net, calls } = await network(),
    a = new AbortController(),
    b = new AbortController();
  const first = net.getSets(collection, ["a"], { signal: a.signal, method: "getSet" });
  const firstRejected = assert.rejects(first, { code: "ERR_CANCELED" });
  await turn();
  const queued = net.getSets(collection, ["b"], { signal: b.signal, method: "getSet" });
  const queuedRejected = assert.rejects(queued, { code: "ERR_CANCELED" });
  await turn();
  assert.equal(net._throttler.queue.length, 1);
  b.abort();
  await queuedRejected;
  await turn();
  assert.equal(net._throttler.queue.length, 0);
  assert.equal(calls.length, 1);
  a.abort();
  await firstRejected;
  await turn();
  assert.equal(net._throttler.taskMap.size, 0);
});

test("read deadline includes the queue and aborts the transport", async () => {
  const { net, calls } = await network();
  const read = net.getSets(collection, ["a"], { timeoutMs: 30 });
  await assert.rejects(read, { code: "ETIMEDOUT" });
  await turn();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(net.listPeers().length, 1);
});

test("coalesced wire chunks survive one waiter cancel, then abort when every waiter leaves", async () => {
  let wireSignal;
  const pool = new SetsCoalescePool({
    fetchChunk: (_c, _loc, _r, signal) =>
      new Promise((_resolve, reject) => {
        wireSignal = signal;
        signal.addEventListener("abort", () => reject(cancelError()), { once: true });
      }),
    finalizeWaiter: () => new Map(),
  });
  const a = new AbortController(),
    b = new AbortController();
  const first = pool.submit("c", new Map(), ["a"], ["a"], false, a.signal);
  const second = pool.submit("c", new Map(), ["b"], ["b"], false, b.signal);
  const rejects = [
    assert.rejects(first, { code: "ERR_CANCELED" }),
    assert.rejects(second, { code: "ERR_CANCELED" }),
  ];
  await turn();
  a.abort();
  assert.equal(wireSignal.aborted, false);
  b.abort();
  await Promise.all(rejects);
  assert.equal(wireSignal.aborted, true);
});

test("record consumers share cancellation ownership and never cache an aborted result", async () => {
  let signal, finish;
  const reader = new RecordReader(async (_c, _p, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const a = new AbortController(),
    b = new AbortController();
  const first = reader.load("demo", "a", 10, { signal: a.signal }),
    second = reader.load("demo", "a", 10, { signal: b.signal });
  const rejects = [
    assert.rejects(first, { code: "ERR_CANCELED" }),
    assert.rejects(second, { code: "ERR_CANCELED" }),
  ];
  await turn();
  a.abort();
  assert.equal(signal.aborted, false);
  b.abort();
  await Promise.all(rejects);
  assert.equal(signal.aborted, true);
  finish({ "aFull:id": { count: 1, metrics: [3] } });
  await turn();
  assert.equal(reader.peek("demo", "a"), null);
});

test("clearing queued tasks rejects their callers instead of leaving unresolved promises", async () => {
  const pool = new Throttler(1);
  let finish;
  const first = pool.enqueue(
    "first",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const second = pool.enqueue("second", () => assert.fail("cleared work executed"));
  const rejected = assert.rejects(second, { code: "ERR_CANCELED" });
  pool.clearQueue();
  await rejected;
  finish();
  await first;
  assert.deepEqual(pool.getStatus(), { active: 0, queued: 0 });
  assert.equal(pool.taskMap.size, 0);
});

test("canceling a refresh preserves the previous cached zone", async () => {
  const { net, calls } = await network();
  const warm = net.getSets(collection, ["a"]);
  await turn();
  calls[0].resolve();
  await warm;
  const controller = new AbortController();
  const refresh = net.getSets(collection, ["a"], {
    refresh: true,
    force: true,
    signal: controller.signal,
  });
  const rejected = assert.rejects(refresh, { code: "ERR_CANCELED" });
  await turn();
  controller.abort();
  await rejected;
  await turn();
  const result = await net.getSets(collection, ["a"]);
  assert.equal(result.get("a").length, 1);
  assert.equal(calls.length, 2, "warm result remains usable without another request");
});

test("a coalesced read canceled before flushing never calls the transport", async () => {
  let calls = 0;
  const controller = new AbortController();
  const pool = new SetsCoalescePool({
    fetchChunk: async () => {
      calls++;
    },
    finalizeWaiter: () => new Map(),
  });
  const pending = pool.submit("c", new Map(), ["a"], ["a"], false, controller.signal);
  const rejected = assert.rejects(pending, { code: "ERR_CANCELED" });
  controller.abort();
  await rejected;
  await turn();
  assert.equal(calls, 0);
});
