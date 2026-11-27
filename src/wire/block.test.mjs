import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decodeBlocks, suffixAt, blocksToElements, BLOCK_CONTENT_TYPE } from "./block.js";
import { ROUTING_ALPHABET } from "../tree/index.js";

const golden = JSON.parse(readFileSync(new URL("./testdata/basic.json", import.meta.url), "utf8"));

/** A fresh, aligned copy of the golden body that a test may patch. */
function basic() {
  const file = readFileSync(new URL("./testdata/basic.bin", import.meta.url));
  const copy = new Uint8Array(file.byteLength);
  copy.set(file);
  return copy.buffer;
}

/** Byte offset of section `index` in the golden body. */
function sectionAt(buffer, index) {
  const view = new DataView(buffer);
  let offset = 16;
  for (let i = 0; i < index; i++) offset += view.getUint32(offset, true);
  return offset;
}

test("content type is the one of the contract", () => {
  assert.equal(BLOCK_CONTENT_TYPE, "application/vnd.indexus.block");
});

// The same files are produced by core/indexus/testdata/sets_block/reference.py
// and matched byte for byte by the Go encoder (TestSetsBlockMatchesReferenceGolden).
for (const name of ["basic", "edges", "dvf", "basic-f64", "align-f64", "columns", "columns-f64", "wide", "wide-f64"]) {
  test(`golden file ${name} decodes to its expectation`, () => {
    const file = readFileSync(new URL(`./testdata/${name}.bin`, import.meta.url));
    const expect = JSON.parse(
      readFileSync(new URL(`./testdata/${name}.json`, import.meta.url), "utf8"),
    );
    const copy = new Uint8Array(file.byteLength);
    copy.set(file);
    const { blocks, redirects, columns } = decodeBlocks(copy.buffer);
    assert.deepEqual(columns, expect.columns ?? null);
    assert.equal(blocks.length, expect.sections.length);
    blocks.forEach((block, i) => {
      const want = expect.sections[i];
      assert.equal(block.parent, want.parent);
      assert.equal(block.suffixChars, want.suffixChars);
      assert.equal(block.keyWords, want.keyWords);
      assert.equal(block.metricCount, want.metricCount);
      assert.equal(block.revision, want.revision);
      assert.equal(block.metricBytes, want.metricBytes);
      assert.equal(block.metrics.BYTES_PER_ELEMENT, want.metricBytes);
      assert.equal(block.n, want.count.length);
      assert.deepEqual([...block.keys], want.keys);
      assert.deepEqual([...block.count], want.count);
      assert.deepEqual([...block.metrics], want.metrics.flat());
      const suffixes = Array.from({ length: block.n }, (_, row) => suffixAt(block, row));
      assert.deepEqual(suffixes, want.suffixes);
    });
    assert.deepEqual(redirects, expect.redirects);
  });
}

test("f64 metrics are a Float64Array view, and need an 8-aligned buffer", () => {
  const file = readFileSync(new URL("./testdata/align-f64.bin", import.meta.url));
  const room = new Uint8Array(file.byteLength + 8);
  room.set(file, 0);
  const { blocks } = decodeBlocks(room.subarray(0, file.byteLength));
  for (const block of blocks) {
    assert.ok(block.metrics instanceof Float64Array);
    assert.equal(block.metrics.buffer, room.buffer);
  }
  assert.equal(
    blocks.find((block) => block.parent === "X" && block.metricCount === 3).metrics[0],
    16777217,
  );
  const shifted = room.subarray(4, 4 + file.byteLength);
  shifted.set(file);
  assert.throws(() => decodeBlocks(shifted), /aligned on 8/);
});

test("columns are views on the input buffer, not copies", () => {
  const buffer = basic();
  const { blocks } = decodeBlocks(buffer);
  for (const block of blocks) {
    assert.equal(block.keys.buffer, buffer);
    assert.equal(block.count.buffer, buffer);
    assert.equal(block.metrics.buffer, buffer);
  }
  // A write through the buffer shows in the decoded column.
  const first = blocks[0];
  new Uint32Array(buffer, first.count.byteOffset, 1)[0] = 99;
  assert.equal(first.count[0], 99);
});

test("an aligned view decodes in place, an unaligned one is rejected", () => {
  const body = new Uint8Array(basic());
  const shifted = new Uint8Array(body.byteLength + 8);
  shifted.set(body, 4);
  const aligned = shifted.subarray(4, 4 + body.byteLength);
  const { blocks } = decodeBlocks(aligned);
  assert.equal(blocks[0].keys.buffer, shifted.buffer);
  assert.deepEqual([...blocks[0].keys], golden.sections[0].keys);

  const odd = new Uint8Array(body.byteLength + 1);
  odd.set(body, 1);
  assert.throws(() => decodeBlocks(odd.subarray(1)), /aligned/);
});

