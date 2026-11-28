import { asyncPool } from "../utilities/network.js";
import { checkRead } from "../utilities/sharedRead.js";
import { ROOT } from "../tree/alphabet.js";
import { walkLocalChildren } from "../walk/walkLocalChildren.js";
import { MAX_CONTENT_RECORDS } from "./wire.js";

// The caller supplies the peer set. A completed pass covers the addresses
// those peers revealed during the pass, including rows on interior nodes.
export async function readObservedCollection(protocol, peers, collection, {
  maxRequests, concurrency = 4, limitPerLocation = MAX_CONTENT_RECORDS, ...options
}) {
  if (!Array.isArray(peers) || peers.length === 0)
    throw new TypeError("Expected at least one peer");
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 ||
      !Number.isSafeInteger(limitPerLocation) || limitPerLocation < 1 || limitPerLocation > MAX_CONTENT_RECORDS)
    throw new RangeError("Invalid collection read budget");

  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError("Expected a positive integer concurrency");

  let requests = 0;
  function charge() {
    checkRead(options.signal);
    if (requests >= maxRequests) throw new RangeError("Collection request budget exhausted");
    requests++;
  }
  const roots = Array.from(peers, (_, i) => ({ peer: String(i), location: ROOT }));
  const pass = await walkLocalChildren({ collection, pending: roots }, {
    maxRequests, concurrency, signal: options.signal,
    observe: (index, name, location) => {
      charge();
      return this.getLocalChildren(protocol, peers[index], name, location, { ...options, includeUncertain: true });
    },
  });
  if (pass.error) throw pass.error;
  if (pass.state.pending.length) throw new RangeError("Collection request budget exhausted");

  const locations = new Map();
  for (const { peer, location } of pass.observations) {
    if (!locations.has(location)) locations.set(location, Number(peer));
  }
  // asyncPool preserves input order and drains started reads on failure.
  // A worker draining a 409 must also stop before starting another RPC.
  let failed = false;
  const chunks = await asyncPool(concurrency, [...locations], async ([location, first]) => {
    for (let offset = 0; offset < peers.length; offset++) {
      const peer = peers[(first + offset) % peers.length];
      if (failed) return;
      charge();
      try {
        return await this.getDirectRecords(protocol, peer, collection, location, limitPerLocation, options);
      } catch (error) {
        // An ownership refusal identifies a routing miss. A budget error or
        // an unavailable owner must propagate to the caller.
        if (error?.response?.status !== 409 || offset + 1 === peers.length) throw error;
      }
    }
  }, { onError: () => { failed = true; } });
  checkRead(options.signal);
  return { records: chunks.flat(), requests, complete: false };
}
