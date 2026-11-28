import test from "node:test";
import assert from "node:assert/strict";
import { API } from "./index.js";

const peer = { ip: () => "127.0.0.1", port: () => 9900 },
  collection = "Demo000000000000";
const locations = ["aa", "bb", "bc"];
const probe = (api, options = {}) => api.refreshObservedCut("http", peer, collection, locations, options);
const summary = { algorithm: "sha256-add256-v1", sum: "0".repeat(64), count: "0" };
function fixture() {
  const api = new API(),
    docs = { aa: "A", bb: "B", bc: "C" },
    calls = [],
    unavailable = new Set();
  let version = 0,
    inFlight = 0,
    peak = 0;
  api.getLocalFingerprint = async (_, __, c, location) => {
    calls.push(location);
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight--;
    const unknown = unavailable.has(location);
    const rows = Object.entries(docs)
      .filter(([l]) => location === "@" || l.startsWith(location))
      .sort();
    return {
      collection: c,
      location,
      fingerprint: unknown ? null : JSON.stringify(rows),
      guard: unknown ? null : String(version),
      complete: false
    };
  };
  return {
    api,
    docs,
    calls,
    unavailable,
    peak: () => peak,
    change: (l, v) => {
      version++;
      docs[l] = v;
    }
  };
}

test("fixed-cut refresh compares hierarchical content, filters work, and never acknowledges a preview", async () => {
  const f = fixture(),
    loaded = [];
  const load = async (l) => {
    loaded.push(l);
    return f.docs[l];
  };
  const initial = await probe(f.api, { load, concurrency: 2 });
  assert.deepEqual(initial.initial, locations);
  assert.equal(initial.accepted, true);
  assert.equal(f.peak(), 2);
  assert.deepEqual(
    initial.loads.map((x) => x.value),
    ["A", "B", "C"]
  );
  f.calls.length = 0;
  loaded.length = 0;
  const same = await probe(f.api, { baseline: initial.baseline, load });
  assert.deepEqual(same.unchanged, locations);
  assert.deepEqual(f.calls, ["@"]);
  assert.deepEqual(loaded, []);
  f.change("bb", "B2");
  f.calls.length = 0;
  const preview = await probe(f.api, { baseline: initial.baseline });
  assert.equal(preview.baseline, initial.baseline);
  assert.equal(preview.accepted, false);
  assert.deepEqual(preview.changed, ["bb"]);
  assert.equal(preview.changedFraction, 1 / 3);
  assert.deepEqual(preview.changedAncestors, ["@", "b"]);
  assert.ok(!f.calls.includes("aa"));
  const restored = await probe(f.api, { baseline: preview.baseline, load });
  assert.deepEqual(restored.loads, [{ location: "bb", value: "B2", verified: true }]);
  assert.equal((await probe(f.api, { baseline: restored.baseline, load })).requests, 1);
  f.change("zz", "new outside the cut");
  const outside = await probe(f.api, { baseline: restored.baseline });
  assert.deepEqual(outside.changed, []);
  assert.deepEqual(outside.changedAncestors, ["@"]);
});

test("first probe-only baseline does not stand in for loaded rows; unknown and ABA preserve prior cache", async () => {
  const f = fixture();
  const first = await probe(f.api);
  const initial = await probe(f.api, { baseline: first.baseline, load: (l) => f.docs[l] });
  assert.deepEqual(
    initial.loads.map((x) => x.location),
    locations
  );
  f.change("aa", "A2");
  f.change("bb", "B2");
  const race = await probe(f.api, {
    baseline: initial.baseline,
    load: (l) => {
      if (l === "bb") {
        f.change("bb", "transient");
        const value = f.docs.bb;
        f.change("bb", "B2");
        return value;
      }
      return f.docs[l];
    }
  });
  assert.equal(race.baseline, initial.baseline);
  assert.equal(race.accepted, false);
  assert.ok(race.unknown.includes("bb"));
  assert.ok(race.loads.every((x) => !x.verified));
  f.unavailable.add("bb");
  const unknown = await probe(f.api, { baseline: initial.baseline, load: (l) => f.docs[l] });
  assert.deepEqual(unknown.unknown, ["bb"]);
  assert.equal(unknown.baseline, initial.baseline);
  f.unavailable.clear();
  const retry = await probe(f.api, { baseline: unknown.baseline, load: (l) => f.docs[l] });
  assert.deepEqual(retry.changed, ["aa", "bb"]);
  assert.equal(retry.accepted, true);
});

