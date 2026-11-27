// Checks shared by every read.

import { ROOT } from "../tree/alphabet.js";

export function normalizeNavigation(value) {
  return value === "direct" ? "direct" : "ingress";
}

export function normalizeMethod(value) {
  return value === "getSet" ? "getSet" : "getSets";
}

// IXB2 metrics of a read: their width, float32 unless float64 is asked for,
// and optionally the metric positions to send (`/sets?columns=`), as one
// string so that it travels with the read: "f32", "f64", "f32;0,13,14".
export function normalizeMetrics(value) {
  const [width, columns] = String(value ?? "").split(";");
  const base = width === "f64" ? "f64" : "f32";
  if (!columns || !/^\d+(,\d+)*$/.test(columns)) return base;
  return `${base};${columns}`;
}

/** {width, columns: number[] | null} of a normalized metrics string. */
export function readMetricsOption(value) {
  const [width, columns] = normalizeMetrics(value).split(";");
  return { width, columns: columns ? columns.split(",").map(Number) : null };
}

/** The metrics string of a width and a column list. */
export function metricsOption(width = "f32", columns = null) {
  return normalizeMetrics(columns?.length ? `${width};${columns.join(",")}` : width);
}

// Load/cancellation is not evidence that a contact left the mesh. Evicting
// these peers made a single slow read permanently hide its zones this session.
export function transientReadFailure(error) {
  return (
    [408, 429, 500, 502, 503, 504].includes(error?.response?.status) ||
    ["ECONNABORTED", "ETIMEDOUT", "ERR_CANCELED"].includes(error?.code)
  );
}

/** A read stopped by its caller (its signal, or the transport's abort), not a failure. */
export function isCanceled(error, signal) {
  return (
    signal?.aborted === true ||
    error?.name === "AbortError" ||
    error?.name === "CanceledError" ||
    error?.code === "ERR_CANCELED"
  );
}

export function randomRoutingKey(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

// Shared bit prefix length — the ordering Table#nearest walks, so it tells
// whether a hinted peer is really closer in our own view of the mesh.
export function commonPrefixBits(a, b) {
  const len = Math.min(a.length, b.length);
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const diff = a[i] ^ b[i];
    if (diff === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(diff) - 24;
  }
  return bits;
}

/**
 * @param {import("../wire/block.js").RowsBlock[]} blocks
 * @returns {Set<string>} requested zones that got at least one section
 */
export function zonesWithRows(blocks) {
  const zones = new Set();
  for (const block of blocks) zones.add(block.parent || ROOT);
  return zones;
}

/**
 * @param {Array<import("./setsRaw.js").RawChunk | undefined>} chunks
 * @returns {import("./setsRaw.js").RawChunk} each answer once, whatever the number of chunks or
 *   reads that carried it
 */
export function mergeRawChunks(chunks) {
  const responses = new Set();
  const empty = new Set();
  for (const chunk of chunks) {
    if (!chunk) continue;
    for (const response of chunk.responses) responses.add(response);
    for (const location of chunk.empty) empty.add(location);
  }
  return { responses: [...responses], empty: [...empty] };
}
