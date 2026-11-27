// Heat pipeline, main-thread side (docs/heat-pipeline.md): the store of
// every block (CPU copy, one budget), the plan on the GPU (gpu/plans.js:
// arena, pack, pair, combine) and the controller AverageGridLayerWebGPU reads
// every frame. The worker (map/workers/heat.worker.js) reads and walks; this
// side keeps the bytes, hands each PLAN to the GPU and times the fades.
//
// Collection rules come from the app: `heat` (gpu/pack.js normalizeHeat) and
// `summarize(totalCount, metricSums)`, whose result is `stats.summary`. With
// `mix`, other collections' fields join this pipeline's instances
// (docs/compose.md, map/heat/compose.js).
import { createBlockStore, adoptBlocks } from "../../store/index.js";
import { getGPUContext } from "../../gpu/device.js";
import { compileExpression } from "../../gpu/combine.js";
import { createPlanPacker } from "../../gpu/plans.js";
import { buildCollectionAndSpace } from "../../runtime/index.js";
import { OpacityTransition } from "../lib/opacityTransition.js";
import {
  COLLECTION_DEFAULTS,
  CELL_POSITION_MODE_METRICS,
  METRIC_SCALE,
  LAT_OFFSET,
  LNG_OFFSET,
  normalizeCellPositionConfig,
} from "../lib/heatmapConfig.js";

/** Snapshot cross-fade. */
const TRANSITION_DURATION_MS = 400;
const POINT_COLOR_THRESHOLD = 200;
const NOOP = () => {};

const smoothstep = (t) => t * t * (3 - 2 * t);

function notify(subscribers, value) {
  for (const subscriber of subscribers) {
    try {
      subscriber(value);
    } catch {
      /* a subscriber's error is its own */
    }
  }
}

/** Pack position of a cell from the app's cell-position setting. */
function positionFromCellPosition(cellPosition) {
  const config = normalizeCellPositionConfig(cellPosition);
  return {
    mode: config.mode === CELL_POSITION_MODE_METRICS ? "metrics" : "bounds",
    latIndex: config.metricLatIndex,
    lngIndex: config.metricLngIndex,
    metricScale: METRIC_SCALE,
    latOffset: LAT_OFFSET,
    lngOffset: LNG_OFFSET,
  };
}

function emptyStats(summary) {
  return {
    loading: false,
    visibleItemCount: 0,
    threshold: COLLECTION_DEFAULTS.pointOverlayMaxPoints,
    renderedZoneCount: 0,
    renderedPointCount: 0,
    mode: "heatmap",
    metricCount: 0,
    metricTotalCount: 0,
    metricSums: [],
    summary,
  };
}

/**
 * @param {object} options
 * @param {Worker|MessagePort} options.worker a heat.worker.js (or what speaks its messages)
 * @param {{name: string, dimensions: object[]}} options.collection definition, as INIT's
 * @param {GPUDevice} [options.device] the renderer's; default: the shared one (gpu/device.js)
 * @param {Array<{num, den, minDen?, transform?, shift?}>} options.heat heat rules (decision 7)
 * @param {Array} [options.previousHeat] rules of a previous snapshot of the same cells
 *   (another column, e.g. the hour before): the instances then hold both, and the
 *   renderer blends them by `controller.setBlend(t)` (see setHeat)
 * @param {(totalCount: number, metricSums: number[]) => any} [options.summarize] → stats.summary
 * @param {object} [options.position] pack position; default from `cellPosition`
 * @param {object} [options.cellPosition] `{mode, metricLatIndex, metricLngIndex}`
 *   (map/lib/heatmapConfig.js normalizeCellPositionConfig); default: the cell's centre
 * @param {number} [options.normalizer] the value at the top of the palette (default 1)
 * @param {number} [options.budgetBytes] store budget (CPU copy of the blocks)
 * @param {() => void} [options.onUnsupported] no WebGPU device could be had
 * @param {boolean} [options.fades] cross-fade a new plan from the one on screen (400 ms);
 *   false: a new plan replaces it at once, and the renderer's levels (three tiers around
 *   the camera, weighted on the GPU) keep the image continuous; a pair of snapshots
 *   (`previousHeat`) is then always drawn, so a blend between hours never stops
 * @param {boolean} [options.field] also publish the plan on screen as a field
 *   (`pipeline.field`), for another pipeline's `mix`
 * @param {object} [options.mix] combine other fields into the instances:
 *   `{name, others: [{name, source, missing}], expression}`, where a source is
 *   another pipeline's `field` (gpu/combine.js); map/heat/compose.js builds it
 */
