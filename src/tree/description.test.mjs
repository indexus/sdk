import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cellOrder,
  decodeDescription,
  descriptionName,
  encodeDescription,
  foldInCellOrder,
  isTyped,
  liftValue,
  verifyDescription,
} from "./description.js";

// Written by go-indexus-core internal/algebra (TestDescriptionVectorsForTheClient).
const vectors = JSON.parse(readFileSync(new URL("./testdata/description_vectors.json", import.meta.url)));
const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));

test("descriptions decode to the fields the Go code wrote", () => {
  for (const v of vectors) {
    const d = decodeDescription(hex(v.bytes));
    assert.equal(d.bitsPerChar, v.bitsPerChar);
    assert.equal(d.width, v.width);
    assert.equal(Buffer.from(d.nonce).toString("hex"), v.nonce);
    assert.deepEqual(d.recordDepths, v.recordDepths);
    assert.deepEqual(d.axes, v.axes);
    assert.deepEqual(d.schedule, v.schedule);
    assert.deepEqual(d.schema, v.schema);
    assert.deepEqual(encodeDescription(d), hex(v.bytes));
  }
});

test("the name is the hash of the bytes, and a wrong name is refused", async () => {
  for (const v of vectors) {
    assert.equal(await descriptionName(hex(v.bytes)), v.name);
    await verifyDescription(v.name, hex(v.bytes));
  }
  await assert.rejects(verifyDescription(vectors[1].name, hex(vectors[0].bytes)));
});

test("bytes that are not canonical are refused", () => {
  const b = hex(vectors[2].bytes);
  for (let i = 0; i < b.length; i++) {
    const bad = b.slice();
    bad[i] ^= 1;
    try {
      const d = decodeDescription(bad);
      // A flipped bit may still decode (a nonce, a bound): it is then another
      // description, which its name will not match.
      assert.notDeepEqual(encodeDescription(d), b);
    } catch (e) {
      assert.match(e.message, /not a canonical collection description/);
    }
  }
  assert.throws(() => decodeDescription(Uint8Array.from([...b, 0])), /trailing/);
  assert.throws(() => decodeDescription(b.subarray(0, b.length - 1)), /short/);
});

test("cell order and folds match the Go code to the last bit", () => {
  for (const v of vectors) {
    const d = decodeDescription(hex(v.bytes));
    for (const [location, key] of Object.entries(v.cellOrder)) {
      assert.deepEqual(cellOrder(d.bitsPerChar, v.name, location), key, location);
    }
    const parts = v.fold.records.map((r) => ({ location: r.location, id: r.id, value: liftValue(d.schema, r.metrics) }));
    const got = foldInCellOrder(d, v.name, parts);
    assert.equal(got.count, v.fold.count);
    assert.equal(got.cols.length, v.fold.cols.length);
    got.cols.forEach((x, i) => assert.ok(Object.is(x, v.fold.cols[i]), `${v.name} column ${i} (${d.schema[i]}): ${x} vs ${v.fold.cols[i]}`));
    assert.equal(isTyped(d), d.schema.some((k) => k !== "sum"));
  }
});
