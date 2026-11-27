/**
 * Collection descriptions (IXC1), as go-indexus-core internal/algebra reads
 * them: the mathematical object a collection is named by
 * (docs/protocol/collection-description.md). A client fetches the bytes with
 * GET /collection/<name>, checks that the name is their hash, and combines
 * the values of zones column by column, in cell order.
 *
 * Golden vectors: testdata/description_vectors.json, written by the Go code.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const DOMAIN = "indexus.collection.v1\u0000";

/** Column kinds, by their code in a schema. */
export const KINDS = ["sum", "min", "max", "first", "last", "affine.a", "affine.b"];
const RUN_AFFINE = 5;
export const MAX_COLUMNS = 4096;

function fail(why) {
  throw new Error(`indexus: not a canonical collection description (${why})`);
}

/**
 * Decode IXC1 bytes. The bytes must be canonical: encoding the result gives
 * them back.
 * @param {Uint8Array} bytes
 */
export function decodeDescription(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) fail("short");
    const from = at;
    at += n;
    return from;
  };
  const head = need(8);
  if (String.fromCharCode(...bytes.subarray(head, head + 4)) !== "IXC1" || bytes[head + 4] !== 1 || bytes[head + 7] !== 0) fail("header");
  const bitsPerChar = bytes[head + 5];
  const width = bytes[head + 6];
  const nonce = bytes.slice(need(16), at);
  const depths = need(2);
  const recordDepths = [bytes[depths], bytes[depths + 1]];
  const axisCount = bytes[need(1)];
  const axes = [];
  for (let a = 0; a < axisCount; a++) {
    const p = need(16);
    axes.push([view.getFloat64(p, true), view.getFloat64(p + 8, true)]);
  }
  let schedule = [];
  if (axisCount > 0 && bitsPerChar * width > 0) {
    const p = need(bitsPerChar * width);
    schedule = Array.from(bytes.subarray(p, p + bitsPerChar * width));
  }
  const runs = view.getUint16(need(2), true);
  const schema = [];
  for (let r = 0; r < runs; r++) {
    const p = need(3);
    const code = bytes[p];
    const count = view.getUint16(p + 1, true);
    if (count === 0 || code > RUN_AFFINE || schema.length + count > MAX_COLUMNS) fail("schema run");
    for (let c = 0; c < count; c++) {
      if (code === RUN_AFFINE) schema.push("affine.a", "affine.b");
      else schema.push(KINDS[code]);
    }
  }
  if (at !== bytes.length) fail("trailing bytes");
  const description = { bitsPerChar, width, nonce, recordDepths, axes, schedule, schema };
  const again = encodeDescription(description);
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) fail("not canonical");
  return description;
}

/** The IXC1 bytes of a description (the inverse of decodeDescription). */
export function encodeDescription({ bitsPerChar, width, nonce, recordDepths, axes, schedule, schema }) {
  const out = [];
  const u16 = (n) => out.push(n & 0xff, (n >> 8) & 0xff);
  const f64 = (x) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, x, true);
    out.push(...b);
  };
  out.push(0x49, 0x58, 0x43, 0x31, 1, bitsPerChar, width, 0, ...nonce, recordDepths[0], recordDepths[1], axes.length);
  for (const [min, max] of axes) {
    f64(min);
    f64(max);
  }
  if (axes.length > 0) out.push(...schedule);
  const runs = [];
  for (let i = 0; i < schema.length; i++) {
    let code = KINDS.indexOf(schema[i]);
    if (schema[i] === "affine.a") {
      code = RUN_AFFINE;
      i++;
    }
    if (runs.length > 0 && runs[runs.length - 1][0] === code) runs[runs.length - 1][1]++;
    else runs.push([code, 1]);
  }
  u16(runs.length);
  for (const [code, count] of runs) {
    out.push(code);
    u16(count);
  }
  return Uint8Array.from(out);
}

