// The heat worker as a dedicated worker (`js-indexus-sdk/map/heat-worker`):
// the core is walk/heat/worker.js; this module adds the polygon covering
// (map/wasm, loaded on the first LOAD_POLYGON) and answers the main thread.
// Imported elsewhere (tests), it only exports createHeatWorker.
import { createHeatWorker as createCore } from "../../walk/heat/worker.js";

const polygon = async () => (await import("./heat/polygonWasm.js")).createPolygonWasm();

/** @param {object} env as walk/heat/worker.js; `polygon` defaults to the WASM covering */
export function createHeatWorker(env) {
  return createCore({ ...env, polygon: env.polygon ?? polygon });
}

const dedicated = typeof self !== "undefined" && typeof self.postMessage === "function";
if (dedicated && typeof window === "undefined") {
  const post = (message, transfer) => self.postMessage(message, transfer ?? []);
  const worker = createHeatWorker({ post });
  self.onmessage = (event) => worker.handle(event.data);
}
