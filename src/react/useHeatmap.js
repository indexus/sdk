// React bridge to the heatmap: the heat pipeline (map/heat/pipeline.js over
// map/workers/heat.worker.js). It needs WebGPU; without it nothing is drawn
// and the app shows its own notice (map/visualization/unsupported.js).
//
// The controller is one stable object whatever runs behind it: the layer and
// the app keep the one they got when the worker is recreated. Its setters are
// remembered and replayed on the next pipeline, and the point-overlay and
// network subscriptions live here.
//
// Options: `collection`, `gridOpt`, `cubeOpt`, `pointOverlay`, `network`,
// `effect`, `initialZoom`, `normalizer`, `cellPosition`, `bearer`, `surface`,
// `autoDelta`, the SET_* defaults (`polygonFilterEnabled`, `valueMetricIndex`,
// `childVirtualizationEnabled`), `onPeersChanged`, plus `heat` (gpu/pack.js
// rules, default: density), `summarize(totalCount, metricSums)` →
// `stats.summary`, and `budgetBytes` (the store's CPU copy of the blocks).
import { useCallback, useEffect, useMemo, useRef } from "react";

import { createHeatmapPipeline } from "../map/heat/pipeline.js";
import { COLLECTION_DEFAULTS } from "../map/lib/heatmapConfig.js";
import { webgpuSupport } from "../gpu/device.js";

/** log1p(count): what a collection without rules of its own shows. */
const DENSITY = [{ num: -1, den: -1, transform: 1 }];
const NOOP = () => {};
const EMPTY_PACKED = { count: 0, gpuBuffer: null, version: 0, snapshotVersion: 0 };
const EMPTY_OVERLAY = { enabled: false, points: [], keys: [], opacity: 0, stats: {} };

/** Controller methods forwarded to the pipeline that runs. */
const METHODS = [
  "getPackedData",
  "getZoom",
  "setReadVisibility",
  "getResolutionConstant",
  "getTransitionFactor",
  "getNormalizer",
  "getEffect",
  "setEffect",
  "getHeatmapOpacity",
  "getPointOverlay",
  "setPointOverlayReady",
  "forgetPeer",
  "setCellPosition",
  "setPointOverlayMaxPoints",
  "setCubeSubdivisionLimit",
  "setRequireCompleteChildren",
  "setPolygonFilterEnabled",
  "setValueMetricIndex",
  "setChildVirtualizationEnabled",
  "setAlgorithmResolution",
  "setNormalizer",
  "requestReconcile",
  "clearSetsCache",
  "setHeat",
  "onDeviceLost",
  "onDeviceRestored",
];

/** Setters that only matter once: not replayed on the next pipeline. */
const ONCE = new Set(["setPointOverlayReady", "forgetPeer"]);

function notifyAll(subscribers, value) {
  subscribers.last = value;
  for (const subscriber of subscribers) {
    try {
      subscriber(value);
    } catch {
      /* a subscriber's error is its own */
    }
  }
}

/** The MOVE payload of a MapLibre camera: strict view and a quarter margin. */
function moveOf(zoom, mapBounds) {
  const sw = mapBounds.getSouthWest();
  const ne = mapBounds.getNorthEast();
  const latStep = (ne.lat - sw.lat) / 4;
  const lngStep = (ne.lng - sw.lng) / 4;
  const wide = [sw.lat - latStep, ne.lat + latStep, sw.lng - lngStep, ne.lng + lngStep];
  return {
    zoom,
    bounds: [{ dimension: 0, segment: wide }],
    strictBounds: [{ dimension: 0, segment: [sw.lat, ne.lat, sw.lng, ne.lng] }],
  };
}

