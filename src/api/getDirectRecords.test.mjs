import assert from "node:assert/strict";
import test from "node:test";
import { API } from "./index.js";

const peer = { ip: () => "127.0.0.1", port: () => 19123 };
const api = new API();
const read = (limit = 1) => api.getDirectRecords("http", peer, "buildings", "ab", limit);
const row = { collection: "buildings", location: "ab", id: "x", metrics: [12] };

test("direct records only accept exact-address answers from the selected peer", async (t) => {
  const replies = [
    { records: [row] }, { records: [] }, { records: [{ ...row, location: "abc" }] },
    { records: [row, row] }, { records: [{ ...row, metrics: ["12"] }] },
    { records: [row, { ...row, id: "y" }] },
  ];
  const calls = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init.redirect, "error");
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, "http://127.0.0.1:19123/records/direct");
    assert.equal(target.searchParams.get("collection"), "buildings");
    assert.equal(target.searchParams.get("location"), "ab");
    return Response.json(replies.shift());
  });
  await assert.rejects(read(0), RangeError);
  assert.deepEqual(await read(), [row]);
  assert.deepEqual(await read(), []);
  await assert.rejects(read(), /row/);
  await assert.rejects(read(2), /row/);
  await assert.rejects(read(), /row/);
  await assert.rejects(read(), /response/);
  assert.deepEqual(calls.mock.calls.map(({ arguments: args }) => new URL(args[0]).searchParams.get("limit")),
    ["1", "1", "1", "2", "1", "1"]);
});

test("ownership, unavailable, unsupported and budget errors reach the client without a second request", async (t) => {
  const statuses = [409, 503, 404, 413];
  const calls = t.mock.method(globalThis, "fetch", async () => new Response("", { status: statuses.shift() }));
  for (const status of [...statuses])
    await assert.rejects(read(), error => error.response.status === status);
  assert.equal(calls.mock.callCount(), 4);
});

test("requesting payloads requires explicit support from the addressed peer", async t => {
  const replies = [{records:[row]}, {payloads:true, records:[{...row,payload:{title:"hello"}}]}];
  t.mock.method(globalThis, "fetch", url => {
    assert.equal(new URL(url).searchParams.get("payloads"), "true");
    return Response.json(replies.shift());
  });
  const get = () => api.getDirectRecords("http",peer,"buildings","ab",1,{includePayloads:true});
  await assert.rejects(get(), /response/);
  assert.deepEqual((await get())[0].payload,{title:"hello"});
});
