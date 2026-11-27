import { peerUrl, requestPeer } from "./transport.js";

import { BLOCK_CONTENT_TYPE, decodeBlocks } from "../wire/block.js";
import { encodeUrl64 } from "../utilities/url64.js";
import { readMetricsOption } from "../network/helpers.js";
import { debugEnabled, debugLog } from "../utilities/debug.js";

/**
 * @param {Record<string, string>} headers
 * @returns {{ name: string, ip: string, port: number } | null}
 */
function ingressFromHeaders(headers) {
  const name = headers["x-indexus-ingress-name"];
  const ip = headers["x-indexus-ingress-ip"];
  const port = Number(headers["x-indexus-ingress-port"]);
  if (!name || !ip || !(port > 0)) return null;
  return { name, ip, port };
}

/**
 * Batch fetch via GET `/sets` as IXB2 blocks (core/docs/protocol/wire-block.md),
 * for ingress and direct navigation alike; redirects come in the block's own
 * section. Float64 metrics when `metrics: "f64"`. An answer in another format
 * (a node older than IXB2) is a read error.
 *
 * @param {string} protocol
 * @param {import("../wire/peer.js").Peer} peer
 * @param {string} collection
 * @param {string[]} locations
 * @param {{
 *   deep?: boolean,
 *   refresh?: boolean,
 *   envelope?: boolean,
 *   via?: string | string[],
 *   routingKey?: Uint8Array,
 *   gateway?: string,
 *   metrics?: string,
 * }} [options] `metrics`: "f32", "f64", or with the columns to send, "f32;0,13,14"
 * @returns {Promise<{
 *   format: "block",
 *   buffer: ArrayBuffer | null,
 *   blocks: import("../wire/block.js").RowsBlock[],
 *   redirects: Array<{ location: string, name: string, ip: string, port: number }>,
 *   ingress?: { name: string, ip: string, port: number } | null,
 *   bytes?: number,
 *   wireBytes?: number,
 *   rows?: number,
 * }>} `buffer` is the whole body, alone in its ArrayBuffer so it can be
 *   transferred; `blocks` are views on it.
 */
// Resource Timing also measures chunked compressed responses, which have no
// Content-Length. Never attribute an older request's size to the current one.
export function responseWireBytes(headers, timings = [], startedAt = 0) {
  const entry = timings.findLast(
    (entry) => entry.startTime >= startedAt && entry.encodedBodySize > 0,
  );
  if (entry) return entry.encodedBodySize;
  const size = Number(headers?.["content-length"]);
  return Number.isFinite(size) && size >= 0 ? size : NaN;
}

function isBlockResponse(headers) {
  const type = String(headers?.["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return type === BLOCK_CONTENT_TYPE;
}

function rawBlockResponse(bytes) {
  // The buffer goes to the store, then to another thread: it must hold the
  // body and nothing else. A browser hands exactly that; Node may hand a
  // slice of a pooled buffer, which costs one copy.
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  const buffer = whole ? bytes.buffer : bytes.slice().buffer;
  const { blocks, redirects, columns } = decodeBlocks(buffer);
  const rows = blocks.reduce((sum, block) => sum + block.n, 0);
  return { format: "block", buffer, blocks, redirects, columns, rows };
}

export async function getSets(protocol, peer, collection, locations, options = {}) {
  const cleaned = Array.isArray(locations)
    ? locations.map((s) => String(s).trim()).filter(Boolean)
    : [];

  if (cleaned.length === 0) {
    return { format: "block", buffer: null, blocks: [], redirects: [], ingress: null };
  }

  const deep = options.deep !== false;
  const refresh = options.refresh === true;
  const envelope = options.envelope === true || (!deep && options.envelope !== false);
  const locationsParam = cleaned.join(",");
  let url = `${peerUrl(protocol, peer.ip(), peer.port(), "/sets", options.gateway)}?collection=${encodeURIComponent(
    collection,
  )}&location=${encodeURIComponent(locationsParam)}&deep=${
    deep ? "true" : "false"
  }&refresh=${refresh ? "true" : "false"}`;
  if (envelope) {
    url += "&envelope=1";
  }
  url += "&format=block";
  const { width, columns } = readMetricsOption(options.metrics);
  if (width === "f64") url += "&metrics=f64";
  if (columns) url += `&columns=${columns.join(",")}`;
  if (options.via != null && options.via !== "") {
    const via = Array.isArray(options.via)
      ? options.via.filter(Boolean).join(",")
      : String(options.via);
    if (via) url += `&via=${encodeURIComponent(via)}`;
  }

  /** @type {Record<string, string>} */
  const extra = {};
  if (options.routingKey instanceof Uint8Array && options.routingKey.length > 0) {
    extra["X-Indexus-Routing-Key"] = encodeUrl64(options.routingKey);
  }

  const startedAt = globalThis.performance?.now?.() ?? 0;
  const response = await requestPeer(url, options, {
    responseType: "arraybuffer",
    headers: extra,
  });

  const ingress = ingressFromHeaders(response.headers);
  // Present only when the node sent an unchunked body: with `Content-Encoding:
  // gzip` it is the compressed size, so it tells what the link actually carried
  // while `bytes` below stays the decoded frame the browser handed us.
  const timings = globalThis.performance?.getEntriesByName?.(url) ?? [];
  const wireBytes = responseWireBytes(response.headers, timings, startedAt);

  const raw = response.data;
  const bytes =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : ArrayBuffer.isView(raw)
        ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : new Uint8Array();
  if (!isBlockResponse(response.headers)) {
    throw new Error(`/sets answered ${response.headers?.["content-type"]}, not IXB2`);
  }
  const decoded = rawBlockResponse(bytes);
  const { redirects, rows } = decoded;

  if (debugEnabled("sets")) {
    debugLog("sets", "decoded", {
      collection,
      asked: cleaned.length,
      first: cleaned[0],
      refresh,
      envelope,
      redirects: redirects.length,
      bytes: bytes.byteLength,
      rows,
    });
  }

  return {
    ...decoded,
    ingress,
    bytes: bytes.byteLength,
    wireBytes: bytes.byteLength ? wireBytes : 0,
    rows,
  };
}
