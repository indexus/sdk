// Browser suite (docs/perf.md): the cells kernel on the real GPU and the
// AverageGridLayerWebGPU heatmap on synthetic instances, without MapLibre.
// Bundled into dist/perf.html by build.mjs. Writes an indexus-perf/1 result
// into <pre id="result">; document.title becomes DONE, NO-WEBGPU or FAIL.
import { getGPUContext } from "../../../src/gpu/device.js";
import { projectRowsCPU, projectRowsGPU } from "../../../src/gpu/project.testkit.mjs";
import AverageGridLayerWebGPU from "../../../src/map/visualization/AverageGridLayerWebGPU.js";
import { FLOATS_PER_INSTANCE } from "../../../src/walk/pack.js";
import { cellsJob } from "../cellsJob.mjs";
import { metric, perfResult } from "../result.mjs";

/* global __PERF_BUILD__ */
const BUILD = typeof __PERF_BUILD__ === "object" ? __PERF_BUILD__ : {};
const query = new URLSearchParams(location.search);
const RUNS = Number(query.get("runs")) || 15;
const WARMUP = 3;
const out = document.getElementById("result");
const progress = document.getElementById("progress");

function step(text) {
  progress.textContent = text;
}

async function cellsMetrics(device) {
  const metrics = [];
  for (const n of [10_000, 100_000, 1_000_000]) {
    step(`cells ${n}`);
    const job = cellsJob(n);
    const submit = [];
    const done = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const start = performance.now();
      const result = await projectRowsGPU(device, job.block, job.tables, job.params);
      const submitted = performance.now();
      await device.queue.onSubmittedWorkDone();
      const finished = performance.now();
      const error = await result.validation;
      await result.release();
      if (error) throw new Error(`cells ${n}: ${error.message}`);
      if (i < WARMUP) continue;
      submit.push(submitted - start);
      done.push(finished - start);
    }
    // submit: CPU side of one call (upload, encode, submit); done: until the GPU queue is idle.
    metrics.push(
      metric(`gpu.cells.submit/${n}`, "ms", submit),
      metric(`gpu.cells.done/${n}`, "ms", done),
    );
    if (n <= 100_000) {
      const cpu = [];
      for (let i = 0; i < WARMUP + RUNS; i++) {
        const start = performance.now();
        projectRowsCPU(job.block, job.tables, job.params);
        if (i >= WARMUP) cpu.push(performance.now() - start);
      }
      metrics.push(metric(`browser.cells.projectRowsCPU/${n}`, "ms", cpu));
    }
  }
  return metrics;
}

const mercatorX = (lng) => (lng + 180) / 360;
const mercatorY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI;
};

// Mercator [0,1] → clip over metropolitan France, the shape of MapLibre's
// transform.mercatorMatrix with an orthographic camera.
function franceMatrix(shift) {
  const x0 = mercatorX(-5) + shift;
  const x1 = mercatorX(10) + shift;
  const north = mercatorY(51.5);
  const south = mercatorY(41);
  const m = new Float64Array(16);
  m[0] = 2 / (x1 - x0);
  m[12] = -(x1 + x0) / (x1 - x0);
  m[5] = -2 / (south - north);
  m[13] = (south + north) / (south - north);
  m[10] = 1;
  m[15] = 1;
  return m;
}

const RESOLUTION_CONSTANT = 5;

// A steady pack (no transition): n cells on a lattice over France, each at
// the depth whose cell size matches the lattice, all in the live LOD slot.
function syntheticPack(n) {
  const side = Math.ceil(Math.sqrt(n));
  const step = 15 / side;
  const depth = Math.round(Math.log2(360 / step));
  const data = new Float32Array(n * FLOATS_PER_INSTANCE);
  for (let i = 0; i < n; i++) {
    const lng = -5 + step * ((i % side) + 0.5);
    const lat = 41 + (10.5 / side) * (Math.floor(i / side) + 0.5);
    const value = 1000 + 9000 * (0.5 + 0.5 * Math.sin(i * 0.37));
    data.set(
      [lat, lng, lat, lng, lat, lng, lat, lng, value, 1, depth, depth, 0, 0],
      i * FLOATS_PER_INSTANCE,
    );
  }
  return {
    data,
    count: n,
    centerDepth: depth,
    previousCenterDepth: depth,
    snapshotVersion: 1,
    depth,
  };
}