export function createHeatmapPipeline({
  worker,
  collection,
  device = null,
  gpu = getGPUContext,
  heat,
  previousHeat = null,
  summarize = null,
  position = null,
  cellPosition = null,
  budgetBytes = 256 << 20,
  field: publish = false,
  fades = true,
  mix = null,
  normalizer = 1,
  effect = null,
  resolution = COLLECTION_DEFAULTS.algorithmResolution,
  debugHeatmap = false,
  onUnsupported = NOOP,
  onPeers = NOOP,
  now = () => performance.now(),
  requestFrame = (callback) =>
    (globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 16)))(callback),
}) {
  const { space } = buildCollectionAndSpace(collection);
  const store = createBlockStore({ budgetBytes });
  /** setColumns: its number, and the rules that wait for its first plan. */
  let columnsVersion = 0;
  let pendingRules = null;
  /** Factor from the previous snapshot (0) to the current one (1), outside fades. */
  let pairBlend = 1;
  const names = mix ? [mix.name, ...mix.others.map((other) => other.name)] : [];
  const gpuPlan = createPlanPacker({
    space,
    store,
    budgetBytes,
    keyed: publish || mix !== null,
    mix,
    gpu,
    onLost: () => deviceLost(),
    onPairReady: () => redraw(),
  });
  gpuPlan.heat = heat;
  gpuPlan.previousHeat = previousHeat;
  gpuPlan.position = position ?? positionFromCellPosition(cellPosition);
  gpuPlan.program = mix && compileExpression(mix.expression, names);
  let destroyed = false;

  const fade = { active: false, startedAt: 0, snapshotVersion: -1 };
  let pointFade = new OpacityTransition(TRANSITION_DURATION_MS);
  const heatmapFade = new OpacityTransition(TRANSITION_DURATION_MS);
  heatmapFade.from = heatmapFade.to = 1;
  let frame = null;
  let repaint = NOOP;

  let zoom = null;
  let normalizerValue = normalizer;
  let effectValue = effect;
  let resolutionValue = resolution;
  const stats = emptyStats(summarize ? summarize(0, []) : null);
  let points = { enabled: false, points: [], keys: [], stats };
  const pointSubscribers = new Set();
  const networkSubscribers = new Set();
  let networkState = { peers: [], activity: null, metrics: null };
  const searches = new Map();
  /** STATS and SUMS requests (one numbering) → their resolve. */
  const replies = new Map();
  let statsId = 0;
  let readVisible = true;

  const post = (type, payload) =>
    worker.postMessage(payload === undefined ? { type } : { type, payload });
  /** A STATS or SUMS request → Promise of its {totalCount, metricSums}. */
  const ask = (type, payload) =>
    new Promise((resolve) => {
      const requestId = ++statsId;
      replies.set(requestId, resolve);
      post(type, { requestId, ...payload });
    });

  // ---------------------------------------------------------------------------
  // GPU
  // ---------------------------------------------------------------------------

  /** The device is gone: nothing is drawn until a new one is attached. */
  function deviceLost() {
    gpuPlan.lose();
    endFade();
    repaint();
  }

  /** A field of the mix changed, or the expression: the same cells, new values. */
  function recombine() {
    if (gpuPlan.recombine()) repaint();
  }

  /** Packs the plan on screen again, alone (new rules, position, device, end of a fade). */
  function redraw() {
    if (gpuPlan.redraw()) repaint();
  }

  function applyPlan(payload) {
    const { plan } = payload;
    const target = {
      plan,
      snapshotVersion: payload.snapshotVersion,
      centerDepth: payload.centerDepth,
      previousCenterDepth: payload.previousCenterDepth,
    };
    // A block the budget evicted while this plan was on its way: the worker
    // has the eviction and sends a plan without it.
    const stale = Array.from(plan.pinned).some((handle) => !store.has(handle));
    const current = gpuPlan.current;
    const blend =
      fades &&
      !stale &&
      payload.dataDriven &&
      gpuPlan.ready &&
      current?.plan.capacity > 0 &&
      current.snapshotVersion === payload.previousSnapshotVersion;
    // The worker holds its plans until this fade ends: answer at once when it will not happen.
    if (payload.dataDriven && !blend) {
      post("TRANSITION_COMPLETE", { snapshotVersion: payload.snapshotVersion });
    }
    if (stale) return;
    // Rules waiting for their columns (setColumns): this plan is the first of the new blocks.
    if (pendingRules && payload.columnsVersion === pendingRules.version) {
      gpuPlan.heat = pendingRules.heat;
      gpuPlan.previousHeat = pendingRules.previous;
      pendingRules = null;
    }
    store.pin(plan.pinned);
    const evicted = store.evict();
    if (evicted.length > 0) {
      gpuPlan.drop(evicted);
      post("STORE_EVICTED", { handles: evicted });
    }
    if (!gpuPlan.ready) {
      gpuPlan.wait(target);
      return;
    }
    const { previousEntries, motion } = payload;
    gpuPlan.draw(target, blend ? { previousEntries, motion } : null);
    if (blend) {
      fade.active = true;
      fade.startedAt = now();
      fade.snapshotVersion = payload.snapshotVersion;
      scheduleRepaint();
    } else {
      endFade();
    }
  }

  function endFade() {
    fade.active = false;
    fade.snapshotVersion = -1;
  }

  function getTransitionFactor() {
    if (!fade.active) return gpuPlan.pairShown ? pairBlend : 1;
    const linear = Math.min(1, (now() - fade.startedAt) / TRANSITION_DURATION_MS);
    if (linear >= 1) {
      // Release the previous target only once its endpoint was painted.
      post("TRANSITION_COMPLETE", { snapshotVersion: fade.snapshotVersion });
      endFade();
      redraw();
    }
    return smoothstep(linear);
  }

  // ---------------------------------------------------------------------------
  // Repaint, points and stats
  // ---------------------------------------------------------------------------

  function pointPresentation(time = now()) {
    const opacity = pointFade.value(time);
    const enabled = (points.enabled || opacity > 0) && points.points?.length > 0;
    return { ...points, enabled, opacity };
  }

  const notifyPoints = () => notify(pointSubscribers, pointPresentation());

  function scheduleRepaint() {
    if (frame !== null || destroyed) return;
    const tick = () => {
      frame = null;
      if (destroyed) return;
      const time = now();
      const fadingPoints = pointFade.active(time);
      if (fadingPoints || !fade.active) notifyPoints();
      repaint();
      const fading = pointFade.active(now()) || heatmapFade.active(now());
      // Only a zoom transition animates. Two hours shown together (pairShown) have a
      // blend below 1 for as long as they are shown, and setBlend repaints them itself.
      // Counting that blend kept the loop, and the map's repaints, running at frame
      // rate while nothing moved.
      const transitioning = fade.active && getTransitionFactor() < 1;
      if (transitioning || fading) frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
  }

  function adoptViewport(payload, pointsBuffer) {
    if (Number.isFinite(payload.algorithmResolution) && payload.algorithmResolution > 0) {
      resolutionValue = Math.floor(payload.algorithmResolution);
    }
    // Missing detail is a loading state: verified points stay until the new inventory is complete.
    if (payload.pointsPending && points.enabled) {
      if (!points.stats.loading) points = { ...points, stats: { ...points.stats, loading: true } };
      notifyPoints();
      return;
    }
    const enabled = !!(payload.showPoints && payload.pointCount > 0 && pointsBuffer);
    const count = payload.viewportMetricCount > 0 ? payload.viewportMetricCount : 0;
    const sums = Array.isArray(payload.viewportMetricSums) ? payload.viewportMetricSums : [];
    const stats = {
      loading: payload.pointsPending === true,
      visibleItemCount: payload.visibleItemCount ?? 0,
      threshold: payload.pointThreshold ?? COLLECTION_DEFAULTS.pointOverlayMaxPoints,
      renderedZoneCount: payload.instanceCount ?? 0,
      renderedPointCount: payload.pointCount ?? 0,
      mode: enabled ? "points" : "heatmap",
      normalizer: normalizerValue,
      colorThreshold: POINT_COLOR_THRESHOLD,
      metricCount: payload.metricCount ?? 0,
      zoneSubdivisionThreshold: payload.zoneSubdivisionThreshold,
      requireCompleteChildren: payload.requireCompleteChildren !== false,
      childVirtualizationEnabled: payload.childVirtualizationEnabled === true,
      algorithmResolution: resolutionValue,
      polygonFilterEnabled: payload.polygonFilterEnabled !== false,
      valueMetricIndex: payload.valueMetricIndex,
      metricTotalCount: count,
      metricSums: sums,
      summary: summarize ? summarize(count, sums) : null,
    };
    points = {
      enabled,
      points: enabled ? new Float32Array(pointsBuffer) : points.points,
      keys: enabled ? payload.pointKeys || [] : points.keys,
      stats,
    };
    if (!enabled) {
      pointFade.set(0, now());
      heatmapFade.set(1, now());
    }
    if (pointFade.active(now()) || heatmapFade.active(now())) scheduleRepaint();
    notifyPoints();
  }

  function publishNetwork(patch) {
    networkState = { ...networkState, ...patch };
    notify(networkSubscribers, networkState);
  }

  // ---------------------------------------------------------------------------
  // Worker messages
  // ---------------------------------------------------------------------------

  function onMessage({ data }) {
    if (destroyed) return;
    const { type, payload } = data;
    switch (type) {
      case "BLOCKS":
        adoptBlocks(store, data);
        gpuPlan.put(data.sections.map((section) => section.handle));
        return;
      case "DROP": {
        const released = data.handles.filter((handle) => store.has(handle));
        store.drop(released);
        gpuPlan.drop(released);
        post("STORE_EVICTED", { handles: released });
        return;
      }
      case "PLAN":
        applyPlan(payload);
        adoptViewport(payload, data.pointsBuffer);
        repaint();
        return;
      case "VIEWPORT":
        adoptViewport(payload, data.pointsBuffer);
        repaint();
        return;
      case "SUMS_RESULT":
      case "STATS_RESULT": {
        const pending = replies.get(payload?.requestId);
        if (!pending) return;
        replies.delete(payload.requestId);
        pending({ totalCount: payload.totalCount, metricSums: payload.metricSums });
        return;
      }
      case "SEARCH_RESULT": {
        const pending = searches.get(payload?.requestId);
        if (!pending) return;
        searches.delete(payload.requestId);
        const items = payload.items ?? [];
        if (payload.error && items.length === 0) return pending.reject(new Error(payload.error));
        pending.resolve({ items, peers: payload.peers ?? 0, error: payload.error || null });
        return;
      }
      case "NETWORK_PEERS": {
        const peers = Array.isArray(payload?.peers) ? payload.peers : [];
        onPeers(peers);
        const routingKey = payload?.routingKey ?? networkState.routingKey ?? null;
        publishNetwork({ peers, routingKey });
        return;
      }
      case "NETWORK_ACTIVITY": {
        const events = payload?.events ?? [];
        if (events.length === 0) return;
        const activity = payload.latest ?? events.at(-1);
        publishNetwork({ activity, activityEvents: events, activityAt: now() });
        return;
      }
      case "NETWORK_METRICS":
        publishNetwork({ metrics: payload || null });
        return;
      case "DEBUG_LOG":
        console.info(
          `[indexus:${payload?.channel || "?"}] ${payload?.event || ""}`,
          payload?.fields ?? "",
        );
        return;
      case "ERROR":
        console.error("Heat worker error:", payload);
        return;
      case "INIT_COMPLETE":
        return;
      default:
        console.warn("Unknown message type from the heat worker:", type);
    }
  }

  if (typeof worker.addEventListener === "function") worker.addEventListener("message", onMessage);
  else worker.onmessage = onMessage;

  const syncVisibility = () => {
    const hidden = globalThis.document?.hidden === true;
    post("SET_VISIBILITY", { visible: readVisible && !hidden });
    if (readVisible && !hidden) {
      getTransitionFactor();
      scheduleRepaint();
    }
  };
  globalThis.document?.addEventListener?.("visibilitychange", syncVisibility);
  if (globalThis.document?.hidden) syncVisibility();

  const unsubscribes = (mix?.others ?? []).map(({ source }) => source.subscribe(recombine));

  if (device) {
    gpuPlan.attach(device);
  } else {
    Promise.resolve(gpu()).then(
      (context) => (context ? gpuPlan.attach(context.device) : onUnsupported()),
      () => onUnsupported(),
    );
  }

  // ---------------------------------------------------------------------------
  // Controller: what the layer and the apps read
  // ---------------------------------------------------------------------------

  // Diagnostic metadata only: the same held blocks and handles used by the plan.
  function* loadedZones(drawnOnly) {
    const handles=drawnOnly?new Set(gpuPlan.current?.plan.pinned??[]):null;
    const seen=new Set();
    for(const {handle,zone,block} of store.entries()){
      if((handles&&!handles.has(handle))||seen.has(zone)||!block.count.some(count=>count>0))continue;
      seen.add(zone);yield zone;
    }
  }
  const setOption = (type, value) => post(type, { value });
  const controller = {
    getPackedData: () => gpuPlan.packed,
    /** Nonempty held read zones, without reads, buffer copies or LRU updates. */
    getLoadedZones: () => loadedZones(false),
    /** Actual read zones referenced by the current drawing plan. */
    getDrawnZones: () => loadedZones(true),
    getZoom: () => zoom,
    setReadVisibility(visible) {
      if ((visible !== false) === readVisible) return;
      readVisible = visible !== false;
      syncVisibility();
    },
    getResolutionConstant: () => resolutionValue,
    getTransitionFactor,
    getNormalizer: () => normalizerValue,
    getEffect: () => effectValue,
    setEffect(next) {
      if (!next) return;
      effectValue = next;
      repaint();
    },
    getHeatmapOpacity: () => (gpuPlan.packed.count > 0 ? heatmapFade.value(now()) : 0),
    getPointOverlay: () => pointPresentation(),
    subscribePointOverlay(handler) {
      if (typeof handler !== "function") return NOOP;
      pointSubscribers.add(handler);
      handler(pointPresentation());
      return () => pointSubscribers.delete(handler);
    },
    setPointOverlayReady() {
      if (!points.enabled || pointFade.to === 1) return;
      pointFade.set(1, now());
      heatmapFade.set(0, now());
      scheduleRepaint();
    },
    subscribeNetwork(handler) {
      if (typeof handler !== "function") return NOOP;
      networkSubscribers.add(handler);
      handler(networkState);
      return () => networkSubscribers.delete(handler);
    },
    forgetPeer(hash) {
      if (!hash) return false;
      post("FORGET_PEER", { hash });
      return true;
    },
    setCellPosition(next) {
      gpuPlan.position = positionFromCellPosition(next);
      redraw();
    },
    /**
     * New rules, and optionally the rules of a previous snapshot of the same
     * cells (`previousHeat`): outside a fade the renderer then shows
     * mix(previous, current, setBlend's factor). The combine of a mix writes
     * the current snapshot only.
     */
    setHeat(next, previous = null) {
      gpuPlan.heat = next;
      gpuPlan.previousHeat = previous;
      redraw();
    },
    /**
     * The metric positions the worker reads (`/sets?columns=`); null for all.
     * The heat rules then name positions in this list. The zones held are
     * read again with the new columns before the next plan. With `rules`
     * ({heat, previousHeat}), those replace the rules with the first plan of
     * the new blocks, never before: until then the instances keep the rules
     * of the blocks they were packed from, so no pack mixes two column sets.
     */
    setColumns(columns, rules = null) {
      const version = ++columnsVersion;
      pendingRules = rules
        ? { version, heat: rules.heat, previous: rules.previousHeat ?? null }
        : null;
      post("SET_COLUMNS", { columns: columns ?? null, version });
    },
    /** Whether rules given to setColumns still wait for the first plan of their columns. */
    rulesPending: () => pendingRules !== null,
    /** Factor from the previous snapshot (0) to the current one (1); a repaint, no pack. */
    setBlend(t) {
      const next = Math.max(0, Math.min(1, Number(t) || 0));
      if (next === pairBlend) return;
      pairBlend = next;
      if (gpuPlan.pairShown) repaint();
    },
    setExpression(next) {
      if (!mix) throw new Error("heat: this pipeline has no mix");
      gpuPlan.program = compileExpression(next, names);
      recombine();
    },
    // The worker bounds these (walk/heat/options.js); a value it cannot read changes nothing.
    setPointOverlayMaxPoints: (value) => setOption("SET_POINT_OVERLAY_MAX_POINTS", value),
    setCubeSubdivisionLimit: (value) => setOption("SET_CUBE_SUBDIVISION_LIMIT", value),
    setRequireCompleteChildren: (value) => setOption("SET_REQUIRE_COMPLETE_CHILDREN", value),
    setPolygonFilterEnabled: (value) => setOption("SET_POLYGON_FILTER_ENABLED", value),
    setValueMetricIndex(value) {
      if (Number(value) >= 0) setOption("SET_VALUE_METRIC_INDEX", Math.floor(value));
    },
    setChildVirtualizationEnabled: (value) => setOption("SET_CHILD_VIRTUALIZATION", value),
    setAlgorithmResolution(value) {
      if (!Number.isFinite(Number(value))) return;
      resolutionValue = Math.max(1, Math.floor(value));
      setOption("SET_ALGO_RESOLUTION", resolutionValue);
      repaint();
    },
    setNormalizer(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return;
      normalizerValue = n;
      if (points.enabled) {
        points = { ...points, stats: { ...points.stats, normalizer: n } };
        notifyPoints();
      }
      repaint();
    },
    requestReconcile: () => post("RECONCILE"),
    clearSetsCache: (opts = {}) =>
      post("CLEAR_SETS_CACHE", { owners: opts.owners !== false, metrics: opts.metrics === true }),
    onDeviceLost: () => deviceLost(),
    onDeviceRestored: ({ device: next }) => gpuPlan.attach(next),
    debugHeatmap,
  };

  return {
    controller,
    /** Sends INIT: `payload` is collection, network, cubeOpt, … */
    init(payload) {
      post("INIT", { ...payload, collection });
    },
    /** One camera: zoom and serialized bounds ([{dimension, segment}]). */
    move({ zoom: nextZoom, bounds, strictBounds }) {
      zoom = nextZoom;
      post("MOVE", { zoom: nextZoom, bounds, strictBounds });
    },
    loadPolygon: (geojson) => geojson && post("LOAD_POLYGON", geojson),
    setSurface: (surface) =>
      post("SET_SURFACE", { surface: surface === "nearby" ? "nearby" : "aggregate" }),
    setAutoDelta: (enabled) => post("SET_AUTO_DELTA", { enabled: enabled === true }),
    search(opts = {}) {
      const requestId =
        globalThis.crypto?.randomUUID?.() ??
        `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        searches.set(requestId, { resolve, reject });
        const { lat, lng, step } = opts;
        post("SEARCH", { requestId, lat, lng, step, fresh: opts.fresh !== false });
      });
    },
    /**
     * Count and metric sums of a region from the zones the worker holds, as
     * the viewport stats (no read): `bounds` serialized as for move, cells of
     * the walk's depth at `zoom`. → Promise<{totalCount, metricSums}>
     */
    stats: ({ zoom: at, bounds }) => ask("STATS", { zoom: at, bounds }),
    /**
     * Count and sums of `columns` over a region from a coarse read of its own
     * (at most `maxZones` zones), the drawn blocks untouched: a value for a
     * whole view and every column, e.g. the hours of a weather variable.
     * → Promise<{totalCount, metricSums}>
     */
    sums: ({ bounds, columns = null, maxZones = 16 }) =>
      ask("SUMS", { bounds, columns, maxZones }),
    registerRepaint(next) {
      repaint = typeof next === "function" ? next : NOOP;
    },
    deviceLost,
    /**
     * What this collection says of the cells on screen, for another pipeline's
     * mix: the field buffer (null while there is none) and its device.
     */
    field: gpuPlan.field,
    /** Rebuilds the arena from the store on `device` and packs the plan on screen again. */
    restore: (next) => gpuPlan.attach(next),
    destroy() {
      destroyed = true;
      globalThis.document?.removeEventListener?.("visibilitychange", syncVisibility);
      worker.removeEventListener?.("message", onMessage);
      worker.terminate?.();
      for (const unsubscribe of unsubscribes) unsubscribe();
      gpuPlan.destroy();
      store.clear();
      repaint = NOOP;
    },
    /** For tests and diagnostics. */
    get state() {
      const { arena, gpu, current, packed, steady } = gpuPlan;
      const plan = current?.plan ?? null;
      return { store, arena, gpu, plan, packed, fade: { ...fade }, steady };
    },
  };
}
