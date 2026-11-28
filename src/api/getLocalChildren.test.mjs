import assert from "node:assert/strict";
import test from "node:test";
import { API } from "./index.js";
import { LOCATION_ALPHABET } from "../tree/alphabet.js";

const peer = { ip: () => "127.0.0.1", port: () => 19123 };
const collection = "Demo000000000000";
const read = (parent, key = collection) => new API().getLocalChildren("http", peer, key, parent);

test("local children validates the request key and preserves partial observations", async t => {
  let children = [...LOCATION_ALPHABET];
  const calls = t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, "http://127.0.0.1:19123/zones/children/local");
    assert.equal(target.searchParams.get("collection"), collection);
    assert.equal(init.redirect, "error");
    return Response.json({children, complete:false});
  });
  for (const parent of ["", "@a", "x".repeat(17)]) await assert.rejects(read(parent));
  await assert.rejects(read("@", "bad"));
  assert.equal(calls.mock.callCount(), 0);
  assert.deepEqual(await read("@"), {children, complete:false});
  children = ["a-", "a_"];
  assert.deepEqual(await read("a"), {children,complete:false});
  children = [];
  assert.deepEqual(await read("x".repeat(16)), {children:[],complete:false});
  assert.deepEqual(calls.mock.calls.map(x=>new URL(x.arguments[0]).searchParams.get("location")), ["@","a","x".repeat(16)]);
});

test("malformed children, complete markers and peer failures never trigger a fallback", async t => {
  const replies = [
    ...[["@",["a","a"]],["@",["!"]],["a",["b0"]],["a",["a"]],["a",["abc"]],
      ["@",["@"]],["@",[null]],["@",Array(65).fill("a")]]
      .map(([parent,children])=>[parent,{children,complete:false}]),
    ...[true,null,0,"false",undefined].map(complete=>["@",{children:[],complete}]),
    ["@",{complete:false}],
  ];
  let next;
  const calls = t.mock.method(globalThis, "fetch", async ()=>next());
  for(const [parent,body] of replies) {
    next=()=>Response.json(body);
    await assert.rejects(read(parent));
  }
  for(const status of [204,404,503]) {
    next=()=>new Response(null,{status});
    await assert.rejects(read("@"));
  }
  assert.equal(calls.mock.callCount(),replies.length+3);
});

test("uncertain branches require an explicit acknowledgement from the serving peer", async t => {
  let supported = false;
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(new URL(url).searchParams.get("include_uncertain"), "true");
    return Response.json({ children: ["z"], complete: false, include_uncertain: supported });
  });
  const run = () => new API().getLocalChildren("http", peer, collection, "@", { includeUncertain: true });
  await assert.rejects(run, /Invalid local children/);
  supported = true;
  assert.deepEqual(await run(), { children: ["z"], complete: false });
});
