// IXRB against the golden file the node writes (core indexus/testdata/records,
// TestRecordsGoldenFile), and the JSON fallback against the same records.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";

import { RECORDS_CONTENT_TYPE, decodeRecords, binaryPayload } from "./records.js";
import { getContentRecords } from "../api/getContentRecords.js";
import { Peer } from "./peer.js";

const dir = new URL("../api/testdata/records/", import.meta.url);
const body = readFileSync(new URL("basic.bin", dir));
const golden = JSON.parse(readFileSync(new URL("basic.json", dir), "utf8"));
const hex = (bytes) => Buffer.from(bytes ?? []).toString("hex");

test("IXRB decodes to what the node's decoder reads back", () => {
  const records = decodeRecords(golden.collection, body);
  assert.equal(records.length, golden.decoded.length);
  records.forEach((record, i) => {
    const want = golden.decoded[i];
    assert.equal(record.collection, golden.collection);
    assert.equal(record.location, want.location);
    assert.equal(record.id, want.id);
    assert.deepEqual(record.metrics ?? [], want.metrics);
    assert.equal(record.weight ?? 0, want.weight);
    assert.equal(record.binary === true, want.binary);
    if (want.binary) {
      assert.ok(record.payload instanceof Uint8Array, "binary payloads stay bytes");
      assert.equal(record.payload.buffer, body.buffer, "a view on the body, no copy");
      assert.equal(hex(record.payload), want.payloadHex);
    } else if (want.payloadHex) {
      assert.deepEqual(record.payload, JSON.parse(Buffer.from(want.payloadHex, "hex")));
    } else {
      assert.equal("payload" in record, false);
    }
  });
});

test("IXRB and the JSON answer give the same records, binary payloads as bytes", () => {
  const fromJson = golden.json.records.map(binaryPayload);
  assert.deepEqual(decodeRecords(golden.collection, body), fromJson);
});

test("IXRB v2: every binary payload is a view at a 4-byte offset of the body", () => {
  const aligned = new Uint8Array(new ArrayBuffer(body.length));
  aligned.set(body);
  const records = decodeRecords(golden.collection, aligned.buffer);
  const binary = records.filter((record) => record.binary);
  assert.ok(binary.length > 0);
  for (const { payload } of binary) {
    assert.equal(payload.buffer, aligned.buffer, "no copy");
    assert.equal(payload.byteOffset % 4, 0);
    if (payload.length >= 4)
      new Uint32Array(payload.buffer, payload.byteOffset, payload.length >> 2);
  }
});

/** One binary record at location "ab": its payload length ends at offset 33, then 3 zeros. */
function oneRecord(padding = [0, 0, 0]) {
  const head = [..."IXRB"].map((c) => c.charCodeAt(0)).concat([2, 0, 0, 0, 1, 0, 0, 0]);
  const record = [2, 0, 97, 98, 1, 0, 99, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0];
  return Uint8Array.from([...head, ...record, ...padding, 1, 2, 3, 4]);
}

test("another IXRB version, or padding that is not zero, is refused", () => {
  const [record] = decodeRecords("c", oneRecord().buffer);
  assert.deepEqual([...record.payload], [1, 2, 3, 4]);
  assert.equal(record.payload.byteOffset, 36);
  assert.throws(() => decodeRecords("c", oneRecord([0, 7, 0])), /padding/);
  const v1 = oneRecord();
  v1[4] = 1;
  assert.throws(() => decodeRecords("c", v1), /version 1/);
});

test("a truncated or foreign body is refused", () => {
  assert.throws(() => decodeRecords("c", body.subarray(0, body.length - 1)), /truncated/);
  assert.throws(
    () => decodeRecords("c", Buffer.concat([body, Buffer.from([0])])),
    /after the last/,
  );
  assert.throws(() => decodeRecords("c", Buffer.from("IXB2\0\0\0\0")), /not IXRB/);
});

async function node(answer) {
  const urls = [];
  const server = http.createServer((req, res) => {
    urls.push(new URL(req.url, "http://node"));
    const { type, data } = answer();
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const peer = new Peer(
    "AAAAAAAAAAAAAAAA",
    { "127.0.0.1": null },
    server.address().port,
    "127.0.0.1",
  );
  return { urls, peer, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test("getContentRecords asks for IXRB and falls back to JSON from an older node", async () => {
  const expected = golden.json.records.map(binaryPayload);
  const ixrb = await node(() => ({ type: RECORDS_CONTENT_TYPE, data: body }));
  const json = await node(() => ({
    type: "application/json",
    data: JSON.stringify(golden.json),
  }));
  try {
    const a = await getContentRecords("http", ixrb.peer, "golden", "@", 10);
    assert.equal(ixrb.urls[0].searchParams.get("format"), "binary");
    assert.deepEqual(a, expected);
    const b = await getContentRecords("http", json.peer, "golden", "@", 10);
    assert.deepEqual(b, expected);
    assert.ok(b[0].payload instanceof Uint8Array);
    await assert.rejects(getContentRecords("http", ixrb.peer, "golden", "@", 2), /Invalid/);
  } finally {
    await ixrb.stop();
    await json.stop();
  }
});

test("IXRB v3: a record wider than 255 metrics (an embedding) reads back whole", () => {
  const wideBody = readFileSync(new URL("wide.bin", dir));
  const wide = JSON.parse(readFileSync(new URL("wide.json", dir), "utf8"));
  assert.equal(wideBody[4], 3);
  const records = decodeRecords(wide.collection, wideBody);
  assert.equal(records.length, wide.decoded.length);
  records.forEach((record, i) => {
    assert.equal(record.id, wide.decoded[i].id);
    assert.deepEqual(record.metrics ?? [], wide.decoded[i].metrics);
  });
  assert.equal(records[1].metrics.length, 1536);
  assert.deepEqual(decodeRecords(wide.collection, wideBody), wide.json.records.map(binaryPayload));
});
