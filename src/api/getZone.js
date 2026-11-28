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

// A peer-local observation. A missing entry never starts a terminal read.
export async function getCachedZone(protocol, peer, collection, location, options = {}) {
  const { maxAgeMs } = options;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)
    throw new RangeError("maxAgeMs must be a positive integer");

  const url = peerUrl(protocol, peer.ip(), peer.port(), "/set/cached", options.gateway);
  const response = await requestPeer(url, options, {
    params: { collection, location, max_age: `${maxAgeMs}ms` },
    redirect: "error",
    timeout: 10000,
  });
  if (response.status === 204) return null;
  const { set, source, observed_at: observedAt } = response.data ?? {};
  if (
    response.status !== 200 ||
    source !== "cache" ||
    !set ||
    typeof set !== "object" ||
    Array.isArray(set) ||
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt))
  ) throw new Error("Invalid cached zone response");
  return { set, observedAt };
}
