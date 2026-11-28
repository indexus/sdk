import { checkLocation, checkName, isDirectChild, LOCATION_ALPHABET } from "../tree/alphabet.js";
import { peerUrl, requestPeer } from "./transport.js";

// A peer can only report the direct child addresses it currently knows locally.
export async function getLocalChildren(protocol, peer, collection, location, options = {}) {
  checkName(collection);
  checkLocation(location);
  const { includeUncertain = false } = options;
  if (typeof includeUncertain !== "boolean") throw new TypeError("Expected boolean includeUncertain");
  const params = { collection, location };
  if (includeUncertain) params.include_uncertain = "true";
  const url = peerUrl(protocol, peer.ip(), peer.port(), "/zones/children/local", options.gateway);
  const { status, data } = await requestPeer(url, options, { params, redirect: "error" });
  if (status !== 200 || (includeUncertain && data?.include_uncertain !== true) ||
      data?.complete !== false || !Array.isArray(data.children) ||
      data.children.length > LOCATION_ALPHABET.length) throw new Error("Invalid local children response");
  const seen = new Set();
  for (const child of data.children) {
    checkLocation(child);
    if (!isDirectChild(location, child) || seen.has(child)) throw new Error("Invalid local child address");
    seen.add(child);
  }
  return { children: data.children, complete: false };
}