async function heatmapMetrics(context) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  if (!gl) return { metrics: [], note: "no WebGL2 context: heatmap not measured" };
  const map = { transform: { mercatorMatrix: franceMatrix(0) } };
  let packed = null;
  const effect = {
    smoothEdge: 0,
    fading: 0,
    multiplier: 2.5,
    areaMode: 0,
    colors: 24,
    colorInterpolation: (t) =>
      `rgb(${Math.round(255 * t)}, ${Math.round(80 + 120 * (1 - t))}, ${Math.round(255 * (1 - t))})`,
  };
  const controller = {
    getZoom: () => packed.depth - RESOLUTION_CONSTANT,
    getResolutionConstant: () => RESOLUTION_CONSTANT,
    getEffect: () => effect,
    getNormalizer: () => 10000,
    getHeatmapOpacity: () => 1,
    getTransitionFactor: () => 1,
    getPackedData: () => packed,
    getRenderScale: () => 1,
  };
  const layer = new AverageGridLayerWebGPU("perf", controller, context.device, context.features, {
    followCameraCentroids: true,
  });
  const metrics = [];
  const { device } = context;
  const frame = async () => {
    const start = performance.now();
    layer.render();
    const cpu = performance.now() - start;
    await device.queue.onSubmittedWorkDone();
    gl.finish();
    return [cpu, performance.now() - start];
  };
  try {
    packed = syntheticPack(10_000);
    layer.onAdd(map, gl);
    layer.setMaskEnabled(false);
    for (const n of [10_000, 100_000, 1_000_000]) {
      step(`heatmap ${n}`);
      const pack = syntheticPack(n);
      const upload = [];
      const moving = [];
      const movingCpu = [];
      const idle = [];
      for (let i = 0; i < WARMUP + Math.min(RUNS, 5); i++) {
        // A new pack object: the frame uploads the instances again.
        packed = { ...pack, data: pack.data.slice() };
        map.transform.mercatorMatrix = franceMatrix(i % 2 ? 1e-4 : 0);
        const [, total] = await frame();
        if (i >= WARMUP) upload.push(total);
      }
      for (let i = 0; i < WARMUP + RUNS; i++) {
        // Camera moved: full pipeline, instances already on the GPU.
        map.transform.mercatorMatrix = franceMatrix(((i % 7) + 1) * 1e-4);
        const [cpu, total] = await frame();
        // Camera still: the idle path only blits the last composite.
        const [, still] = await frame();
        if (i < WARMUP) continue;
        movingCpu.push(cpu);
        moving.push(total);
        idle.push(still);
      }
      metrics.push(
        metric(`gpu.heatmap.frame-upload/${n}`, "ms", upload),
        metric(`gpu.heatmap.frame/${n}`, "ms", moving),
        metric(`gpu.heatmap.frame-cpu/${n}`, "ms", movingCpu),
        metric(`gpu.heatmap.frame-idle/${n}`, "ms", idle),
      );
    }
  } finally {
    layer.onRemove();
  }
  return {
    metrics,
    note: "heatmap: 1280×720 offscreen, WebGL2 composite into a detached canvas, mask off",
  };
}

async function main() {
  const env = {
    machine: query.get("machine"),
    browser: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    devicePixelRatio,
  };
  const result = (metrics, extra = {}) =>
    perfResult({
      suite: "sdk-js/browser",
      commit: BUILD.commit ?? null,
      branch: BUILD.branch ?? null,
      env: { ...env, ...extra },
      metrics,
    });
  const context = globalThis.navigator?.gpu ? await getGPUContext() : null;
  if (!context) {
    document.title = "NO-WEBGPU";
    out.textContent = JSON.stringify(result([], { note: "no WebGPU adapter" }), null, 2);
    return;
  }
  const info = context.adapter.info ?? {};
  env.gpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || null;
  env.float32Blendable = context.features.float32Blendable;
  const cells = await cellsMetrics(context.device);
  const heatmap = await heatmapMetrics(context);
  out.textContent = JSON.stringify(
    result([...cells, ...heatmap.metrics], { runs: RUNS, note: heatmap.note }),
    null,
    2,
  );
  step("");
  document.title = "DONE";
}

document.getElementById("copy").addEventListener("click", async () => {
  const button = document.getElementById("copy");
  try {
    await navigator.clipboard.writeText(out.textContent);
    button.textContent = "Copié";
  } catch {
    // Clipboard refused (file://, no focus): select the text for a manual copy.
    getSelection().selectAllChildren(out);
    button.textContent = "Sélectionné : Ctrl/Cmd+C";
  }
});

main().catch((error) => {
  document.title = "FAIL";
  out.textContent = JSON.stringify(
    { status: "FAIL", error: String(error?.stack ?? error) },
    null,
    2,
  );
});
