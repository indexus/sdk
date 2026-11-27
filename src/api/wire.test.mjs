import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import * as wire from "./wire.js";
import { Peer } from "../wire/peer.js";
import { encodeFixed, decodeFixed } from "../tree/alphabet.js";
import { encodeUrl64 } from "../utilities/url64.js";
const path = new URL("./testdata/peer-wire.json", import.meta.url),
  fixture = JSON.parse(readFileSync(path));
test("Go and SDK agree on peer budgets", () => {
  assert.deepEqual(fixture.limits, {
    readLocations: wire.MAX_READ_LOCATIONS,
    contentRecords: wire.MAX_CONTENT_RECORDS,
    contentParts: wire.MAX_CONTENT_PARTS,
    contentBytes: wire.MAX_CONTENT_BYTES,
    contentLocationLength: wire.CONTENT_LOCATION_LENGTH,
  });
  assert.equal(fixture.sets.precision, wire.SETS_PRECISION);
  // Published SDK tests remain standalone; monorepo checks additionally compare fixture bytes.
  const sibling = new URL("../../../core/indexus/testdata/peer-wire.json", import.meta.url);
  if (existsSync(sibling)) assert.deepEqual(readFileSync(path), readFileSync(sibling));
});

test("peer names and discovery use the Go alphabet; routing headers use URL64", () => {
  for (const peer of fixture.peers) {
    const id = Buffer.from(peer.idHex, "hex");
    assert.deepEqual([...new Peer(peer.name, {}, 21000, "127.0.0.1").id()], [...id]);
    assert.equal(encodeFixed(id), peer.name);
    assert.equal(encodeUrl64(id), peer.routingKey);
    assert.deepEqual([...decodeFixed(encodeFixed(id))], [...id]);
  }
});
