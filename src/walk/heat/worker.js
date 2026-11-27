// Heat worker core (docs/heat-pipeline.md). It reads zones as IXB2 blocks,
// keeps one summary per zone (walk/zones.js), walks the viewport and sends the
// main thread the blocks (BLOCKS, their buffers transferred) and the plan that
// draws them (PLAN). The bytes, the GPU pack and the fade timing live on the
// main thread (map/heat/pipeline.js); the worker keeps summaries only. The
// dedicated worker that runs it is map/workers/heat.worker.js.
//
// Messages: the SET_* options (options.js), MOVE, SEARCH, STATS, RECONCILE and
// the others of docs/heat-pipeline.md, plus BLOCKS, PLAN, DROP and
// STORE_EVICTED (contract, section a).
//
// Handles: the worker allocates them densely (the GPU block table is indexed
// by handle) and reuses one only after the main thread said it no longer
// holds it (STORE_EVICTED, which also answers DROP), so a handle never names
// two blocks at once on the two sides.
import { API } from "../../api/index.js";
import { Network } from "../../network/index.js";
import { metricsOption, isCanceled } from "../../network/helpers.js";
import { ROOT, parent } from "../../tree/index.js";
import { buildCollectionAndSpace } from "../../runtime/index.js";
import { sectionsOf } from "../../store/index.js";
import {
  createZoneIndex,
  walkViewport,
  planMotion,
  regionStats,
  coverZones,
  blockSums,
  ENTRY_WORDS,
} from "../index.js";
import { CHARS, childLocation, zoneDepth } from "../zones.js";
import { setDebug, setDebugSink, debugLog } from "../../utilities/debug.js";
import { viewWindow, nextDisplayZoom } from "./view.js";
import { OPTION_MESSAGES, WALK_DEFAULTS, readOptions } from "./options.js";
import { createPointOverlay } from "./points.js";
import { createNearbySearch } from "./search.js";
import { watchNetwork } from "./telemetry.js";

/** A zone that could not be read is asked again after this. */
const RETRY_MS = 2000;
const REFRESH_MS = 16;
/** Camera settle before an automatic reconcile, and the quiet time between two. */
const RECONCILE_DEBOUNCE_MS = 1000;
const RECONCILE_IDLE_MS = 10000;
/** Zones one automatic reconcile may read; a RECONCILE has no limit. */
const DELTA_MAX_READS = 48;
const RECONCILE_BATCH = 16;
/** completePlans: the longest a plan waits for its detail before it is shown as it is (ms). */
const COMPLETE_PLAN_WAIT_MS = 2500;
/** Zones per read when a column swap reads the held zones again. */
const SWAP_BATCH = 32;
/** Render and fetch window around the visible view. */
const WINDOW_MARGIN = 0.25;

/** Same mass and same per-character split: a refresh that changes nothing. */
function sameSummary(a, b) {
  if (!a || !b || a.count !== b.count || a.metricCount !== b.metricCount) return false;
  for (let r = 0; r < CHARS; r++) if (a.children.count[r] !== b.children.count[r]) return false;
  return a.metricSums.every((value, k) => value === b.metricSums[k]);
}

/**
 * @param {object} env
 * @param {(message: object, transfer?: Transferable[]) => void} env.post
 * @param {object} [env.api] transport (tests pass one that names peers without a ping)
 * @param {() => number} [env.now]
 * @param {() => Promise<{loadGeojson, isCovered}>} [env.polygon]
 */