/** The collection name of IXC1 bytes: the first 96 bits of their SHA-256. */
export async function descriptionName(bytes) {
  const domain = new TextEncoder().encode(DOMAIN);
  const input = new Uint8Array(domain.length + bytes.length);
  input.set(domain);
  input.set(bytes, domain.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
  let name = "";
  for (let i = 0; i < 16; i++) {
    const bit = i * 6;
    const v = (digest[bit >> 3] << 8) | digest[(bit >> 3) + 1];
    name += ALPHABET[(v >> (10 - (bit % 8))) & 63];
  }
  return name;
}

/**
 * Decode a description received for a collection and check that the name
 * is its hash: the client trusts no node for the algebra.
 */
export async function verifyDescription(name, bytes) {
  const description = decodeDescription(bytes);
  if ((await descriptionName(bytes)) !== name) {
    throw new Error(`indexus: the description does not match the collection name ${name}`);
  }
  return description;
}

/** Whether combining needs the description: a column that is not a sum. */
export function isTyped(description) {
  return description != null && description.schema.some((k) => k !== "sum");
}

/**
 * The key that sorts locations in cell order: one rank per character, the
 * rotation of the name removed. A prefix sorts before its extensions; "@",
 * the root, is the empty key.
 */
export function cellOrder(bitsPerChar, name, location) {
  if (location === "@") return [];
  const size = 1 << bitsPerChar;
  const out = new Array(location.length);
  for (let l = 0; l < location.length; l++) {
    const rot = ALPHABET.indexOf(name[l % name.length]) % size; // a rotation within the base
    out[l] = (ALPHABET.indexOf(location[l]) - rot + size) % size;
  }
  return out;
}

/** Compares two cellOrder keys, as Go's bytes.Compare. */
export function compareCellOrder(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

/** The identity of combine. */
export function zeroValue(schema) {
  return {
    count: 0,
    cols: schema.map((k) => (k === "min" ? Infinity : k === "max" ? -Infinity : k === "affine.a" ? 1 : 0)),
  };
}

/** The value of one record. */
export function liftValue(schema, metrics, count = 1) {
  return { count, cols: schema.map((_, i) => metrics[i] ?? 0) };
}

/** left then right, left preceding right in cell order. */
export function combineValues(schema, left, right) {
  if (left.count === 0) return { count: right.count, cols: right.cols.slice() };
  if (right.count === 0) return { count: left.count, cols: left.cols.slice() };
  const cols = new Array(schema.length);
  for (let i = 0; i < schema.length; i++) {
    const l = left.cols[i];
    const r = right.cols[i];
    switch (schema[i]) {
      case "sum":
        cols[i] = l + r;
        break;
      case "min":
        cols[i] = Math.min(l, r);
        break;
      case "max":
        cols[i] = Math.max(l, r);
        break;
      case "first":
        cols[i] = l;
        break;
      case "last":
        cols[i] = r;
        break;
      case "affine.a":
        cols[i] = l * r;
        cols[i + 1] = r * left.cols[i + 1] + right.cols[i + 1];
        i++;
        break;
      default:
        throw new Error(`indexus: unknown column kind ${schema[i]}`);
    }
  }
  return { count: left.count + right.count, cols };
}

/**
 * Fold values keyed by location, in cell order (ties by id): the value of a
 * zone from its children's values, or from its records.
 * @param {{bitsPerChar: number, schema: string[]}} description
 * @param {string} name the collection name (its rotation)
 * @param {{location: string, id?: string, value: {count: number, cols: number[]}}[]} parts
 */
export function foldInCellOrder(description, name, parts) {
  const keyed = parts.map((p) => ({ key: cellOrder(description.bitsPerChar, name, p.location), id: p.id ?? "", value: p.value }));
  keyed.sort((a, b) => compareCellOrder(a.key, b.key) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let acc = zeroValue(description.schema);
  for (const p of keyed) acc = combineValues(description.schema, acc, p.value);
  return acc;
}
