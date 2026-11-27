import { peerUrl, requestPeer } from "./transport.js";
import { RECORDS_CONTENT_TYPE, decodeRecords, binaryPayload } from "../wire/records.js";

// Asks for IXRB (format=binary); a node older than IXRB ignores the flag and
// answers JSON. Either way a binary record's payload comes back as bytes.
export async function getContentRecords(protocol, peer, collection, location, limit, options = {}) {
  const query = new URLSearchParams({
    collection,
    location,
    limit: String(limit),
    format: "binary",
  });
  const { headers, data } = await requestPeer(
    `${peerUrl(protocol, peer.ip(), peer.port(), "/records", options.gateway)}?${query}`,
    options,
    { timeout: 30000, responseType: "arraybuffer" },
  );
  const type = String(headers?.["content-type"] ?? "")
    .split(";")[0]
    .trim();
  const records =
    type === RECORDS_CONTENT_TYPE
      ? decodeRecords(collection, data)
      : JSON.parse(new TextDecoder().decode(data))?.records?.map(binaryPayload);
  if (!Array.isArray(records) || records.length > limit)
    throw new Error("Invalid content record response");
  return records;
}
