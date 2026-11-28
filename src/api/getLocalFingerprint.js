import { checkLocation, checkName } from "../tree/alphabet.js";
import { mergeSubtreeFingerprints } from "../walk/subtreeFingerprint.js";
import { peerUrl, requestPeer } from "./transport.js";

export async function getLocalFingerprint(protocol, peer, collection, location, options = {}) {
  checkName(collection);
  checkLocation(location);
  const url = peerUrl(protocol, peer.ip(), peer.port(), "/zones/fingerprint/local", options.gateway);
  const { status, data } = await requestPeer(url, options, {
    params: { collection, location },
    redirect: "error"
  });
  if (status !== 200 || data?.collection !== collection || data.location !== location || data.complete !== false)
    throw new Error("Invalid local fingerprint response");
  const { fingerprint, guard, monoid } = data;
  if (fingerprint === null && guard === null && monoid === null) return data;
  if (typeof fingerprint !== "string" || !fingerprint || typeof guard !== "string" || !guard)
    throw new Error("Invalid local fingerprint witness");
  mergeSubtreeFingerprints([monoid]);
  return data;
}
