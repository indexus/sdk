import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";

import { getSets } from "./getSets.js";
import { Peer } from "../wire/peer.js";
import { BLOCK_CONTENT_TYPE, blocksToElements } from "../wire/block.js";

const v1 = JSON.parse(readFileSync(new URL("./testdata/peer-wire.json", import.meta.url)));
const ixb2 = readFileSync(new URL("../wire/testdata/basic.bin", import.meta.url));
const golden = JSON.parse(
  readFileSync(new URL("../wire/testdata/basic.json", import.meta.url), "utf8"),
);

/** One node that answers every request with `type` and `body`, and records the URLs. */
async function withNode(type, body, run) {
  const urls = [];
  const server = http.createServer((req, res) => {
    urls.push(new URL(req.url, "http://node"));
    res.writeHead(200, { "content-type": type });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const peer = new Peer(
    "AAAAAAAAAAAAAAAA",
    { "127.0.0.1": null },
    server.address().port,
    "127.0.0.1",
  );
  try {
    await run(peer, urls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("metrics f64 is asked for only when wanted", async () => {
  const wide = readFileSync(new URL("../wire/testdata/basic-f64.bin", import.meta.url));
  await withNode(BLOCK_CONTENT_TYPE, wide, async (peer, urls) => {
    const out = await getSets("http", peer, "places", ["@", "7"], { metrics: "f64" });
    assert.equal(urls[0].searchParams.get("format"), "block");
    assert.equal(urls[0].searchParams.get("metrics"), "f64");
    const set = blocksToElements("places", out.blocks).find((element) => element.hash() === "7C");
    assert.equal(set.metrics()[2], 0);
    await getSets("http", peer, "places", ["@"]);
    assert.equal(urls[1].searchParams.has("metrics"), false);
  });
});

test("an IXB2 answer decodes with its redirects", async () => {
  await withNode(`${BLOCK_CONTENT_TYPE}; charset=binary`, ixb2, async (peer, urls) => {
    const out = await getSets("http", peer, "places", ["@", "7"]);
    assert.equal(urls[0].searchParams.get("format"), "block");
    assert.deepEqual(out.redirects, golden.redirects);
    assert.equal(
      out.rows,
      golden.sections.reduce((sum, section) => sum + section.count.length, 0),
    );
    assert.equal(out.bytes, ixb2.byteLength);
    const hashes = blocksToElements("places", out.blocks).map((element) => element.hash());
    assert.deepEqual(hashes, ["7", "a", "7a", "_-", "7B", "7C", "7Bxyz"]);
  });
});

test("an IXB2 answer is the body in its own buffer, with views and no elements", async () => {
  await withNode(BLOCK_CONTENT_TYPE, ixb2, async (peer) => {
    const out = await getSets("http", peer, "places", ["@", "7"], { raw: true });
    assert.equal(out.format, "block");
    assert.equal(out.elements, undefined);
    assert.ok(out.buffer instanceof ArrayBuffer);
    assert.equal(out.buffer.byteLength, ixb2.byteLength);
    assert.equal(out.blocks.length, golden.sections.length);
    assert.equal(out.blocks[0].keys.buffer, out.buffer);
    assert.deepEqual(Array.from(out.blocks[0].count), golden.sections[0].count);
    assert.deepEqual(out.redirects, golden.redirects);
    assert.equal(out.bytes, ixb2.byteLength);
    assert.equal(
      out.rows,
      golden.sections.reduce((sum, section) => sum + section.count.length, 0),
    );
  });
});

test("an answer that is not IXB2 is a read error", async () => {
  await withNode("application/octet-stream", Buffer.from(v1.envelopeHex, "hex"), async (peer) => {
    await assert.rejects(getSets("http", peer, "places", ["@"], { deep: false }), /not IXB2/);
    await assert.rejects(getSets("http", peer, "places", ["@"], { raw: true }), /not IXB2/);
  });
});

test("raw or not, the answer is the IXB2 body", async () => {
  await withNode(BLOCK_CONTENT_TYPE, ixb2, async (peer) => {
    const out = await getSets("http", peer, "places", ["@", "7"]);
    assert.equal(out.format, "block");
    assert.ok(out.buffer instanceof ArrayBuffer);
    assert.equal("elements" in out, false);
  });
});
