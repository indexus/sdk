// The walk combines typed columns as the node does: in cell order, by kind.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createZoneIndex, zoneLevels } from "./zones.js";
import { combineColumns, resetColumns } from "./columns.js";
import { foldInCellOrder, liftValue } from "../tree/description.js";
import { normalizeHeat } from "../gpu/pack.js";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const NAME = "Q-zz0123456789AB";
const KINDS = ["sum", "min", "max", "first", "last", "affine.a", "affine.b"];
// A Space as the walk reads it: the rotation of each level is the name's.
// min, max, first, last are exact; sums and affine pairs are floats folded in
// another grouping (per child, then per zone), so they agree to rounding.
const close = (kind, a, b) =>
  kind === "sum" || kind.startsWith("affine") ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) : Object.is(a, b);
const space = { step: 3, size: 2, offset: { at: (l) => ALPHABET.indexOf(NAME[l % NAME.length]) } };

function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** An IXB2 rows block: suffixes sorted by routing digits, keys packed 6 bits each. */
function block(parent, suffixChars, rows) {
  rows.sort((a, b) => {
    for (let i = 0; i < suffixChars; i++) {
      const d = ALPHABET.indexOf(a.suffix[i]) - ALPHABET.indexOf(b.suffix[i]);
      if (d) return d;
    }
    return 0;
  });
  const n = rows.length;
  const keyWords = Math.max(1, Math.ceil((6 * suffixChars) / 32));
  const keys = new Uint32Array(n * keyWords);
  rows.forEach((r, row) => {
    for (let i = 0; i < suffixChars; i++) {
      const v = ALPHABET.indexOf(r.suffix[i]);
      const bit = 6 * i;
      const w = row * keyWords + (bit >>> 5);
      const o = bit & 31;
      if (o <= 26) keys[w] |= v << (26 - o);
      else {
        keys[w] |= v >>> (o - 26);
        keys[w + 1] |= (v << (58 - o)) >>> 0;
      }
    }
  });
  const m = KINDS.length;
  const metrics = new Float64Array(m * n);
  rows.forEach((r, row) => r.metrics.forEach((x, j) => (metrics[j * n + row] = x)));
  return { parent, suffixChars, n, keyWords, keys, metricCount: m, count: Float64Array.from(rows.map(() => 1)), metrics };
}

function randomRows(next, chars, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    let suffix = "";
    for (let c = 0; c < chars; c++) suffix += ALPHABET[Math.floor(next() * 64)];
    out.push({ suffix, metrics: KINDS.map((k) => (k === "affine.a" ? 0.9 + Math.floor(next() * 100) / 1000 : Math.floor(next() * 2000 - 1000) / 8)) });
  }
  return out;
}

test("a typed zone folds its rows in cell order, as the node does", () => {
  const next = rng(3);
  for (let trial = 0; trial < 20; trial++) {
    const zone = trial % 2 ? "" : "aB";
    const shallow = randomRows(next, 1, 30);
    const deep = randomRows(next, 2, 30);
    const own = randomRows(next, 0, 2).map((r) => ({ ...r, suffix: "" }));
    const index = createZoneIndex(space, { kinds: KINDS });
    const summary = index.ingest(zone || "@", [1, 2, 3], [block(zone, 1, shallow.slice()), block(zone, 2, deep.slice()), block(zone, 0, own.slice())]);
    const location = (r) => (zone + r.suffix) || "@";
    const parts = [...own, ...shallow, ...deep].map((r, i) => ({ location: location(r), id: String(i).padStart(3, "0"), value: liftValue(KINDS, r.metrics) }));
    // Records at one location keep their wire order: ids follow it here.
    const want = foldInCellOrder({ bitsPerChar: 6, schema: KINDS }, NAME, parts);
    assert.equal(summary.count, want.count);
    KINDS.forEach((k, j) => assert.ok(close(k, summary.metricSums[j], want.cols[j]), `trial ${trial} ${k}: ${summary.metricSums[j]} vs ${want.cols[j]}`));
    // Level 0 of the binary levels is the zone without its own records.
    const levels = zoneLevels(space, summary);
    const children = foldInCellOrder({ bitsPerChar: 6, schema: KINDS }, NAME, parts.slice(own.length));
    KINDS.forEach((k, j) => assert.ok(close(k, levels[0].metricSums[j], children.cols[j]), `level 0 ${k}`));
  }
});

test("without kinds the walk still adds every column", () => {
  const next = rng(9);
  const rows = randomRows(next, 1, 20);
  const index = createZoneIndex(space);
  const summary = index.ingest("@", [1], [block("", 1, rows.slice())]);
  const sum = (j) => rows.reduce((acc, r) => acc + r.metrics[j], 0);
  KINDS.forEach((_, j) => assert.ok(close("sum", summary.metricSums[j], sum(j))));
});

test("weighted or unordered combinations make ordered columns NaN, never a guess", () => {
  const kinds = ["sum", "max", "last"];
  const t = new Array(3);
  resetColumns(t, 0, kinds);
  combineColumns(t, 0, 0, (k) => [2, 5, 7][k], kinds, 0.5, false);
  combineColumns(t, 0, 1, (k) => [4, 3, 9][k], kinds, 0.25, false);
  assert.deepEqual([t[0], t[1]], [2, 5]);
  assert.ok(Number.isNaN(t[2]));
});

test("the heat reads sum columns only", () => {
  const kinds = ["sum", "max"];
  assert.doesNotThrow(() => normalizeHeat([{ num: 0, den: -1 }], kinds));
  assert.throws(() => normalizeHeat([{ num: 1, den: -1 }], kinds), /max column/);
  assert.doesNotThrow(() => normalizeHeat([{ num: 1, den: -1 }]));
});
