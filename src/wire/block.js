// IXB2 `/sets` blocks: core/docs/protocol/wire-block.md. Every column is a
// view on the response buffer, so a block can go to a GPUBuffer as it came.

import { ROUTING_ALPHABET, Item, Set } from "../tree/index.js";

export const BLOCK_CONTENT_TYPE = "application/vnd.indexus.block";

const MAGIC = [0x49, 0x58, 0x42, 0x32]; // IXB2
const HEADER_BYTES = 16;
const SECTION_HEADER_BYTES = 8;
const ROWS_HEADER_BYTES = 12;
const KIND_ROWS = 1;
const KIND_REDIRECTS = 2;
const KIND_COLUMNS = 3;
// More than 255 metrics (an embedding): a 16-byte rows header ending in a
// u32 metric count.
const KIND_WIDE_ROWS = 4;
const WIDE_ROWS_HEADER_BYTES = 16;
const MAX_METRICS = 4096;
const FLAG_F64 = 1 << 1;
const FLAG_COLUMNS = 1 << 2;

// Typed arrays read in host byte order; the format is little-endian. A
// big-endian host would need a copy per column, which defeats the format.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

const ascii = new TextDecoder();

function pad4(n) {
  return (n + 3) & ~3;
}

function pad8(n) {
  return (n + 7) & ~7;
}

/**
 * One rows section; see docs/layers.md §2.
 * @typedef {{
 *   parent: string, suffixChars: number, keyWords: number, metricCount: number,
 *   revision: number, n: number, metricBytes: 4 | 8,
 *   keys: Uint32Array, count: Uint32Array, metrics: Float32Array | Float64Array,
 * }} RowsBlock
 * @typedef {{ location: string, name: string, ip: string, port: number }} Redirect
 */

/**
 * @param {ArrayBuffer | Uint8Array} buffer whole IXB2 body; a view must start
 *   on a 4-byte boundary of its buffer, 8 when metrics are f64
 * @returns {{ blocks: RowsBlock[], redirects: Redirect[], columns: number[] | null }}
 *   `columns`: the metric positions a `columns=` read selected (metric j of
 *   every block is metric columns[j] of the records), null for all of them
 */
export function decodeBlocks(buffer) {
  if (!LITTLE_ENDIAN) throw new Error("ixb2: big-endian host");
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.byteOffset % 4 !== 0) throw new Error("ixb2: buffer not aligned on 4 bytes");
  if (u8.byteLength < HEADER_BYTES) throw new Error("ixb2: truncated header");
  for (let i = 0; i < MAGIC.length; i++) {
    if (u8[i] !== MAGIC[i]) throw new Error("ixb2: bad magic");
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.getUint16(4, true) !== HEADER_BYTES) throw new Error("ixb2: bad header size");
  const f64 = (view.getUint16(6, true) & FLAG_F64) !== 0;
  if (f64 && u8.byteOffset % 8 !== 0) throw new Error("ixb2: f64 buffer not aligned on 8 bytes");
  const sectionCount = view.getUint32(8, true);

  const blocks = [];
  const redirects = [];
  let columns = null;
  let offset = HEADER_BYTES;
  for (let i = 0; i < sectionCount; i++) {
    if (offset + SECTION_HEADER_BYTES > u8.byteLength)
      throw new Error("ixb2: truncated section header");
    const size = view.getUint32(offset, true);
    const kind = view.getUint16(offset + 4, true);
    if (size < SECTION_HEADER_BYTES || size % 4 !== 0) throw new Error("ixb2: bad section size");
    if (offset + size > u8.byteLength) throw new Error("ixb2: section overruns body");
    const body = offset + SECTION_HEADER_BYTES;
    const end = offset + size;
    if (kind === KIND_ROWS) blocks.push(readRows(u8, view, body, end, f64, false));
    else if (kind === KIND_WIDE_ROWS) blocks.push(readRows(u8, view, body, end, f64, true));
    else if (kind === KIND_REDIRECTS) readRedirects(u8, view, body, end, redirects);
    else if (kind === KIND_COLUMNS) columns = readColumns(view, body, end);
    offset = end;
  }
  if (offset !== u8.byteLength) throw new Error("ixb2: trailing bytes after sections");
  if (((view.getUint16(6, true) & FLAG_COLUMNS) !== 0) !== (columns !== null))
    throw new Error("ixb2: columns flag and section disagree");
  if (columns && blocks.some((block) => block.metricCount !== columns.length))
    throw new Error("ixb2: a rows section does not have the selected columns");
  return { blocks, redirects, columns };
}

function readRows(u8, view, start, end, f64, wide) {
  const header = wide ? WIDE_ROWS_HEADER_BYTES : ROWS_HEADER_BYTES;
  if (start + header > end) throw new Error("ixb2: truncated rows header");
  const n = view.getUint32(start, true);
  const parentLength = u8[start + 4];
  const suffixChars = u8[start + 5];
  const keyWords = u8[start + 6];
  const metricCount = wide ? view.getUint32(start + 12, true) : u8[start + 7];
  const revision = view.getUint32(start + 8, true);
  if (wide && (u8[start + 7] !== 0 || metricCount <= 255 || metricCount > MAX_METRICS))
    throw new Error("ixb2: bad wide rows header");
  if (keyWords !== Math.ceil((6 * suffixChars) / 32))
    throw new Error("ixb2: key words do not match suffix");

  const parentAt = start + header;
  const keysAt = parentAt + pad4(parentLength);
  const countAt = keysAt + 4 * n * keyWords;
  // f64 columns start on a multiple of 8 from the start of the body.
  const metricBytes = f64 ? 8 : 4;
  const metricsAt = f64 && metricCount > 0 ? pad8(countAt + 4 * n) : countAt + 4 * n;
  if (metricsAt + metricBytes * n * metricCount > end)
    throw new Error("ixb2: rows overrun section");

  const base = u8.byteOffset;
  return {
    parent: ascii.decode(u8.subarray(parentAt, parentAt + parentLength)),
    suffixChars,
    keyWords,
    metricCount,
    revision,
    n,
    metricBytes,
    keys: new Uint32Array(u8.buffer, base + keysAt, n * keyWords),
    count: new Uint32Array(u8.buffer, base + countAt, n),
    // An empty f64 column takes no padding, so it may sit off 8: view it at 0.
    metrics: f64
      ? new Float64Array(u8.buffer, metricCount > 0 ? base + metricsAt : 0, n * metricCount)
      : new Float32Array(u8.buffer, base + metricsAt, n * metricCount),
  };
}

