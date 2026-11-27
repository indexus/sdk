// IXB2 decode time and body size on generated rows.
//
//   node --expose-gc scripts/perf/wire-decode.mjs [rows] [parents]
//
// The encoder below is a test fixture written from the format
// (core/docs/protocol/wire-block.md), so this runs without a node. It is not
// part of the SDK. scripts/perf/run.mjs reuses fixture and encodeIXB2.

import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { decodeBlocks, blocksToElements } from "../../src/wire/block.js";
import { ROUTING_ALPHABET } from "../../src/tree/index.js";

const PARENT_CHARS = 3;
const SUFFIX_CHARS = 4;
const METRICS = 5;
const RUNS = 30;
// Two metrics scaled to 1e-6, as the node's float sums usually are.
const METRIC_SCALE = 1_000_000;

let seed;
function random(n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  // High bits: the low bits of this generator have a short period.
  return Math.floor((seed / 2 ** 32) * n);
}

function randomText(length) {
  let text = "";
  for (let i = 0; i < length; i++) text += ROUTING_ALPHABET[random(64)];
  return text;
}

/** Rows grouped by parent, unique locations, metrics 2..4 set. */
export function fixture(rows = 10_000, parentCount = 50) {
  seed = 7;
  const parents = new Map();
  while (parents.size < parentCount) parents.set(randomText(PARENT_CHARS), new Map());
  const list = [...parents.values()];
  const names = [...parents.keys()];
  let made = 0;
  while (made < rows) {
    const p = random(parentCount);
    const location = names[p] + randomText(SUFFIX_CHARS);
    if (list[p].has(location)) continue;
    const count = 1 + random(40);
    // An integer and two values scaled to 1e-6.
    const metrics = [0, 0, random(1000), random(1e6) / METRIC_SCALE, random(1e6) / METRIC_SCALE];
    list[p].set(location, { count, metrics });
    made++;
  }
  return parents;
}

// --- IXB2: one rows section per parent, aligned little-endian columns.

function keyWord(suffix) {
  let bits = 0;
  for (const ch of suffix) bits = bits * 64 + ROUTING_ALPHABET.indexOf(ch);
  return (bits * 2 ** (32 - 6 * suffix.length)) >>> 0;
}

export function encodeIXB2(parents) {
  const sections = [];
  for (const [parent, zone] of parents) {
    const rows = [...zone]
      .map(([location, row]) => [keyWord(location.slice(parent.length)), row])
      .sort((a, b) => a[0] - b[0]);
    const n = rows.length;
    const bytes = 8 + 12 + ((parent.length + 3) & ~3) + 4 * n * (2 + METRICS);
    const section = new ArrayBuffer(bytes);
    const view = new DataView(section);
    view.setUint32(0, bytes, true);
    view.setUint16(4, 1, true);
    view.setUint32(8, n, true);
    view.setUint8(12, parent.length);
    view.setUint8(13, SUFFIX_CHARS);
    view.setUint8(14, Math.ceil((6 * SUFFIX_CHARS) / 32));
    view.setUint8(15, METRICS);
    for (let i = 0; i < parent.length; i++) view.setUint8(20 + i, parent.charCodeAt(i));
    const keys = 20 + ((parent.length + 3) & ~3);
    rows.forEach(([key, row], i) => {
      view.setUint32(keys + 4 * i, key, true);
      view.setUint32(keys + 4 * (n + i), row.count, true);
      for (let j = 0; j < METRICS; j++)
        view.setFloat32(keys + 4 * (2 * n + j * n + i), row.metrics[j], true);
    });
    sections.push(new Uint8Array(section));
  }
  const total = 16 + sections.reduce((sum, s) => sum + s.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x58, 0x42, 0x32]);
  view.setUint16(4, 16, true);
  view.setUint32(8, sections.length, true);
  let offset = 16;
  for (const section of sections) {
    out.set(section, offset);
    offset += section.byteLength;
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function measure(name, run) {
  for (let i = 0; i < 5; i++) run();
  const times = [];
  let heap = 0;
  for (let i = 0; i < RUNS; i++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    const at = performance.now();
    const kept = run();
    times.push(performance.now() - at);
    heap += process.memoryUsage().heapUsed - before;
    assert.ok(kept);
  }
  return { name, medianMs: +median(times).toFixed(3), heapKiB: Math.round(heap / RUNS / 1024) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ROWS = Number(process.argv[2]) || 10_000;
  const PARENTS = Number(process.argv[3]) || 50;
  const parents = fixture(ROWS, PARENTS);
  const ixb2 = encodeIXB2(parents);

  const counts = new Map();
  for (const zone of parents.values()) for (const [key, row] of zone) counts.set(key, row.count);
  const fromBlocks = blocksToElements("c", decodeBlocks(ixb2).blocks);
  assert.equal(fromBlocks.length, ROWS);
  for (const element of fromBlocks) assert.equal(element.count(), counts.get(element.hash()));

  const results = [
    measure("IXB2 decodeBlocks", () => decodeBlocks(ixb2).blocks),
    measure("IXB2 decodeBlocks + blocksToElements", () =>
      blocksToElements("c", decodeBlocks(ixb2).blocks),
    ),
  ];

  console.log(
    JSON.stringify(
      {
        rows: ROWS,
        parents: PARENTS,
        keyChars: PARENT_CHARS + SUFFIX_CHARS,
        bytes: {
          ixb2: ixb2.byteLength,
          ixb2Gzip: gzipSync(ixb2).byteLength,
        },
        runs: RUNS,
        results,
      },
      null,
      2,
    ),
  );
}
