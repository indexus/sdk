import { requestLocalPeer } from "./transport.js";
import { MAX_CONTENT_RECORDS } from "./wire.js";

// This bounded RPC addresses exactly one peer and one location. A conflict,
// budget error or unavailable authority is returned to the caller's walker.
export async function getDirectRecords(protocol, peer, collection, location, limit, options = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONTENT_RECORDS)
    throw new RangeError("Invalid direct record budget");
  const { includePayloads = false } = options;
  if (typeof includePayloads !== "boolean") throw new TypeError("Expected a boolean includePayloads flag");
  const params = { collection, location, limit: String(limit) };
  if (includePayloads) params.payloads = "true";
  const { status, data } = await requestLocalPeer(protocol, peer, "/records/direct", params, options);
  if (status !== 200 || (includePayloads && data?.payloads !== true) || !Array.isArray(data?.records) || data.records.length > limit)
    throw new Error("Invalid direct record response");
  const ids = new Set();
  for (const row of data.records) {
    if (row?.collection !== collection || row.location !== location ||
        typeof row.id !== "string" || !row.id || ids.has(row.id) ||
        (!Array.isArray(row.metrics) || !row.metrics.every(Number.isFinite)))
      throw new Error("Invalid direct record row");
    ids.add(row.id);
  }
  return data.records;
}
