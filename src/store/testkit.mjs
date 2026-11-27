// IXB2 bodies for tests, written from core/docs/protocol/wire-block.md.

import { ROUTING_ALPHABET } from "../tree/index.js";

const ascii = new TextEncoder();

function pad(n, to) {
  return (n + to - 1) & ~(to - 1);
}

function keyWordsOf(suffix) {
  const words = new Uint32Array(Math.ceil((6 * suffix.length) / 32));
  for (let i = 0; i < suffix.length; i++) {
    const index = ROUTING_ALPHABET.indexOf(suffix[i]);
    for (let b = 0; b < 6; b++) {
      if (((index >> (5 - b)) & 1) === 0) continue;
      const bit = 6 * i + b;
      words[bit >>> 5] |= 1 << (31 - (bit & 31));
    }
  }
  return words;
}

function rowsSection({ parent = "", suffixes, count, metrics = [] }, f64) {
  const n = suffixes.length;
  const keyWords = Math.ceil((6 * suffixes[0].length) / 32);
  const keysAt = 8 + 12 + pad(parent.length, 4);
  const countAt = keysAt + 4 * n * keyWords;
  // An f64 column starts on a multiple of 8 from the start of the body.
  const metricsAt = f64 && metrics.length > 0 ? null : countAt + 4 * n;
  return { parent, suffixes, count, metrics, n, keyWords, keysAt, countAt, metricsAt };
}

/**
 * @param {Array<{ parent?: string, suffixes: string[], count: number[], metrics?: number[][] }>} sections
 *   every suffix of a section has the same length; `metrics[j]` is column j
 * @param {{ f64?: boolean, redirects?: Array<{ location: string, name: string, ip: string, port: number }> }} [options]
 * @returns {ArrayBuffer}
 */
export function encodeBlocks(sections, { f64 = false, redirects = [], columns = null } = {}) {
  const width = f64 ? 8 : 4;
  // a columns section first (core wire-block.md, kind 3): metric j of each row is metric columns[j]
  if (columns) {
    sections = sections.map((section) => ({
      ...section,
      metrics: columns.map((c) => section.metrics[c] ?? section.count.map(() => 0)),
    }));
  }
  const columnsBytes = columns ? pad(8 + 4 + 2 * columns.length, 4) : 0;
  let size = 16 + columnsBytes;
  const placed = sections.map((section) => {
    const rows = rowsSection(section, f64);
    rows.at = size;
    if (rows.metricsAt === null) rows.metricsAt = pad(size + rows.countAt + 4 * rows.n, 8) - size;
    size += pad(rows.metricsAt + width * rows.n * rows.metrics.length, 4);
    rows.bytes = size - rows.at;
    return rows;
  });
  const redirectsAt = size;
  if (redirects.length > 0) {
    size += 8 + 4;
    for (const { location, name, ip } of redirects)
      size += pad(8 + location.length + name.length + ip.length, 4);
  }

  const buffer = new ArrayBuffer(size);
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  u8.set(ascii.encode("IXB2"));
  view.setUint16(4, 16, true);
  view.setUint16(6, (redirects.length > 0 ? 1 : 0) | (f64 ? 2 : 0) | (columns ? 4 : 0), true);
  view.setUint32(8, placed.length + (redirects.length > 0 ? 1 : 0) + (columns ? 1 : 0), true);
  if (columns) {
    view.setUint32(16, columnsBytes, true);
    view.setUint16(20, 3, true);
    view.setUint32(24, columns.length, true);
    columns.forEach((c, j) => view.setUint16(28 + 2 * j, c, true));
  }

  for (const rows of placed) {
    const at = rows.at;
    view.setUint32(at, rows.bytes, true);
    view.setUint16(at + 4, 1, true);
    view.setUint32(at + 8, rows.n, true);
    u8[at + 12] = rows.parent.length;
    u8[at + 13] = rows.suffixes[0].length;
    u8[at + 14] = rows.keyWords;
    u8[at + 15] = rows.metrics.length;
    u8.set(ascii.encode(rows.parent), at + 20);
    for (let row = 0; row < rows.n; row++) {
      const words = keyWordsOf(rows.suffixes[row]);
      for (let w = 0; w < rows.keyWords; w++) {
        view.setUint32(at + rows.keysAt + 4 * (row * rows.keyWords + w), words[w], true);
      }
      view.setUint32(at + rows.countAt + 4 * row, rows.count[row], true);
      for (let j = 0; j < rows.metrics.length; j++) {
        const offset = at + rows.metricsAt + width * (j * rows.n + row);
        if (f64) view.setFloat64(offset, rows.metrics[j][row], true);
        else view.setFloat32(offset, rows.metrics[j][row], true);
      }
    }
  }

  if (redirects.length > 0) {
    view.setUint32(redirectsAt, size - redirectsAt, true);
    view.setUint16(redirectsAt + 4, 2, true);
    view.setUint32(redirectsAt + 8, redirects.length, true);
    let at = redirectsAt + 12;
    for (const { location, name, ip, port } of redirects) {
      view.setUint16(at, location.length, true);
      view.setUint16(at + 2, name.length, true);
      view.setUint16(at + 4, ip.length, true);
      view.setUint16(at + 6, port, true);
      u8.set(ascii.encode(location + name + ip), at + 8);
      at += pad(8 + location.length + name.length + ip.length, 4);
    }
  }
  return buffer;
}

/**
 * One section of `n` rows below `parent`, three characters deep, with
 * `metricCount` columns: enough rows to weigh something.
 */
export function wideBlock(parent, n, metricCount = 2) {
  const suffixes = new Array(n);
  const count = new Array(n);
  for (let i = 0; i < n; i++) {
    suffixes[i] =
      ROUTING_ALPHABET[(i >> 12) & 63] + ROUTING_ALPHABET[(i >> 6) & 63] + ROUTING_ALPHABET[i & 63];
    count[i] = i + 1;
  }
  const metrics = [];
  for (let j = 0; j < metricCount; j++) metrics.push(count.map((value) => value * (j + 1) + 0.5));
  return { parent, suffixes, count, metrics };
}
