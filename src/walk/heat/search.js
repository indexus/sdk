// Nearby search (Local) of the heat worker, on the network the heatmap reads
// through (SEARCH → SEARCH_RESULT).
import { Local } from "../../local/index.js";

/** SEARCH runs on the nearby surface only, never beside a drill or another search. */
export function shouldAcceptSearch({ surface, drillInFlight, searchInFlight }) {
  return surface === "nearby" && !drillInFlight && !searchInFlight;
}

function serializeHit(item) {
  const metrics = item.metrics?.() || item._metrics || [];
  const distances = item.distances?.() || item._distances || [];
  return {
    id: item.id?.() || item._id || null,
    hash: item.hash?.() || item._hash || null,
    metrics: Array.from(metrics),
    distances: Array.from(distances),
  };
}

/** @param {{space, network, collection: string, post: Function}} context */
export function createNearbySearch({ space, network, collection, post }) {
  let explorer = null;
  let controller = null;
  let inFlight = false;

  function explore({ lat, lng, step }) {
    const gps = space.dimension(0);
    const batch = [];
    const local = new Local(
      { [collection]: space },
      {
        cap: 1,
        step,
        origins: { gps: gps.newPoint([lat, lng]) },
        filters: { gps: gps.newFilter([0, 0], [0, 360]) },
      },
      { send: (results) => batch.push(...results) },
      { send: () => {} },
      network,
    );
    local.batch = batch;
    return local;
  }

  return {
    /** `drilling`: the heatmap's reads own /sets, the search waits. */
    async search(payload, { surface, drilling }) {
      const requestId = payload?.requestId;
      const respond = (body) => post({ type: "SEARCH_RESULT", payload: { requestId, ...body } });
      if (!shouldAcceptSearch({ surface, drillInFlight: drilling, searchInFlight: inFlight })) {
        const busy = drilling ? "drill-in-flight" : "search-in-flight";
        const error = surface !== "nearby" ? "surface-aggregate" : busy;
        return respond({ error, items: [], peers: 0 });
      }
      const lat = Number(payload?.lat);
      const lng = Number(payload?.lng);
      const step = Math.max(1, Math.floor(Number(payload?.step) || 1));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return respond({ error: "invalid-origin", items: [], peers: 0 });
      }
      inFlight = true;
      const scope = new AbortController();
      controller = scope;
      try {
        if (payload?.fresh !== false || !explorer) explorer = explore({ lat, lng, step });
        explorer.options.step = step;
        explorer.options.signal = scope.signal;
        explorer.batch.length = 0;
        await explorer.search();
        const peers = network.listPeers().length;
        respond({ items: explorer.batch.map(serializeHit), peers, error: null });
      } catch (error) {
        const canceled = scope.signal.aborted;
        respond({ error: String(error?.message || error), canceled, items: [], peers: 0 });
      } finally {
        if (scope.signal.aborted) explorer = null;
        if (controller === scope) controller = null;
        inFlight = false;
      }
    },

    abort() {
      controller?.abort();
    },

    /** The next search starts from a new explorer (surface change, cleared cache). */
    reset() {
      controller?.abort();
      explorer = null;
    },
  };
}
