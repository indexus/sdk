// `getSets(..., {raw: true})`: the IXB2 answers reach the caller as they
// arrived, against real HTTP nodes. Navigation, owners, coalescence and
// cancellation work as for elements; nothing of the rows stays in the network.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";

import { Network } from "./index.js";
import { getSets as wireGetSets } from "../api/getSets.js";
import { Peer } from "../wire/peer.js";
import { BLOCK_CONTENT_TYPE, suffixAt } from "../wire/block.js";
import { zoneKey } from "../tree/alphabet.js";
import { encodeBlocks } from "../store/testkit.mjs";

const COLLECTION = "demoCollection00";
const NAME_A = "AAAAAAAAAAAAAAAA";
const NAME_B = "BAAAAAAAAAAAAAAA";

const basic = readFileSync(new URL("../wire/testdata/basic.bin", import.meta.url));
const basicF64 = readFileSync(new URL("../wire/testdata/basic-f64.bin", import.meta.url));
const golden = JSON.parse(
  readFileSync(new URL("../wire/testdata/basic.json", import.meta.url), "utf8"),
);
const goldenF64 = JSON.parse(
  readFileSync(new URL("../wire/testdata/basic-f64.json", import.meta.url), "utf8"),
);

/**
 * A node on a local port. `answer(locations, url)` returns `{type, body}`;
 * every `/sets` request is recorded as its list of locations.
 */