export function createHeatWorker(env) {
  const { post, api = new API(), now = () => performance.now(), polygon: loadPolygonWasm } = env;
  let network = null;
  let space = null;
  let index = null;
  /** Column kinds of the collection (walk/columns.js), null: all sums. */
  let kinds = null;
  let collection = "";
  let options = readOptions({});
  let ready = false;
  let visible = true;
  let surface = "aggregate";
  let polygon = null;
  /** {zoom, strict (serialized bounds), window} of the last MOVE. */
  let camera = null;
  let pendingMove = null;
  let lastMoveAt = -Infinity;
  let moveId = 0;
  /** Metric positions read (`/sets?columns=`), null for all; a swap re-reads the zones held. */
  let columns = null;
  /** The pipeline's number of the last SET_COLUMNS, sent back with each plan. */
  let columnsVersion = 0;
  let swapping = 0;
  let refreshPending = false;

  let nextHandle = 0;
  const freeHandles = [];
  /** handle → zone, for the handles the main thread holds. */
  const live = new Map();
  const zoneHandles = new Map();
  const fetchedAt = new Map();
  /** Zones a node answered without rows: drawn as empty, not asked again. */
  const empty = new Set();
  const retryAt = new Map();
  /** zone → the read carrying it. */
  const inflight = new Map();
  const seen = new WeakSet();

  /** The last plan sent: the main thread's current target. */
  let sent = null;
  let snapshot = 0;
  /** Snapshot whose fade the main thread has not finished: plans wait. */
  let transition = null;
  let held = false;
  let retained = false;
  /** completePlans: since when the camera's plan has been held for its detail (now()), or null. */
  let holdingSince = null;
  let viewportKey = "";

  let refreshTimer = null;
  let retryTimer = null;
  let reconcileTimer = null;
  let reconciling = false;
  let reconcileFollowUp = null;
  let telemetry = null;
  let pointOverlay = null;
  let nearby = null;

  /** Space segments of serialized bounds ([{dimension, segment}], as MOVE carries them). */
  const segments = (serialized) =>
    serialized.map(({ dimension, segment }) => space.dimension(dimension).newSegment(segment));

  // --- Blocks

  function allocate(zone) {
    const handle = freeHandles.length > 0 ? freeHandles.pop() : nextHandle++;
    live.set(handle, zone);
    return handle;
  }

  /** Forgets a zone; its handles stay allocated until the main thread lets them go. */
  function forget(zone, dropped) {
    const handles = zoneHandles.get(zone);
    if (!handles) return;
    index.drop(handles);
    for (const handle of handles) {
      live.delete(handle);
      dropped.push(handle);
    }
    zoneHandles.delete(zone);
  }

  /**
   * One raw read: ingests every zone that came back with rows, then sends
   * their blocks. With `unchanged`, a zone whose summary equals the one held
   * keeps its blocks and the new copy is not sent (a refresh that found
   * nothing new costs the main thread nothing).
   * @returns {Map<string, object|undefined>} zone → summary before the read
   */
  async function read(zones, { refresh = false, signal, unchanged = false } = {}) {
    const asked = columns;
    const metrics = metricsOption("f32", asked);
    const answer = await network.getSets(collection, zones, {
      raw: true,
      refresh,
      signal,
      metrics,
    });
    if (signal?.aborted || asked !== columns) return new Map();
    const time = now();
    const groups = new Map();
    const outgoing = [];
    for (const response of answer.responses) {
      if (seen.has(response)) continue;
      seen.add(response);
      const sections = sectionsOf(response.buffer, response.blocks, () => 0);
      sections.forEach((section, i) => {
        const group = groups.get(section.zone) ?? { sections: [], blocks: [] };
        group.sections.push(section);
        group.blocks.push(response.blocks[i]);
        groups.set(section.zone, group);
      });
      outgoing.push({ buffer: response.buffer, sections });
    }
    const before = new Map();
    const dropped = [];
    const scratch = unchanged ? createZoneIndex(space, { kinds }) : null;
    for (const [zone, group] of groups) {
      before.set(zone, index.get(zone));
      const fresh = scratch?.ingest(
        zone,
        group.blocks.map(() => 0),
        group.blocks,
      );
      if (scratch && sameSummary(index.get(zone), fresh)) {
        group.sections.length = 0;
        continue;
      }
      forget(zone, dropped);
      for (const section of group.sections) section.handle = allocate(zone);
      const handles = group.sections.map((section) => section.handle);
      index.ingest(zone, handles, group.blocks);
      zoneHandles.set(zone, handles);
      empty.delete(zone);
    }
    for (const zone of answer.empty) {
      before.set(zone, index.get(zone));
      forget(zone, dropped);
      empty.add(zone);
    }
    for (const zone of zones) {
      if (answer.unresolved.includes(zone)) {
        retryAt.set(zone, time + RETRY_MS);
      } else {
        retryAt.delete(zone);
        fetchedAt.set(zone, time);
      }
    }
    for (const { buffer, sections } of outgoing) {
      const kept = sections.filter((section) =>
        groups.get(section.zone).sections.includes(section),
      );
      if (kept.length > 0) post({ type: "BLOCKS", buffer, sections: kept }, [buffer]);
    }
    if (dropped.length > 0) post({ type: "DROP", handles: dropped });
    return before;
  }

  /** The descent's missing zones that are not on the wire, known empty or waiting to retry. */
  function request(missing) {
    const time = now();
    const waiting = (zone) => (retryAt.get(zone) ?? 0) > time;
    const skip = (zone) => inflight.has(zone) || empty.has(zone) || waiting(zone);
    const wanted = missing.filter((zone) => !skip(zone));
    scheduleRetry();
    if (wanted.length === 0) return;
    const batch = { controller: new AbortController(), zones: wanted };
    for (const zone of wanted) inflight.set(zone, batch);
    read(wanted, { signal: batch.controller.signal })
      .catch((error) => {
        if (isCanceled(error, batch.controller.signal)) return;
        for (const zone of wanted) retryAt.set(zone, now() + RETRY_MS);
      })
      .finally(() => {
        for (const zone of wanted) if (inflight.get(zone) === batch) inflight.delete(zone);
        if (inflight.size === 0) scheduleReconcile(RECONCILE_DEBOUNCE_MS);
        scheduleRefresh();
      });
  }

  /** Reads that no longer serve the view stop: none of their zones is wanted. */
  function abortStale(missing) {
    const wanted = new Set(missing);
    for (const batch of new Set(inflight.values())) {
      if (batch.zones.some((zone) => wanted.has(zone))) continue;
      batch.controller.abort();
      for (const zone of batch.zones) inflight.delete(zone);
    }
  }

  /** Every read of the walk stops. */
  function abortReads() {
    for (const batch of new Set(inflight.values())) batch.controller.abort();
    inflight.clear();
  }

  function abortAll() {
    abortReads();
    pointOverlay?.cancel();
    nearby?.abort();
  }

  /** Wakes up for the next retry still to come; a passed one is asked when the walk wants it. */
  function scheduleRetry() {
    const time = now();
    const next = Math.min(...[...retryAt.values()].filter((at) => at > time));
    if (retryTimer !== null || next === Infinity) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        refresh();
      },
      Math.max(REFRESH_MS, next - time),
    );
  }

  // --- Walk and plans

  const depthOf = (zoom) => Math.floor(zoom + options.resolution);

  function walkAt(zoom) {
    camera.window = viewWindow(camera.window, camera.strict, depthOf(zoom), WINDOW_MARGIN);
    const filter = options.polygonFilter && polygon;
    const covered = filter ? (cell) => polygon.isCovered(cell) : () => false;
    return walkViewport(index, {
      zoom,
      resolution: options.resolution,
      bounds: segments(camera.window.bounds),
      strictBounds: segments(camera.strict),
      limit: options.limit,
      children: options.requireCompleteChildren ? options.children : 1,
      isCovered: covered,
      parentFallbackDepth: WALK_DEFAULTS.parentFallbackDepth,
      virtualize: options.virtualize,
      // While detail is on its way, coarse anchors slide into the view.
      nudgeAnchors: inflight.size > 0 || transition !== null,
      statsZoom: camera.zoom,
    });
  }

  function reaches(plan, depth) {
    for (let at = 4; at < plan.entries.length; at += ENTRY_WORDS) {
      if (plan.entries[at] >= depth) return true;
    }
    return false;
  }

  /**
   * The plan for the camera, or one bracket short of it when the camera
   * jumped two (zoomCatchUp). Reads always serve the camera itself.
   */
  function walk() {
    const zoom = nextDisplayZoom(sent?.centerDepth, camera.zoom, options.resolution);
    const target = walkAt(camera.zoom);
    if (zoom === camera.zoom) return { plan: target, missing: target.missing };
    const step = walkAt(zoom);
    return { plan: reaches(step, depthOf(zoom)) ? step : target, missing: target.missing };
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, REFRESH_MS);
  }

  function refresh({ snap = false } = {}) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!ready || !visible || !camera || surface !== "aggregate") return;
    // a column swap in progress: zones hold two column sets, no plan until it ends
    if (swapping) {
      refreshPending = true;
      return;
    }
    const { plan, missing } = walk();
    abortStale(missing);
    request(missing);
    publish(plan, missing, snap);
  }

  function publish(plan, missing, snap) {
    const confirmed = inflight.size === 0 && !missing.some((zone) => retryAt.has(zone));
    const view = viewport(plan);
    if (transition !== null) {
      held = true;
      return postViewport(view);
    }
    if (sent && plan.signature === sent.signature && !retained) return postViewport(view);
    // Complete plans only (a field such as the weather): while the view's detail
    // is on the wire the plan on screen stays, as a whole, and the renderer's
    // levels follow the camera; a read that keeps failing gives up the wait.
    if (options.completePlans && !snap && sent?.capacity > 0 && !confirmed) {
      holdingSince ??= now();
      if (now() - holdingSince < COMPLETE_PLAN_WAIT_MS) {
        retained = true;
        scheduleRefresh();
        return postViewport(view);
      }
    }
    holdingSince = null;
    // A view whose detail is still unknown keeps the last geometry on screen.
    if (plan.capacity === 0 && sent?.capacity > 0 && !confirmed) {
      retained = true;
      view.payload.pointsPending = true;
      return postViewport(view);
    }
    retained = false;
    const previous = sent?.capacity > 0 ? sent : null;
    const motion = planMotion(previous, plan);
    const dataDriven = !snap && previous !== null && plan.capacity > 0;
    const previousSnapshotVersion = snapshot;
    snapshot++;
    if (dataDriven) transition = snapshot;
    // The previous plan's own entries, LEAVE flags set by planMotion: `sent`
    // becomes `plan` below and nothing else holds them, so they are
    // transferred as they are, not copied (plan.entries stays here: the next
    // planMotion reads it).
    const previousEntries = dataDriven ? previous.entries : null;
    plan.pinned = pinsOf(plan);
    const message = {
      type: "PLAN",
      payload: {
        snapshotVersion: snapshot,
        previousSnapshotVersion,
        centerDepth: plan.centerDepth,
        previousCenterDepth: previous?.centerDepth ?? plan.centerDepth,
        columnsVersion,
        dataDriven,
        emptyConfirmed: confirmed,
        plan,
        motion,
        previousEntries,
        ...view.payload,
      },
    };
    const transfer = previousEntries ? [previousEntries.buffer] : [];
    if (view.pointsBuffer) {
      message.pointsBuffer = view.pointsBuffer;
      transfer.push(view.pointsBuffer);
    }
    post(message, transfer);
    viewportKey = view.key;
    sent = plan;
    // An intermediate bracket: the camera's own plan follows the fade.
    if (plan.centerDepth !== depthOf(camera.zoom)) {
      if (transition !== null) held = true;
      else scheduleRefresh();
    }
  }

  /**
   * The walk pins the blocks it draws; the descent also reads the summaries
   * of their ancestors, so those stay too: an evicted ancestor would make the
   * whole branch missing again.
   */
  function pinsOf(plan) {
    const handles = new Set(plan.pinned);
    const zones = new Set();
    for (let zone of plan.zones) {
      while (!zones.has(zone)) {
        zones.add(zone);
        for (const handle of zoneHandles.get(zone) ?? []) handles.add(handle);
        if (zone === ROOT) break;
        zone = parent(zone) || ROOT;
      }
    }
    return Uint32Array.from(handles);
  }

  function postViewport(view) {
    if (view.key === viewportKey) return;
    viewportKey = view.key;
    const message = { type: "VIEWPORT", payload: view.payload };
    if (view.pointsBuffer) message.pointsBuffer = view.pointsBuffer;
    post(message, view.pointsBuffer ? [view.pointsBuffer] : []);
  }

  /** Stats and points of a plan: the VIEWPORT payload. */
  function viewport(plan) {
    const points = pointOverlay.overlay(plan, segments(camera.strict), camera.strict[0].segment);
    const count = points.showPoints ? points.count : plan.stats.totalCount;
    const sums = points.showPoints ? points.metricSums : Array.from(plan.stats.metricSums);
    const payload = {
      instanceCount: retained ? sent.capacity : plan.capacity,
      showPoints: points.showPoints,
      pointCount: points.count,
      pointKeys: points.keys ?? [],
      pointsPending: points.pending === true,
      pointMetrics: points.recordMetrics ?? [],
      visibleItemCount: points.visibleItemCount,
      pointThreshold: points.threshold,
      zoneSubdivisionThreshold: options.limit,
      requireCompleteChildren: options.requireCompleteChildren,
      childVirtualizationEnabled: options.virtualize,
      algorithmResolution: options.resolution,
      polygonFilterEnabled: options.polygonFilter,
      valueMetricIndex: options.valueMetricIndex,
      metricCount: index.metricCount,
      viewportMetricCount: count,
      viewportMetricSums: sums,
    };
    const shown = [payload.pointKeys, payload.pointsPending, payload.instanceCount];
    const key = JSON.stringify([plan.signature, count, sums, ...shown]);
    return { payload, pointsBuffer: points.buffer ?? null, key };
  }

  // --- Reconcile: re-read the visible tree from the root, replace what changed

  /**
   * Read the root again, and
   * below every zone whose mass moved, the loaded children whose own mass
   * moved, inside the view and down to one level past the display. A zone
   * that changed gets new blocks (BLOCKS, DROP of the old ones) and the view
   * snaps to the new plan. `force` (RECONCILE) ignores the refresh TTL, the
   * read budget and camera moves.
   */
  async function reconcile(force) {
    if (!ready || !camera || surface !== "aggregate") return;
    if (reconciling) {
      reconcileFollowUp = reconcileFollowUp || force;
      return;
    }
    reconciling = true;
    const mark = moveId;
    const bounds = segments(camera.window?.bounds ?? camera.strict);
    const keepDepth = Math.ceil((depthOf(camera.zoom) + 1) / space.step);
    const ttl = network._refreshTtlMs ?? 0;
    const queue = [ROOT];
    let reads = 0;
    let changed = false;
    try {
      while (queue.length > 0 && (force || (reads < DELTA_MAX_READS && moveId === mark))) {
        const fresh = (zone) => now() - (fetchedAt.get(zone) ?? -Infinity) < ttl;
        const zones = queue.splice(0, RECONCILE_BATCH).filter((zone) => force || !fresh(zone));
        if (zones.length === 0) continue;
        reads += zones.length;
        const before = await read(zones, { refresh: true, unchanged: true });
        for (const [zone, previous] of before) {
          const current = index.get(zone);
          if (current === previous) continue;
          changed = true;
          if (!current || zoneDepth(zone) + 1 > keepDepth) continue;
          for (let r = 0; r < CHARS; r++) {
            if (previous && previous.children.count[r] === current.children.count[r]) continue;
            const child = childLocation(zone, r);
            const inView = space.overlap(bounds, space.decode(child)).overlap;
            if (index.get(child) && inView) queue.push(child);
          }
        }
      }
    } catch (error) {
      console.warn("[heat.worker] reconcile failed:", error);
    } finally {
      reconciling = false;
      if (changed) refresh({ snap: true });
      const followUp = reconcileFollowUp;
      reconcileFollowUp = null;
      if (followUp !== null) void reconcile(followUp);
      else scheduleReconcile(RECONCILE_IDLE_MS);
    }
  }

  function scheduleReconcile(ms) {
    if (!options.autoDelta) return;
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      // The camera and its reads own /sets: wait for them.
      const busy = inflight.size > 0 || now() - lastMoveAt < RECONCILE_DEBOUNCE_MS;
      if (busy) scheduleReconcile(RECONCILE_IDLE_MS);
      else void reconcile(false);
    }, ms);
  }

  // --- Messages

  // A thin table answers "empty" or nothing for zones it cannot route: a
  // wider one deserves a second chance at them.
  function retryWider() {
    empty.clear();
    retryAt.clear();
    if (!camera) return;
    scheduleRefresh();
    scheduleReconcile(RECONCILE_DEBOUNCE_MS);
  }

  async function init(payload) {
    if (typeof payload.bearer === "string" && payload.bearer.length > 0) {
      globalThis.__INDEXUS_BEARER__ = payload.bearer;
    }
    setDebugSink((channel, event, fields) => {
      const at = Date.now();
      post({ type: "DEBUG_LOG", payload: { channel, event, fields: fields ?? null, at } });
    });
    if (payload.debugSdk !== undefined) setDebug(payload.debugSdk);
    options = readOptions(payload);
    columns =
      Array.isArray(payload.columns) && payload.columns.length ? payload.columns.map(Number) : null;
    surface = payload.surface === "nearby" ? "nearby" : "aggregate";
    const built = buildCollectionAndSpace(payload.collection);
    space = built.space;
    collection = built.collection.name();
    // The collection's column kinds: given by the app, or read from its
    // description once the network is up (null: every column a sum).
    kinds = Array.isArray(payload.kinds) ? payload.kinds.slice() : null;
    index = createZoneIndex(space, { kinds });
    const { protocol, peers, concurrency, cacheSize, setsPool = {} } = payload.network;
    network = new Network(protocol, api, peers, concurrency, cacheSize, setsPool);
    const context = { space, index, network, collection, options, post };
    pointOverlay = createPointOverlay({ ...context, onRead: scheduleRefresh });
    nearby = createNearbySearch(context);
    telemetry = watchNetwork(network, { post, visible: () => visible, onWider: retryWider });
    telemetry.update();
    await network.whenReady();
    if (!kinds && typeof network.collectionDescription === "function") {
      // Read before any zone is ingested, so every summary uses the kinds.
      try {
        const description = await network.collectionDescription(collection);
        if (description && description.schema.some((k) => k !== "sum")) {
          kinds = description.schema.slice();
          index.kinds = kinds;
        }
      } catch (error) {
        debugLog("walk", "collection description unavailable", { collection, error: String(error) });
      }
    }
    telemetry.ready();
    ready = true;
    post({ type: "INIT_COMPLETE" });
    if (pendingMove) move(pendingMove);
  }

  function move(payload) {
    if (!ready || !visible) {
      pendingMove = payload;
      return;
    }
    pendingMove = null;
    if (surface !== "aggregate") return;
    lastMoveAt = now();
    moveId++;
    const strict = payload.strictBounds || payload.bounds;
    camera = { zoom: payload.zoom, strict, window: camera?.window ?? null };
    pointOverlay.cancel(segments(strict));
    refresh();
  }

  function setVisibility(next) {
    visible = next;
    if (!visible) {
      abortAll();
      clearTimeout(refreshTimer);
      refreshTimer = null;
    } else if (pendingMove) {
      move(pendingMove);
    } else {
      refresh();
    }
    telemetry?.update();
  }

  /** The main thread no longer holds `handles`: evicted by budget, or released after a DROP. */
  function storeEvicted(handles) {
    const dropped = [];
    for (const handle of handles) {
      const zone = live.get(handle);
      // An eviction: the zone's other blocks go too, and the walk will ask again.
      if (zone !== undefined) forget(zone, dropped);
      freeHandles.push(handle);
    }
    const released = new Set(handles);
    const orphans = dropped.filter((handle) => !released.has(handle));
    if (orphans.length > 0) post({ type: "DROP", handles: orphans });
    if (dropped.length > 0) scheduleRefresh();
  }

  async function loadPolygon(geojson) {
    if (!polygon) {
      if (!loadPolygonWasm) throw new Error("heat worker: no polygon loader");
      polygon = await loadPolygonWasm();
    }
    if (!polygon.loadGeojson(geojson)) {
      console.warn("[heat.worker] polygon GeoJSON load failed: no truncation");
    }
    refresh();
  }

  function setSurface(next) {
    surface = next === "nearby" ? "nearby" : "aggregate";
    if (surface === "nearby") {
      abortReads();
    } else {
      nearby?.reset();
      if (pendingMove) move(pendingMove);
      else refresh();
    }
  }

  /**
   * Other metric columns: every zone held is read again with them, its blocks
   * replaced as they come; a zone that could not be read again is dropped. The
   * plan waits for the end of the swap, so that a pack never mixes columns.
   */
  async function setColumns(next, version = columnsVersion) {
    const value = Array.isArray(next) && next.length > 0 ? next.map(Number) : null;
    columnsVersion = version;
    if (String(value) === String(columns)) {
      // nothing to read again: the next plan carries the version all the same
      if (ready && swapping === 0) {
        sent = null;
        refresh({ snap: true });
      }
      return;
    }
    columns = value;
    abortReads();
    if (!ready) return;
    const swap = ++swapping;
    const zones = [...zoneHandles.keys()];
    const reread = new Set();
    try {
      for (let i = 0; i < zones.length && swap === swapping; i += SWAP_BATCH) {
        const batch = zones.slice(i, i + SWAP_BATCH);
        for (const zone of (await read(batch)).keys()) reread.add(zone);
      }
    } catch (error) {
      console.warn("[heat.worker] column swap:", error);
    }
    if (swap !== swapping) return;
    const dropped = [];
    for (const zone of zones) if (!reread.has(zone)) forget(zone, dropped);
    if (dropped.length > 0) post({ type: "DROP", handles: dropped });
    swapping = 0;
    refreshPending = false;
    sent = null;
    refresh({ snap: true });
  }

  /**
   * Count and metric sums of a region from a coarse read of its own: the
   * zones that cover `bounds` (at most `maxZones`, as deep as that allows),
   * read with `columns`, their rows weighted by their fraction inside. The
   * index and the blocks drawn are not touched.
   */
  async function regionSums({ bounds, columns: wanted = null, maxZones = 16 }) {
    const view = segments(bounds);
    const zones = coverZones(space, view, maxZones);
    const metrics = metricsOption("f32", wanted);
    const answer = await network.getSets(collection, zones, { raw: true, metrics });
    const blocks = answer.responses.flatMap((response) => response.blocks);
    return { ...blockSums(space, blocks, view, kinds), zones: zones.length };
  }

  function setOption(type, payload) {
    const [name, normalize] = OPTION_MESSAGES[type];
    const value = normalize(payload?.value, options[name]);
    if (value === options[name]) return;
    options[name] = value;
    viewportKey = "";
    refresh();
  }

  async function handle({ type, payload }) {
    try {
      if (OPTION_MESSAGES[type]) return setOption(type, payload);
      switch (type) {
        case "INIT":
          return await init(payload);
        case "MOVE":
          return move(payload);
        case "SET_VISIBILITY":
          return setVisibility(payload?.visible !== false);
        case "TRANSITION_COMPLETE":
          if (transition === null) return;
          if (payload?.snapshotVersion != null && payload.snapshotVersion !== transition) return;
          transition = null;
          if (held) {
            held = false;
            refresh();
          }
          return;
        case "STORE_EVICTED":
          return storeEvicted(payload?.handles ?? []);
        case "LOAD_POLYGON":
          return await loadPolygon(payload);
        case "SET_SURFACE":
          return setSurface(payload?.surface);
        case "SET_AUTO_DELTA":
          options.autoDelta = payload?.enabled === true;
          if (options.autoDelta) scheduleReconcile(RECONCILE_IDLE_MS);
          else clearTimeout(reconcileTimer);
          return;
        case "SEARCH":
          if (nearby) return await nearby.search(payload, { surface, drilling: inflight.size > 0 });
          return post({
            type: "SEARCH_RESULT",
            payload: { requestId: payload?.requestId, error: "network-not-ready", items: [] },
          });
        case "STATS": {
          const result = { requestId: payload?.requestId, totalCount: 0, metricSums: [] };
          if (ready && Array.isArray(payload?.bounds)) {
            const resolution = depthOf(Number(payload.zoom) || 0);
            const stats = regionStats(index, { bounds: segments(payload.bounds), resolution });
            result.totalCount = stats.totalCount;
            result.metricSums = Array.from(stats.metricSums);
          }
          return post({ type: "STATS_RESULT", payload: result });
        }
        case "SET_COLUMNS":
          return await setColumns(payload?.columns, payload?.version);
        case "SUMS": {
          const result = { requestId: payload?.requestId, totalCount: 0, metricSums: [] };
          if (ready && Array.isArray(payload?.bounds))
            Object.assign(result, await regionSums(payload));
          return post({ type: "SUMS_RESULT", payload: result });
        }
        case "RECONCILE":
          return await reconcile(true);
        case "CLEAR_SETS_CACHE":
          network?.clearSetsCache({
            owners: payload?.owners !== false,
            metrics: payload?.metrics === true,
          });
          nearby?.reset();
          return await reconcile(true);
        case "FORGET_PEER":
          network?.forgetPeer(payload?.hash);
          return;
        default:
          console.warn("[heat.worker] unknown command:", type);
      }
    } catch (error) {
      post({ type: "ERROR", payload: error?.message ?? String(error) });
    }
  }

  function destroy() {
    abortAll();
    for (const timer of [refreshTimer, retryTimer, reconcileTimer]) clearTimeout(timer);
    telemetry?.stop();
    ready = false;
  }

  return {
    handle,
    destroy,
    /** For tests and diagnostics. */
    get state() {
      const refreshing = refreshTimer !== null;
      return { index, live, inflight, empty, retryAt, sent, transition, snapshot, refreshing };
    },
  };
}
