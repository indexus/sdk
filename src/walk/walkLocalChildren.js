import { checkRead } from "../utilities/sharedRead.js";
import { checkLocation, checkName, isDirectChild, LOCATION_ALPHABET } from "../tree/alphabet.js";

function appendPair(pairs, known, peer, location) {
  if (typeof peer !== "string" || !peer) throw new TypeError("Expected an explicit peer ID");
  checkLocation(location);
  const key = JSON.stringify([peer, location]);
  if (!known.has(key)) {
    known.add(key);
    pairs.push({ peer, location });
  }
}

// One best-effort breadth-first pass. The caller owns the peer IDs, routing
// decisions and I/O. The returned state can be serialized after any batch.
export async function walkLocalChildren({ collection, pending, visited = [] }, {
  maxRequests, concurrency = 1, signal, observe, peersForChild = peer => [peer],
}) {
  checkName(collection);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0)
    throw new RangeError("Expected a nonnegative request budget");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError("Expected a positive integer concurrency");
  if (!Array.isArray(pending) || !Array.isArray(visited))
    throw new TypeError("Expected pending and visited peer/location pairs");
  if (typeof observe !== "function" || typeof peersForChild !== "function")
    throw new TypeError("Expected child observation and peer selection functions");

  const known = new Set();
  const done = [], queue = [], observations = [];
  for (const { peer, location } of visited) appendPair(done, known, peer, location);
  for (const { peer, location } of pending) appendPair(queue, known, peer, location);
  let head = 0, attempts = 0, error = null;
  function commit(response) {
    const { peer, location } = queue[head];
    if (response?.complete !== false || !Array.isArray(response.children) ||
        response.children.length > LOCATION_ALPHABET.length)
      throw new Error("Expected a partial observation of direct children");
    const children = [...response.children];
    if (new Set(children).size !== children.length) throw new Error("Duplicate child address");
    const additions = [];
    for (const child of children) {
      checkLocation(child);
      if (!isDirectChild(location, child)) throw new Error("Expected a direct child address");
      const peers = peersForChild(peer, location, child);
      if (!Array.isArray(peers)) throw new TypeError("Expected an array of peer IDs");
      for (const id of peers) {
        if (typeof id !== "string" || !id) throw new TypeError("Expected a peer ID");
        additions.push({ peer: id, location: child });
      }
    }
    // All routing decisions must succeed before this pair is consumed.
    for (const item of additions) appendPair(queue, known, item.peer, item.location);
    observations.push({peer, location, children, complete:false});
    done.push(queue[head++]);
  }

  try {
    checkRead(signal);
    while (head < queue.length && attempts < maxRequests) {
      // Snapshot this frontier before routing adds children. Each wave drains
      // before another starts; only an uninterrupted BFS prefix is committed.
      const size = Math.min(concurrency, queue.length - head, maxRequests - attempts);
      const requests = [];
      for (let i = 0; i < size; i++) {
        try {
          checkRead(signal);
          const { peer, location } = queue[head + i];
          attempts++;
          requests.push(signal === undefined ? observe(peer, collection, location) :
            observe(peer, collection, location, { signal }));
        } catch (cause) {
          requests.push(Promise.reject(cause));
          break;
        }
      }
      for (const result of await Promise.allSettled(requests)) {
        if (result.status === "rejected") throw result.reason;
        checkRead(signal);
        commit(result.value);
      }
    }
  } catch (cause) {
    error = cause ?? new Error("Child observation failed", { cause });
  }
  return {state:{collection, pending:queue.slice(head), visited:done},
    observations, attempts, error, complete:false};
}