test("scope, overlap, limits, cancellation and read failures preserve caller-owned state", async () => {
  const f = fixture();
  const seed = await probe(f.api, { load: (l) => f.docs[l] });
  await assert.rejects(
    f.api.refreshObservedCut("https", peer, collection, locations, { baseline: seed.baseline }),
    /Baseline/
  );
  await assert.rejects(f.api.refreshObservedCut("http", peer, collection, ["a", "aa"], {}), /Overlapping/);
  await assert.rejects(probe(f.api, { baseline: {} }), /Baseline/);
  await assert.rejects(probe(f.api, { signal: AbortSignal.abort() }));
  f.change("aa", "new");
  f.calls.length = 0;
  await assert.rejects(
    probe(f.api, { baseline: seed.baseline, maxRequests: 2, load: (l) => f.docs[l] }),
    /budget/
  );
  assert.equal(f.calls.length, 2);
  await assert.rejects(
    probe(f.api, {
      baseline: seed.baseline,
      load: () => {
        throw new Error("timeout");
      }
    }),
    /timeout/
  );
  assert.deepEqual((await probe(f.api, { baseline: seed.baseline })).changed, ["aa"]);
});

test("wire scope and evidence are mandatory for pruning, with explicit null triple for uncertainty", async (t) => {
  let body = {
    collection,
    location: "@",
    complete: false,
    fingerprint: "value",
    guard: "snapshot",
    monoid: summary
  };
  const calls = t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/zones/fingerprint/local");
    assert.equal(init.redirect, "error");
    return Response.json(body);
  });
  const read = () => new API().getLocalFingerprint("http", peer, collection, "@");
  assert.equal((await read()).guard, "snapshot");
  for (const overrides of [
    { collection: "wrong" },
    { location: "a" },
    { complete: true },
    { guard: null },
    { monoid: { ...summary, count: "00" } },
    { monoid: { ...summary, sum: "f".repeat(64) } }
  ]) {
    const saved = body;
    body = { ...body, ...overrides };
    await assert.rejects(read());
    body = saved;
  }
  body = { collection, location: "@", complete: false, guard: null, monoid: null, fingerprint: null };
  assert.deepEqual(await read(), body);
  assert.equal(calls.mock.callCount(), 8);
});

test("refreshing one changed leaf retains the other acknowledged leaf in the same baseline", async () => {
  const f = fixture(),
    load = (l) => f.docs[l];
  const first = await probe(f.api, { load });
  f.change("bb", "revised B");
  f.change("bc", "revised C");
  const empty = await probe(f.api, {
    baseline: first.baseline,
    reloadLocations: [],
    load: () => assert.fail("preview")
  });
  assert.equal(empty.baseline, first.baseline);
  assert.deepEqual(empty.changed, ["bb", "bc"]);
  const onlyB = await probe(f.api, { baseline: first.baseline, reloadLocations: ["bb"], load });
  assert.equal(onlyB.accepted, true);
  assert.deepEqual(onlyB.loads, [{ location: "bb", value: "revised B", verified: true }]);
  assert.deepEqual(onlyB.changed, ["bb", "bc"]);
  assert.deepEqual(onlyB.deferred, ["bc"]);
  const next = await probe(f.api, { baseline: onlyB.baseline });
  assert.deepEqual(next.changed, ["bc"]);
  assert.deepEqual(next.unchanged, ["aa", "bb"]);
  const onlyC = await probe(f.api, { baseline: onlyB.baseline, reloadLocations: ["bc"], load });
  assert.deepEqual(onlyC.loads, [{ location: "bc", value: "revised C", verified: true }]);
  assert.equal((await probe(f.api, { baseline: onlyC.baseline })).requests, 1);
  await assert.rejects(probe(f.api, { reloadLocations: ["outside"], load }), /members/);
});

test("the nearest common ancestor covers direct rows and avoids unrelated parent probes",async()=>{
  const f=fixture();
  f.change("aa0","left");f.change("aa1","right");
  const refresh=options=>f.api.refreshObservedCut("http",peer,collection,["aa0","aa1"],options);
  const initial=await refresh({load:l=>f.docs[l]});
  assert.equal(f.calls[0],"aa");
  assert.deepEqual(new Set(f.calls),new Set(["aa","aa0","aa1"]));
  f.calls.length=0;
  f.change("zz","elsewhere");
  const same=await refresh({baseline:initial.baseline,maxRequests:1});
  assert.deepEqual(f.calls,["aa"]);assert.deepEqual(same.unchanged,["aa0","aa1"]);
  f.change("aa","direct row");
  f.calls.length=0;
  const direct=await refresh({baseline:initial.baseline});
  assert.deepEqual(direct.changedAncestors,["aa"]);assert.deepEqual(direct.changed,[]);
  assert.deepEqual(f.calls,["aa","aa0","aa1"]);
});
test("singleton cuts probe only that address, with a guard reread around data loads",async()=>{
  for(const location of ["aa","@"]){
    const f=fixture();
    const refresh=options=>f.api.refreshObservedCut("http",peer,collection,[location],options);
    const first=await refresh({maxRequests:1});
    assert.deepEqual(f.calls,[location]);assert.deepEqual(first.initial,[location]);
    f.calls.length=0;
    const loaded=await refresh({baseline:first.baseline,load:l=>f.docs[l]});
    assert.deepEqual(f.calls,[location,location]);assert.equal(loaded.loads[0].verified,true);
    f.calls.length=0;
    const same=await refresh({baseline:loaded.baseline,maxRequests:1});
    assert.deepEqual(f.calls,[location]);assert.deepEqual(same.unchanged,[location]);
  }
});
