import { peerUrl, requestPeer } from "./transport.js";

// Unlike /sets, JSON /set preserves full record locations and IDs. Refresh
// bypasses derived unary summaries; callers restrict this to small prefixes.
export async function getZone(protocol, peer, collection, location, options = {}) {
  const url = `${peerUrl(protocol, peer.ip(), peer.port(), "/set", options.gateway)}?collection=${encodeURIComponent(collection)}&location=${encodeURIComponent(location)}&deep=true&refresh=true`;
  const response = await requestPeer(url, options, { timeout: 10000 });
  if (!response.data?.set || typeof response.data.set !== "object") {
    throw new Error("Unresolved terminal record read");
  }
  return response.data.set;
}
