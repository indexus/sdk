// IXRB: the records of a /records read, binary (core/docs/protocol/wire-block.md,
// "/records?format=binary"). Little endian:
//
//   "IXRB" | u8 version (2 or 3) | 3 × u8 0 | u32 count | count × record
//   record: u16 n, location | u16 n, id | u8 flags | f64 weight |
//           u8 n, n × f64 metrics | u32 n | 0 to 3 × u8 0 | payload
//   version 3 counts the metrics on u16 (a record wider than 255 metrics,
//   an embedding, is in the answer)
//   flags:  bit 0  the payload is raw bytes; else JSON text
//
// Every payload starts at a body offset that is a multiple of 4. Records
// come back in the shape of the JSON answer, except that a binary payload is
// a Uint8Array view on the body instead of a base64 string: when the body
// itself sits at a 4-byte offset (a fetched ArrayBuffer does), the view can
// be read as 32-bit words in place.

export const RECORDS_CONTENT_TYPE = "application/vnd.indexus.records";

const VERSION = 2;
const WIDE = 3;
const HEADER_BYTES = 12;
const BINARY = 1;
const utf8 = new TextDecoder();

/**
 * @param {string} collection the request's
 * @param {ArrayBuffer | Uint8Array} body
 * @returns {Array<{collection: string, location: string, id: string, metrics: number[] | null,
 *   payload?: unknown, weight?: number, binary?: true}>}
 */
export function decodeRecords(collection, body) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_BYTES || utf8.decode(bytes.subarray(0, 4)) !== "IXRB") {
    throw new Error("records: not IXRB");
  }
  if ((bytes[4] !== VERSION && bytes[4] !== WIDE) || bytes[5] | bytes[6] | bytes[7]) {
    throw new Error(`records: IXRB version ${bytes[4]}, this client reads ${VERSION} and ${WIDE}`);
  }
  const wide = bytes[4] === WIDE;
  const count = view.getUint32(8, true);
  let at = HEADER_BYTES;
  const take = (n) => {
    if (n > bytes.length - at) throw new Error("records: truncated IXRB");
    at += n;
    return at - n;
  };
  // A plain Uint8Array view, also when the body is a Node Buffer.
  const slice = (n) => new Uint8Array(bytes.buffer, bytes.byteOffset + take(n), n);
  const text = () => slice(view.getUint16(take(2), true));
  const payloadOf = () => {
    const n = view.getUint32(take(4), true);
    const pad = take((4 - (at % 4)) % 4);
    for (let i = pad; i < at; i++) {
      if (bytes[i] !== 0) throw new Error("records: IXRB padding is not zero");
    }
    return slice(n);
  };
  const records = [];
  for (let i = 0; i < count; i++) {
    const location = utf8.decode(text());
    const id = utf8.decode(text());
    const head = take(9);
    const flags = bytes[head];
    const weight = view.getFloat64(head + 1, true);
    const metricCount = wide ? view.getUint16(take(2), true) : bytes[take(1)];
    const metricsAt = take(8 * metricCount);
    const metrics = [];
    for (let j = 0; j < metricCount; j++) metrics.push(view.getFloat64(metricsAt + 8 * j, true));
    const payload = payloadOf();
    // The JSON answer omits what Go omits: no payload, weight 0, binary false.
    const record = { collection, location, id, metrics: metricCount > 0 ? metrics : null };
    if (flags & BINARY) record.payload = payload;
    else if (payload.length > 0) record.payload = JSON.parse(utf8.decode(payload));
    if (weight !== 0) record.weight = weight;
    if (flags & BINARY) record.binary = true;
    records.push(record);
  }
  if (at !== bytes.length) throw new Error("records: bytes after the last IXRB record");
  return records;
}

/** A binary record of a JSON answer (older node): its base64 payload as bytes. */
export function binaryPayload(record) {
  if (!record?.binary || typeof record.payload !== "string") return record;
  const raw = atob(record.payload);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { ...record, payload: bytes };
}
