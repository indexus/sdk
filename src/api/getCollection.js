import { authHeaders, peerUrl } from "./transport.js";
import { verifyDescription } from "../tree/description.js";

// GET /collection/<name>: the collection's description (IXC1), verified
// against its name here, or null for a collection without one (legacy: every
// column is a sum).
export async function getCollection(protocol, peer, name, options = {}) {
  const response = await fetch(peerUrl(protocol, peer.ip(), peer.port(), `/collection/${name}`, options.gateway), {
    headers: authHeaders(),
    signal: options.signal,
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("Indexus collection HTTP " + response.status);
  }
  return verifyDescription(name, new Uint8Array(await response.arrayBuffer()));
}
