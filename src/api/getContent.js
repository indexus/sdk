import { authHeaders, peerUrl } from "./transport.js";
// The consumer runs inside Network's wire slot until the body is consumed.
// Fetch decodes HTTP gzip incrementally; no JSON/base64 envelope or JS inflate.
export async function getContent(protocol, peer, collection, location, options = {}) {
  const query = new URLSearchParams({
    collection,
    location,
    path: options.path,
    encoding: options.compression ?? "auto",
  });
  const response = await fetch(
    `${peerUrl(protocol, peer.ip(), peer.port(), "/content", options.gateway)}?${query}`,
    { headers: authHeaders(), signal: options.signal, cache: "no-store" },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("Indexus content HTTP " + response.status);
  }
  try {
    return await options.consume(response);
  } catch (error) {
    try {
      await response.body?.cancel();
    } catch {}
    throw error;
  }
}
