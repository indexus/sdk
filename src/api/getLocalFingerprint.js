import { checkLocation, checkName } from "../tree/alphabet.js";
import { mergeSubtreeFingerprints } from "../walk/subtreeFingerprint.js";
import { requestLocalPeer } from "./transport.js";

export async function getLocalFingerprint(protocol, peer, collection, location, options = {}) {
  checkName(collection);
  checkLocation(location);
  const { status, data } = await requestLocalPeer(protocol, peer, "/zones/fingerprint/local", { collection, location }, options);
  if (status !== 200 || data?.collection !== collection || data.location !== location || data.complete !== false)
    throw new Error("Invalid local fingerprint response");
  const { fingerprint, guard, monoid } = data;
  if (fingerprint === null && guard === null && monoid === null) return data;
  if (typeof fingerprint !== "string" || !fingerprint || typeof guard !== "string" || !guard)
    throw new Error("Invalid local fingerprint witness");
  mergeSubtreeFingerprints([monoid]);
  return data;
}
