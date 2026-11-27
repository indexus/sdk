export async function asyncPool(poolLimit, array, iteratorFn, { signal, onError } = {}) {
  if (!Array.isArray(array) || array.length === 0) return [];
  const limit = Math.max(1, Math.floor(Number(poolLimit) || 1));
  const results = new Array(array.length);
  let next = 0;
  let failed = false;
  let failure;
  async function worker() {
    while (!failed && next < array.length) {
      const index = next++;
      try {
        signal?.throwIfAborted();
        results[index] = await iteratorFn(array[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          // Release dependency waiters immediately, then drain active callbacks.
          try {
            onError?.(error);
          } catch {
            /* Keep the original failure. */
          }
        }
      }
    }
  }
  // Drain started callbacks before releasing shared traversal buffers. A
  // rejected Promise.race used to leave callbacks mutating recycled arrays.
  await Promise.all(Array.from({ length: Math.min(limit, array.length) }, worker));
  if (failed) throw failure;
  return results;
}

export function getHostFromIP(ip) {
  let host;
  if (ip.includes(":")) {
    host = `[${ip}]`;
  } else {
    host = ip;
  }
  return host;
}