function readColumns(view, start, end) {
  if (start + 4 > end) throw new Error("ixb2: truncated columns");
  const count = view.getUint32(start, true);
  if (count < 1 || count > MAX_METRICS || start + 4 + 2 * count > end)
    throw new Error("ixb2: bad columns section");
  return Array.from({ length: count }, (_, j) => view.getUint16(start + 4 + 2 * j, true));
}

function readRedirects(u8, view, start, end, out) {
  if (start + 4 > end) throw new Error("ixb2: truncated redirects");
  const count = view.getUint32(start, true);
  let offset = start + 4;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > end) throw new Error("ixb2: truncated redirect");
    const locationLength = view.getUint16(offset, true);
    const nameLength = view.getUint16(offset + 2, true);
    const ipLength = view.getUint16(offset + 4, true);
    const port = view.getUint16(offset + 6, true);
    const location = offset + 8;
    const name = location + locationLength;
    const ip = name + nameLength;
    const next = offset + pad4(8 + locationLength + nameLength + ipLength);
    if (next > end) throw new Error("ixb2: redirect overruns section");
    out.push({
      location: ascii.decode(u8.subarray(location, name)),
      name: ascii.decode(u8.subarray(name, ip)),
      ip: ascii.decode(u8.subarray(ip, ip + ipLength)),
      port,
    });
    offset = next;
  }
}

/**
 * Key of one row below its parent, as text. For tests and edges only: the hot
 * path keeps the words.
 * @param {RowsBlock} block
 * @param {number} row
 * @returns {string}
 */
export function suffixAt(block, row) {
  const words = block.keys;
  const first = row * block.keyWords;
  let suffix = "";
  for (let i = 0; i < block.suffixChars; i++) {
    const bit = 6 * i;
    const w = first + (bit >>> 5);
    const o = bit & 31;
    const index =
      o <= 26
        ? (words[w] >>> (26 - o)) & 63
        : ((words[w] << (o - 26)) | (words[w + 1] >>> (58 - o))) & 63;
    suffix += ROUTING_ALPHABET[index];
  }
  return suffix;
}

// v1 carries three metrics of an Abelian (core/indexus/wire.go
// SetWireProperties): metric 2 truncated to an integer, metrics 3 and 4, and
// nothing at 0 and 1. The element layer still reads that shape: an app's
// heat rules may read metrics 0 and 1 only when they are there, so filling
// them could change the heatmap of every aggregated cell, and would fill the
// viewport averages that v1 leaves empty. Elements keep the v1 view
// until that change is decided; the blocks keep every column.
const V1_METRICS = [2, 3, 4];

function v1MetricsAt(metrics, n, metricCount, row) {
  const values = [];
  for (const j of V1_METRICS) {
    const value = j < metricCount ? metrics[j * n + row] : 0;
    values[j] = j === 2 ? Math.trunc(value) : value;
  }
  return values;
}

/**
 * Transitional: the Item/Set shape the rest of the SDK reads from v1, so the
 * caches and walks work unchanged until the store keeps blocks (wave 2). This
 * is the only IXB2 function that creates objects per row. Metrics take the v1
 * view (see V1_METRICS).
 *
 * Sections never repeat a key, but two sections can name the same location
 * (two requested parents), so rows are folded by location like v1 does.
 *
 * @param {string} collection
 * @param {RowsBlock[]} blocks
 * @param {{ folded: number }} [stats] out-param: rows absorbed into another
 * @returns {Array<Item|Set>}
 */
export function blocksToElements(collection, blocks, stats = null) {
  /** @type {Map<string, { count: number, metrics: number[] }>} */
  const rows = new Map();
  let folded = 0;
  for (const block of blocks) {
    const { n, metricCount, count, metrics } = block;
    for (let row = 0; row < n; row++) {
      const location = block.parent + suffixAt(block, row);
      const values = v1MetricsAt(metrics, n, metricCount, row);
      const existing = rows.get(location);
      if (existing) {
        folded++;
        existing.count += count[row];
        for (const j of V1_METRICS) existing.metrics[j] += values[j];
        continue;
      }
      rows.set(location, { count: count[row], metrics: values });
    }
  }
  if (stats) stats.folded = folded;

  const elements = [];
  for (const [location, { count, metrics }] of rows) {
    const element =
      count === 1
        ? new Item(collection, location, metrics, location)
        : new Set(collection, location, count, metrics);
    // Like v1: keys are truncated and lost their record IDs, so these are
    // drill proxies, never final records.
    element._terminal = false;
    elements.push(element);
  }
  return elements;
}