export function useHeatmap(props) {
  const { heat = DENSITY, summarize = null, budgetBytes, ...options } = props;
  const {
    collection,
    gridOpt,
    cubeOpt,
    pointOverlay,
    network,
    effect,
    initialZoom,
    normalizer,
    cellPosition,
    polygonFilterEnabled = true,
    valueMetricIndex = COLLECTION_DEFAULTS.valueMetricIndex,
    childVirtualizationEnabled = COLLECTION_DEFAULTS.childVirtualizationEnabled,
    bearer,
    surface = "aggregate",
    autoDelta = false,
  } = options;

  const supported = webgpuSupport().supported;
  const heatRef = useRef(null);
  const latest = useRef(null);
  latest.current = { heat, summarize, effect, normalizer, cellPosition, props };
  const remembered = useRef(new Map());
  const pointSubscribers = useRef(new Set());
  const networkSubscribers = useRef(new Set());
  const repaintRef = useRef(NOOP);
  const moveRef = useRef(null);
  const frameRef = useRef(null);
  const polygonRef = useRef(null);

  // The one controller the layer and the app keep.
  const controller = useMemo(() => {
    const fallbacks = {
      getPackedData: () => EMPTY_PACKED,
      getZoom: () => moveRef.current?.zoom ?? initialZoom,
      getResolutionConstant: () => cubeOpt?.resolution ?? COLLECTION_DEFAULTS.algorithmResolution,
      getTransitionFactor: () => 1,
      getNormalizer: () => latest.current.normalizer,
      getEffect: () => latest.current.effect,
      getHeatmapOpacity: () => 0,
      getPointOverlay: () => EMPTY_OVERLAY,
    };
    const facade = {
      subscribePointOverlay(handler) {
        if (typeof handler !== "function") return NOOP;
        pointSubscribers.current.add(handler);
        handler(facade.getPointOverlay());
        return () => pointSubscribers.current.delete(handler);
      },
      subscribeNetwork(handler) {
        if (typeof handler !== "function") return NOOP;
        networkSubscribers.current.add(handler);
        if (networkSubscribers.current.last) handler(networkSubscribers.current.last);
        return () => networkSubscribers.current.delete(handler);
      },
      get debugHeatmap() {
        return gridOpt?.debugHeatmap === true;
      },
    };
    for (const name of METHODS) {
      facade[name] = (...args) => {
        if (name.startsWith("set") && !ONCE.has(name)) remembered.current.set(name, args);
        const current = heatRef.current?.controller;
        if (current?.[name]) return current[name](...args);
        return fallbacks[name]?.();
      };
    }
    return facade;
    // The facade reads everything through refs; only debugHeatmap is captured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOpt?.debugHeatmap]);

  const replay = (next) => {
    for (const [name, args] of remembered.current) next[name]?.(...args);
  };

  // One worker per collection, network and options.
  useEffect(() => {
    if (!supported || !network?.peers?.length || bearer === "") return;
    const worker = new Worker(new URL("../map/workers/heat.worker.js", import.meta.url), {
      type: "module",
    });
    const app = latest.current;
    const next = createHeatmapPipeline({
      worker,
      collection,
      heat: app.heat,
      summarize: app.summarize && ((count, sums) => latest.current.summarize(count, sums)),
      cellPosition: app.cellPosition,
      budgetBytes,
      normalizer: app.normalizer,
      effect: app.effect,
      resolution: cubeOpt?.resolution,
      debugHeatmap: gridOpt?.debugHeatmap === true,
      onPeers: (peers) => latest.current.props.onPeersChanged?.(peers),
    });
    next.registerRepaint(() => repaintRef.current());
    const offPoints = next.controller.subscribePointOverlay((overlay) => {
      if (heatRef.current === next) notifyAll(pointSubscribers.current, overlay);
    });
    const offNetwork = next.controller.subscribeNetwork((state) => {
      if (heatRef.current === next) notifyAll(networkSubscribers.current, state);
    });
    next.init({
      network,
      cubeOpt,
      pointOverlay,
      bearer: bearer || undefined,
      debugSdk: gridOpt?.debugSdk ?? globalThis.__INDEXUS_DEBUG__ ?? false,
      polygonFilterEnabled: polygonFilterEnabled !== false,
      valueMetricIndex,
      childVirtualizationEnabled: childVirtualizationEnabled !== false,
      debugHeatmap: gridOpt?.debugHeatmap === true,
      surface: latest.current.props.surface === "nearby" ? "nearby" : "aggregate",
      autoDelta: latest.current.props.autoDelta === true,
    });
    heatRef.current = next;
    replay(next.controller);
    if (moveRef.current) next.move(moveRef.current);
    if (polygonRef.current) next.loadPolygon(polygonRef.current);
    return () => {
      offPoints();
      offNetwork();
      if (heatRef.current === next) heatRef.current = null;
      next.destroy();
    };
    // Rules, effect, normalizer and position update the running pipeline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, collection, gridOpt, cubeOpt, pointOverlay, network, bearer, budgetBytes]);

  const heatKey = JSON.stringify(heat);
  useEffect(() => {
    heatRef.current?.controller.setHeat(latest.current.heat);
  }, [heatKey]);
  useEffect(() => {
    if (effect) heatRef.current?.controller.setEffect(effect);
  }, [effect]);
  useEffect(() => {
    if (normalizer != null) heatRef.current?.controller.setNormalizer(normalizer);
  }, [normalizer]);
  useEffect(() => {
    heatRef.current?.setSurface(surface);
  }, [surface]);
  useEffect(() => {
    heatRef.current?.setAutoDelta(autoDelta === true);
  }, [autoDelta]);

  useEffect(
    () => () => {
      repaintRef.current = NOOP;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // One MOVE per frame.
  const handleMapMove = useCallback((zoom, mapBounds) => {
    moveRef.current = moveOf(zoom, mapBounds);
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      heatRef.current?.move(moveRef.current);
    });
  }, []);

  const onPolygonLoaded = useCallback((geojson) => {
    if (!geojson) return;
    polygonRef.current = geojson;
    heatRef.current?.loadPolygon(geojson);
  }, []);

  const registerRepaint = useCallback((requestRepaint) => {
    repaintRef.current = typeof requestRepaint === "function" ? requestRepaint : NOOP;
  }, []);

  const setSurface = useCallback((next) => {
    heatRef.current?.setSurface(next);
  }, []);

  const setAutoDelta = useCallback((enabled) => {
    heatRef.current?.setAutoDelta(enabled);
  }, []);

  const searchNearby = useCallback((opts = {}) => {
    if (!heatRef.current) return Promise.reject(new Error("mesh worker not ready"));
    return heatRef.current.search(opts);
  }, []);

  return {
    controller,
    handleMapMove,
    onPolygonLoaded,
    registerRepaint,
    requestReconcile: controller.requestReconcile,
    clearSetsCache: controller.clearSetsCache,
    setSurface,
    searchNearby,
    setAutoDelta,
  };
}

/**
 * @deprecated Renamed useHeatmap (it is the heat pipeline, not a grid
 * worker); this alias is the same function and goes in a later major.
 */
export const useGridWorker = useHeatmap;
