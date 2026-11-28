import assert from "node:assert/strict";
import test from "node:test";
import { walkLocalChildren } from "../index.js";

const collection = "0000000000000001";
const at = (peer,location) => ({peer,location});
const initial = {collection,pending:[at("P","@"),at("Q","@"),at("P","@")]};
const oracle = [at("P","@"),at("Q","@"),at("P","a"),at("Q","a"),at("Q","z"),at("P","aa")];
function makeIO() {
  const calls = [];
  return { calls, observe: async (peer, c, location) => {
    assert.equal(c,collection);
    calls.push(at(peer,location));
    const children = {"P@":["a"],"Q@":["a","z"],"Pa":["aa"]}[peer+location] ?? [];
    return {children,complete:false};
  }};
}
test("bounded slices and JSON resume follow the same peer/address oracle as a single pass",async () => {
  const io = makeIO();
  const peersForChild = (peer, parent, child) => parent==="@" && child==="a" ? ["P","Q"] : [peer];
  const options = {observe:io.observe,peersForChild};
  let r = await walkLocalChildren(initial,{...options,maxRequests:0});
  assert.deepEqual(r.state.pending,oracle.slice(0,2));
  assert.deepEqual(io.calls,[]);
  for (const limit of [1,2,1,5]) {
    r = await walkLocalChildren(JSON.parse(JSON.stringify(r.state)),{...options,maxRequests:limit});
    assert.ok(r.attempts<=limit);
    assert.equal(r.error,null);
    assert.equal(r.complete,false);
  }
  assert.deepEqual(r.state.pending,[]);
  assert.deepEqual(r.state.visited,oracle);
  assert.deepEqual(io.calls,oracle);
  const second = makeIO();
  const one = await walkLocalChildren(initial,{observe:second.observe,peersForChild,maxRequests:20});
  assert.deepEqual(one.state,r.state);
  assert.deepEqual(one.observations.map(({peer,location})=>at(peer,location)),oracle);
  assert.equal(initial.pending.length,3);
});
test("a failed request keeps its place and prior progress survives retry", async () => {
  const {observe,calls}=makeIO();
  const failure=new Error("503");
  const result = await walkLocalChildren(initial,{maxRequests:10, observe:async (p,c,l) => {
    if (p==="Q") throw failure;
    return observe(p,c,l);
  }});
  assert.equal(result.error,failure);
  assert.equal(result.attempts,2);
  assert.deepEqual(result.state.visited,[at("P","@")]);
  assert.deepEqual(result.state.pending,[at("Q","@"),at("P","a")]);
  const retry=await walkLocalChildren(JSON.parse(JSON.stringify(result.state)),{observe,maxRequests:1});
  assert.equal(retry.error,null);
  assert.deepEqual(calls,[at("P","@"),at("Q","@")]);
});
test("reject an invalid child or routing decision before committing the source pair",async()=>{
  for(const [children,peersForChild] of [[["a","abc"],()=>["P"]],[["a","a"],()=>["P"]],[["a","b"],(p,l,c)=>c==="a"?["P"]:new Array(1)],[["a","b"],(p,l,c)=>c==="a"?["P"]:[null]]]){
    const out = await walkLocalChildren(initial,{maxRequests:2,observe:async()=>({children,complete:false}),peersForChild});
    assert.ok(out.error);
    assert.deepEqual(out.state.pending,oracle.slice(0,2));
    assert.deepEqual(out.state.visited,[]);
  }
});

test("a new pass can discover a child omitted during a handoff", async () => {
  const seed = {collection, pending:[at("Q","a")]};
  let visible = false;
  const options = {maxRequests:8, observe:async (_,__,loc) =>
    ({children:visible && loc==="a" ? ["ab"] : [],complete:false})};
  const before = await walkLocalChildren(seed, options);
  visible = true;
  const resumed = await walkLocalChildren(before.state, options);
  const after = await walkLocalChildren(seed, options);
  assert.equal(resumed.attempts,0);
  assert.deepEqual(after.state.visited,[at("Q","a"),at("Q","ab")]);
  assert.equal(after.complete,false);
});

test("concurrent waves finish out of order but route and commit in stable BFS order",async()=>{
  const pending=["a","b","c","d"].map(l=>at("P",l));
  const started=[],route=[],release=new Map();
  let inFlight=0,peak=0;
  const run=walkLocalChildren({collection,pending},{concurrency:3,maxRequests:4,
    observe:async(p,c,l)=>{
      started.push(l);peak=Math.max(peak,++inFlight);
      await new Promise(resolve=>release.set(l,resolve));
      inFlight--;
      return {children:[l+"0"],complete:false};
    },peersForChild:(p,l,child)=>{route.push(child);return [p];}});
  assert.deepEqual(started,["a","b","c"]);
  for(const l of ["c","b","a"]) release.get(l)();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(route,["a0","b0","c0"]);
  release.get("d")();
  const out=await run;
  assert.equal(peak,3);
  assert.equal(out.attempts,4);
  assert.deepEqual(out.state.visited,pending);
  assert.deepEqual(out.state.pending,["a0","b0","c0","d0"].map(l=>at("P",l)));
});
test("failed wave drains, keeps its prefix and retries only uncommitted positions",async()=>{
  const pending=["a","b","c","d"].map(l=>at("P",l));
  const failure=new Error("503"), started=[], routed=[];
  let releaseLast;
  const run=walkLocalChildren({collection,pending},{concurrency:3,maxRequests:20,
    observe:async (_,__,l)=>{
      started.push(l);
      if(l==="b") throw failure;
      if(l==="c") await new Promise(resolve=>{releaseLast=resolve;});
      return {children:[l+"0"],complete:false};
    },peersForChild:(p,l,c)=>{routed.push(c);return [p];}});
  let settled=false;run.then(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);
  assert.deepEqual(started,["a","b","c"]);
  releaseLast();
  const out=await run;
  assert.equal(out.error,failure);
  assert.deepEqual(routed,["a0"]);
  assert.deepEqual(out.state.visited,pending.slice(0,1));
  assert.deepEqual(out.state.pending,[...pending.slice(1),at("P","a0")]);
  assert.equal(out.attempts,3);
  const retry=await walkLocalChildren(out.state,{maxRequests:10,concurrency:2,observe:async()=>({children:[],complete:false})});
  assert.deepEqual(retry.state.visited,[...pending,at("P","a0")]);
});
test("aborts and synchronous failures stop dispatch and preserve a resumable checkpoint",async()=>{
  const pending=["a","b","c"].map(l=>at("P",l));
  const controller=new AbortController();
  const out=await walkLocalChildren({collection,pending},{concurrency:3,maxRequests:10,signal:controller.signal,
    observe:(p,c,l,{signal})=>{assert.equal(signal,controller.signal);controller.abort();return {children:[],complete:false};}});
  assert.equal(out.attempts,1);assert.equal(out.error.code,"ERR_CANCELED");assert.deepEqual(out.state.pending,pending);
  const canceled=await walkLocalChildren({collection,pending},{maxRequests:3,signal:controller.signal,observe:()=>assert.fail()});
  assert.equal(canceled.attempts,0);assert.equal(canceled.error.code,"ERR_CANCELED");
  const fail=await walkLocalChildren({collection,pending},{maxRequests:3,concurrency:3,observe(){throw Error("sync");}});
  assert.equal(fail.attempts,1);assert.deepEqual(fail.state.pending,pending);
  for(const concurrency of [0,-1,1.5,Infinity]) await assert.rejects(walkLocalChildren(initial,{maxRequests:1,concurrency,observe(){}}),RangeError);
});