test("rejects what the contract rejects", () => {
  const cases = [
    ["magic", (b, v) => v.setUint8(3, 0x31), /magic/],
    ["header size", (b, v) => v.setUint16(4, 20, true), /header size/],
    [
      "section not a multiple of 4",
      (b, v) => v.setUint32(16, v.getUint32(16, true) + 2, true),
      /section size/,
    ],
    ["section shorter than its header", (b, v) => v.setUint32(16, 4, true), /section size/],
    ["section overruns body", (b, v) => v.setUint32(sectionAt(b, 4), 4096, true), /overruns body/],
    ["more sections than the body holds", (b, v) => v.setUint32(8, 6, true), /truncated section/],
    ["rows overrun their section", (b, v) => v.setUint32(24, 1000, true), /rows overrun/],
    ["row count overflow", (b, v) => v.setUint32(24, 0xffffffff, true), /rows overrun/],
    ["key words do not match suffix", (b, v) => v.setUint8(30, 2), /key words/],
    [
      "redirect overruns its section",
      (b, v) => v.setUint16(sectionAt(b, 4) + 12, 400, true),
      /redirect overruns/,
    ],
  ];
  for (const [name, patch, error] of cases) {
    const buffer = basic();
    patch(buffer, new DataView(buffer));
    assert.throws(() => decodeBlocks(buffer), error, name);
  }
  assert.throws(() => decodeBlocks(new Uint8Array(8)), /truncated header/);
  const longer = new Uint8Array(basic().byteLength + 4);
  longer.set(new Uint8Array(basic()));
  assert.throws(() => decodeBlocks(longer), /trailing/);
});

test("unknown section kinds are skipped", () => {
  const buffer = basic();
  new DataView(buffer).setUint16(16 + 4, 7, true);
  const { blocks, redirects } = decodeBlocks(buffer);
  assert.equal(blocks.length, golden.sections.length - 1);
  assert.equal(blocks[0].parent, golden.sections[1].parent);
  assert.equal(redirects.length, 1);
});

test("suffixAt reads characters that straddle two words", () => {
  const suffix = "zY-_09";
  let bits = 0n;
  for (const ch of suffix) bits = (bits << 6n) | BigInt(ROUTING_ALPHABET.indexOf(ch));
  bits <<= 64n - 36n;
  const keys = new Uint32Array([0, 0, Number(bits >> 32n), Number(bits & 0xffffffffn)]);
  assert.equal(suffixAt({ keys, keyWords: 2, suffixChars: 6 }, 1), suffix);
});

/** The metrics v1 gives an element: nothing at 0 and 1, then metrics 2-4. */
function v1View(m2, m3, m4) {
  const metrics = [];
  metrics[2] = m2;
  metrics[3] = m3;
  metrics[4] = m4;
  return metrics;
}

function edges() {
  const file = readFileSync(new URL("./testdata/edges.bin", import.meta.url));
  const copy = new Uint8Array(file.byteLength);
  copy.set(file);
  return copy.buffer;
}

test("blocksToElements builds the v1 Item/Set shape", () => {
  const { blocks } = decodeBlocks(basic());
  const stats = { folded: -1 };
  const elements = blocksToElements("places", blocks, stats);
  assert.equal(stats.folded, 0);
  const byHash = new Map(elements.map((element) => [element.hash(), element]));
  assert.deepEqual([...byHash.keys()], ["7", "a", "7a", "_-", "7B", "7C", "7Bxyz"]);

  const set = byHash.get("7");
  assert.equal(set.constructor.name, "Set");
  assert.equal(set.collection(), "places");
  assert.equal(set.count(), 3);
  assert.deepEqual(set.metrics(), v1View(0, 0, 0));
  assert.deepEqual(byHash.get("7a").metrics(), v1View(7, 0, 0));

  const item = byHash.get("a");
  assert.equal(item.constructor.name, "Item");
  assert.equal(item.count(), 1);
  assert.equal(item.id(), "a");
  assert.deepEqual(item.metrics(), v1View(0, 0, 0));
  assert.ok(elements.every((element) => element._terminal === false));
});

test("blocksToElements gives metrics 2-4 as v1 does, metric 2 truncated", () => {
  const { blocks } = decodeBlocks(edges());
  const byHash = new Map(
    blocksToElements("places", blocks).map((element) => [element.hash(), element]),
  );
  // Five metrics on the wire, three in the element.
  assert.deepEqual(byHash.get("7Babcdef").metrics(), v1View(3, 4, 5));
  assert.deepEqual(byHash.get("b-_").metrics(), v1View(16777216, 0, 0));
  // The self-key keeps its parent's location, as in v1.
  assert.equal(byHash.get("7B").count(), 3);
  assert.deepEqual(byHash.get("7B").metrics(), v1View(0, 0, 0));

  const block = {
    parent: "",
    suffixChars: 1,
    keyWords: 1,
    metricCount: 4,
    revision: 0,
    n: 2,
    keys: new Uint32Array([0, 1 << 26]),
    count: new Uint32Array([2, 3]),
    metrics: new Float32Array([1, 1, 2, 2, 7.75, 1.5, 0.5, 0.25]),
  };
  const [first, second] = blocksToElements("places", [block]);
  assert.deepEqual(first.metrics(), v1View(7, 0.5, 0));
  assert.deepEqual(second.metrics(), v1View(1, 0.25, 0));
});

test("blocksToElements folds a location named by two sections", () => {
  const { blocks } = decodeBlocks(edges());
  const section = blocks[1];
  const again = { ...section };
  const stats = { folded: 0 };
  const elements = blocksToElements("places", [section, again], stats);
  assert.equal(stats.folded, 2);
  const merged = elements.find((element) => element.hash() === "7Babcdef");
  assert.equal(merged.count(), 2);
  assert.deepEqual(merged.metrics(), v1View(6, 8, 10));
});