async function startNode(name, answer) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://node");
    const locations = url.searchParams.get("location").split(",");
    requests.push({ locations, url });
    const { type, body, delayMs = 0 } = answer(locations, url);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.writeHead(200, { "content-type": type });
    res.end(Buffer.from(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    name,
    port,
    requests,
    host: `127.0.0.1|${port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The real `/sets` call; peers are named without a ping. */
function apiFor(nodes) {
  return {
    async pingPeer(_protocol, ip, port) {
      const node = nodes.find((candidate) => candidate.port === Number(port));
      return new Peer(node.name, { [ip]: null }, Number(port), ip);
    },
    async getNeighbors() {
      return [];
    },
    getSets: wireGetSets,
  };
}

async function networkOn(nodes, options = {}) {
  const net = new Network("http", apiFor(nodes), [nodes[0].host], 4, 100, {
    meshDiscovery: false,
    ...options,
  });
  await net.whenReady();
  return net;
}

function block(type = BLOCK_CONTENT_TYPE) {
  return (body) => ({ type, body });
}

/** One section of two children per requested zone, counts 2 and 3. */
function childrenOf(locations, options) {
  const sections = locations.map((location) => ({
    parent: location === "@" ? "" : location,
    suffixes: ["x", "y"],
    count: [2, 3],
    metrics: [[1.5, 2.5]],
  }));
  return encodeBlocks(sections, options);
}

function assertGolden(blocks, expected) {
  assert.equal(blocks.length, expected.sections.length);
  blocks.forEach((rows, i) => {
    const want = expected.sections[i];
    assert.equal(rows.parent, want.parent);
    assert.equal(rows.metricBytes, want.metricBytes);
    assert.deepEqual(
      Array.from({ length: rows.n }, (_, row) => suffixAt(rows, row)),
      want.suffixes,
    );
    assert.deepEqual(Array.from(rows.count), want.count);
    assert.deepEqual(Array.from(rows.metrics), want.metrics.flat());
  });
}

test("raw IXB2 f32: the body comes back whole, with views on it, and no element is built", async () => {
  const node = await startNode(NAME_A, () => block()(basic));
  try {
    const net = await networkOn([node]);
    const out = await net.getSets(COLLECTION, ["@", "7", "q"], { raw: true });

    assert.equal(node.requests.length, 1);
    assert.equal(node.requests[0].url.searchParams.get("format"), "block");
    assert.equal(out.format, "block");
    assert.equal(out.responses.length, 1);
    const [answer] = out.responses;
    assert.ok(answer.buffer instanceof ArrayBuffer);
    assert.equal(
      answer.buffer.byteLength,
      basic.byteLength,
      "the buffer is the body and nothing else",
    );
    assert.ok(Buffer.from(answer.buffer).equals(basic));
    assert.equal(answer.elements, undefined);
    for (const rows of answer.blocks) {
      assert.equal(rows.keys.buffer, answer.buffer);
      assert.equal(rows.count.buffer, answer.buffer);
      assert.ok(rows.metrics instanceof Float32Array);
      assert.equal(rows.metrics.buffer, answer.buffer);
    }
    assertGolden(answer.blocks, golden);
    assert.deepEqual(answer.redirects, golden.redirects);

    // "q" was answered without a section.
    assert.deepEqual(out.empty, ["q"]);
    assert.deepEqual(out.unresolved, []);
    assert.equal(net._cache.size, 0, "the network keeps no copy of the rows");
  } finally {
    await node.stop();
  }
});

test("raw IXB2 f64: metrics are Float64Array views on the body", async () => {
  const node = await startNode(NAME_A, () => block()(basicF64));
  try {
    const net = await networkOn([node]);
    const out = await net.getSets(COLLECTION, ["@", "7"], { raw: true, metrics: "f64" });

    assert.equal(node.requests[0].url.searchParams.get("metrics"), "f64");
    assert.equal(out.format, "block");
    const [answer] = out.responses;
    assert.equal(answer.buffer.byteLength, basicF64.byteLength);
    for (const rows of answer.blocks) {
      assert.ok(rows.metrics instanceof Float64Array);
      assert.equal(rows.metrics.buffer, answer.buffer);
    }
    assertGolden(answer.blocks, goldenF64);
    assert.equal(net._cache.size, 0);
  } finally {
    await node.stop();
  }
});

test("a session in f64 reads raw through the coalesce pool", async () => {
  const node = await startNode(NAME_A, () => block()(basicF64));
  try {
    const net = await networkOn([node], { metrics: "f64" });
    const [a, b] = await Promise.all([
      net.getSets(COLLECTION, ["@"], { raw: true }),
      net.getSets(COLLECTION, ["7"], { raw: true }),
    ]);
    assert.equal(node.requests.length, 1);
    assert.equal(node.requests[0].url.searchParams.get("metrics"), "f64");
    assert.equal(a.responses[0], b.responses[0]);
    assert.ok(a.responses[0].blocks[0].metrics instanceof Float64Array);
  } finally {
    await node.stop();
  }
});

test("raw callers of one tick share one request and the same answer", async () => {
  const node = await startNode(NAME_A, (locations) =>
    block()(childrenOf(locations.filter((zone) => zone !== "e"))),
  );
  try {
    const net = await networkOn([node]);
    const [first, second, third] = await Promise.all([
      net.getSets(COLLECTION, ["a", "b"], { raw: true }),
      net.getSets(COLLECTION, ["b", "c"], { raw: true }),
      net.getSets(COLLECTION, ["e"], { raw: true }),
    ]);

    assert.equal(node.requests.length, 1, "one batch for the three callers");
    assert.deepEqual(node.requests[0].locations, ["a", "b", "c", "e"]);
    assert.equal(first.responses.length, 1);
    assert.equal(first.responses[0], second.responses[0]);
    assert.equal(first.responses[0], third.responses[0]);
    assert.deepEqual(
      first.responses[0].blocks.map((rows) => rows.parent),
      ["a", "b", "c"],
    );

    // Each caller is told about its own zones only.
    assert.deepEqual([first.empty, second.empty, third.empty], [[], [], ["e"]]);
    assert.deepEqual([first.unresolved, second.unresolved, third.unresolved], [[], [], []]);
    assert.equal(net._cache.size, 0);
  } finally {
    await node.stop();
  }
});

test("a raw read joins the raw read already on the wire for its zone", async () => {
  const node = await startNode(NAME_A, (locations) => ({
    ...block()(childrenOf(locations)),
    delayMs: 40,
  }));
  try {
    const net = await networkOn([node]);
    const early = net.getSets(COLLECTION, ["a"], { raw: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const late = net.getSets(COLLECTION, ["a"], { raw: true });
    const [first, second] = await Promise.all([early, late]);

    assert.equal(node.requests.length, 1);
    assert.equal(first.responses[0], second.responses[0]);
    assert.equal(net._metrics.coalescedJoins, 1);
  } finally {
    await node.stop();
  }
});

test("an element read joins the raw read already on the wire for its zone", async () => {
  const node = await startNode(NAME_A, (locations) => ({
    ...block()(childrenOf(locations)),
    delayMs: 30,
  }));
  try {
    const net = await networkOn([node]);
    const raw = net.getSets(COLLECTION, ["a"], { raw: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const elements = await net.getSets(COLLECTION, ["a"]);
    await raw;

    assert.equal(node.requests.length, 1);
    assert.deepEqual(
      elements.get("a").map((element) => element.hash()),
      ["ax", "ay"],
    );
  } finally {
    await node.stop();
  }
});

test("raw batches are chunked like element batches", async () => {
  const node = await startNode(NAME_A, (locations) => block()(childrenOf(locations)));
  try {
    const net = await networkOn([node], { setsMaxChunkSize: 2 });
    const out = await net.getSets(COLLECTION, ["a", "b", "c", "d", "e"], { raw: true });

    assert.equal(node.requests.length, 3);
    assert.equal(out.responses.length, 3);
    assert.deepEqual(
      out.responses.flatMap((answer) => answer.blocks.map((rows) => rows.parent)).sort(),
      ["a", "b", "c", "d", "e"],
    );
    assert.deepEqual(out.unresolved, []);
  } finally {
    await node.stop();
  }
});

test("direct raw: redirects are followed and the owner is remembered, without caching rows", async () => {
  // A owns nothing and names B for every zone but "e"; B has the rows, none for "e".
  let b;
  const a = await startNode(NAME_A, (locations) =>
    block()(
      encodeBlocks([], {
        redirects: locations
          .filter((zone) => zone !== "e")
          .map((location) => ({ location, name: NAME_B, ip: "127.0.0.1", port: b.port })),
      }),
    ),
  );
  b = await startNode(NAME_B, (locations) =>
    block()(childrenOf(locations.filter((zone) => zone !== "e"))),
  );
  try {
    const net = await networkOn([a, b], { navigation: "direct" });
    assert.deepEqual(
      net._table.peers().map((peer) => peer.hash()),
      [NAME_A],
      "the table starts with A alone",
    );

    const out = await net.getSets(COLLECTION, ["a", "b", "e"], { raw: true });
    assert.equal(out.format, "block");
    assert.equal(
      out.responses.length,
      1,
      "the redirect-only answer carries no rows and is not handed over",
    );
    assert.deepEqual(
      out.responses[0].blocks.map((rows) => rows.parent),
      ["a", "b"],
    );
    assert.equal(b.requests.length, 1);
    // "e" had no redirect, so it is probed on the next nearest peer, in the same batch.
    assert.deepEqual(b.requests[0].locations, ["a", "b", "e"]);
    assert.equal(b.requests[0].url.searchParams.get("deep"), "false");
    assert.deepEqual(out.empty, ["e"], "no rows and no redirect up to the root: empty");
    assert.deepEqual(out.unresolved, []);

    assert.equal(net._owners.get(zoneKey(COLLECTION, "a")).hash(), NAME_B);
    assert.equal(net._owners.get(zoneKey(COLLECTION, "b")).hash(), NAME_B);
    assert.equal(net._cache.size, 0);

    // The remembered owner is asked first: no redirect round the second time.
    const before = a.requests.length;
    const again = await net.getSets(COLLECTION, ["a"], { raw: true });
    assert.equal(a.requests.length, before);
    assert.equal(b.requests.length, 2);
    assert.deepEqual(
      again.responses[0].blocks.map((rows) => rows.parent),
      ["a"],
    );
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("a canceled raw read rejects and closes its request", async () => {
  const node = await startNode(NAME_A, (locations) => ({
    ...block()(childrenOf(locations)),
    delayMs: 200,
  }));
  try {
    const net = await networkOn([node]);
    const controller = new AbortController();
    const read = net.getSets(COLLECTION, ["a"], { raw: true, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(read, { name: "AbortError" });
    assert.equal(net._inflight.size, 0);
  } finally {
    await node.stop();
  }
});

test("a zone whose node cannot be reached is unresolved, not empty", async () => {
  const node = await startNode(NAME_A, (locations) => block()(childrenOf(locations)));
  const net = await networkOn([node], { navigation: "direct" });
  await node.stop();
  const out = await net.getSets(COLLECTION, ["a"], { raw: true });
  assert.deepEqual(out.responses, []);
  assert.deepEqual(out.empty, []);
  assert.deepEqual(out.unresolved, ["a"]);
});

test("raw with no location asks nothing", async () => {
  const node = await startNode(NAME_A, () => block()(basic));
  try {
    const net = await networkOn([node]);
    assert.deepEqual(await net.getSets(COLLECTION, [], { raw: true }), {
      format: "block",
      responses: [],
      empty: [],
      unresolved: [],
    });
    assert.equal(node.requests.length, 0);
  } finally {
    await node.stop();
  }
});
