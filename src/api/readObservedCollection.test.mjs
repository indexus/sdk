import assert from "node:assert/strict";
import test from "node:test";
import { API } from "./index.js";

test("a failed record read cannot turn into a successful empty selection", async () => {
  const api = new API(), peers = ["old", "owner"];
  api.getLocalChildren = async () => ({ complete: false, children: [] });
  for (const status of [409, 413, 503]) {
    const error = Object.assign(new Error("read failed"), { response: { status } });
    const tried = [];
    api.getDirectRecords = async (_, peer) => { tried.push(peer); throw error; };
    await assert.rejects(api.readObservedCollection("http", peers, "Demo000000000000", { maxRequests: 4 }), e => e === error);
    assert.deepEqual(tried, status === 409 ? peers : ["old"]);
  }
});

test("both discovery and record reads count toward the client budget", async () => {
  const api = new API();
  api.getLocalChildren = async (_, peer, name, location) => ({
    complete: false, children: location === "@" ? ["a"] : [],
  });
  let reads = 0;
  api.getDirectRecords = async () => { reads++; return []; };
  for (const budget of [1, 2, 3]) {
    reads = 0;
    await assert.rejects(api.readObservedCollection("http", ["p"], "Demo000000000000", { maxRequests: budget }), /budget/);
    assert.equal(reads, Math.max(0, budget - 2));
  }
  assert.deepEqual(await api.readObservedCollection("http", ["p"], "Demo000000000000", { maxRequests: 4 }),
    { records: [], requests: 4, complete: false });
});

test("a shared root is read successfully once after an explicit ownership refusal", async () => {
  const api = new API(), peers = ["previous", "current"], tried = [];
  api.getLocalChildren = async () => ({ complete: false, children: [] });
  const row = { id: "root", location: "@" };
  api.getDirectRecords = async (_, peer) => {
    tried.push(peer);
    if (peer === "previous") throw Object.assign(new Error("ownership changed"), {response:{status:409}});
    return [row];
  };
  const result = await api.readObservedCollection("http", peers, "Demo000000000000", { maxRequests: 4 });
  assert.deepEqual(tried, peers);
  assert.deepEqual(result, { records: [row], requests: 4, complete: false });
});

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

test("concurrent reads preserve serial address order, including interior nodes", async () => {
  for (const width of [1, 2, undefined]) {
    const api = new API();
    let active = 0, peak = 0;
    api.getLocalChildren = async (_, peer, collection, location) =>
      ({children: location === "@" ? ["a","b","c","d"] : [], complete:false});
    api.getDirectRecords = async (_, peer, collection, location) => {
      peak = Math.max(peak, ++active);
      await nextTurn();
      if (location === "@") await nextTurn();
      active--;
      return [{location}];
    };
    const pass = await api.readObservedCollection("http", ["p"], "Demo000000000000",
      {maxRequests:10, concurrency:width});
    assert.deepEqual(pass.records.map(row => row.location), ["@", "a", "b", "c", "d"]);
    assert.equal(peak, width ?? 4);
    assert.equal(pass.requests, 10);
    assert.equal(pass.complete, false);
  }
});

test("a fatal read drains its sibling and prevents another ownership retry", async () => {
  const api = new API(), reads = [];
  api.getLocalChildren = async (_, peer, collection, location) =>
    ({children: location === "@" ? ["a","b"] : [], complete:false});
  const unavailable = Object.assign(new Error("unavailable"), {response:{status:503}});
  let drained = false;
  api.getDirectRecords = async (_, peer, collection, location) => {
    reads.push([peer,location]);
    if (location === "@") throw unavailable;
    await nextTurn();
    drained = true;
    throw Object.assign(new Error("not owner"), {response:{status:409}});
  };
  await assert.rejects(api.readObservedCollection("http", ["p","q"], "Demo000000000000",
    {maxRequests:20, concurrency:2}), e=>e===unavailable);
  assert.equal(drained,true);
  assert.deepEqual(reads,[["p","@"],["p","a"]]);
});

test("canceling during a read suppresses queued calls and the partial result", async () => {
  const api = new API(), abort = new AbortController(), calls = [];
  api.getLocalChildren = async (_, peer, collection, location) =>
    ({children: location === "@" ? ["a","b","c"] : [], complete:false});
  api.getDirectRecords = async (_, peer, collection, location) => {
    calls.push(location);
    await nextTurn();
    abort.abort();
    return [];
  };
  await assert.rejects(api.readObservedCollection("http", ["p"], "Demo000000000000",
    {maxRequests:20, concurrency:2, signal:abort.signal}), e=>e.code==="ERR_CANCELED");
  assert.deepEqual(calls, ["@", "a"]);
});
