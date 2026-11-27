// Browser check of the cells kernel: GPU against its float32 emulation and
// the float64 reference, then timings. Bundled into dist/cells-check.html by
// build-cells-check.mjs. Writes JSON into <pre id="result"> and sets
// document.title to PASS, FAIL or NO-WEBGPU.
import { Space, Spherical, Linear } from "../../src/tree/index.js";
import { Mask as BasicMask } from "../../src/tree/mask.js";
import { Offset as BasicOffset } from "../../src/tree/offset.js";
import { getGPUContext } from "../../src/gpu/device.js";
import { CELL_FLOATS, spaceTables, parentBounds } from "../../src/gpu/cells.js";
import {
  projectRowsCPU,
  projectRowsF32,
  projectRowsGPU,
  readBackProjectionForCheck,
} from "../../src/gpu/project.testkit.mjs";
import { seededRandom, randomBlock, randomSuffix } from "../../src/gpu/cells.testkit.mjs";

// Test-only masks: the kernel only reads mask.at(level, bit), so these stand in
// for the Capped and Static masks the SDK no longer ships.
class Capped {
  constructor(value) {
    this.value = value;
  }
  at(i, j) {
    return this.value[Math.min(i, this.value.length - 1)][j];
  }
}

const SEED = 20261113;

function offsets(seed) {
  return new BasicOffset([Array.from({ length: 32 }, (_, l) => (l * 37 + seed) % 64)]);
}

const SPACES = {
  spherical: new Space(
    [new Spherical("geo", [-90, 90, -180, 180])],
    new BasicMask([0, 1]),
    offsets(5),
  ),
  sphericalBox: new Space(
    [new Spherical("geo", [41.3, 51.1, -5.2, 9.6])],
    new BasicMask([0, 1]),
    offsets(7),
  ),
  linear: new Space([new Linear("t", [0, 1700000000])], new BasicMask([0]), offsets(11)),
  cappedSphericalLinear: new Space(
    [new Spherical("geo", [-90, 90, -180, 180]), new Linear("t", [-1000, 3e9])],
    new Capped([
      [0, 1, 2, 0, 1, 2],
      [0, 0, 1, 1, 2, 2],
      [2, 2, 2, 0, 1, 0],
    ]),
    offsets(23),
  ),
};

const CASES = [
  ["spherical", 0, 1],
  ["spherical", 4, 2],
  ["spherical", 8, 4],
  ["sphericalBox", 3, 2],
  ["sphericalBox", 6, 6],
  ["linear", 2, 1],
  ["linear", 4, 3],
  ["cappedSphericalLinear", 2, 2],
  ["cappedSphericalLinear", 5, 5],
];

const SIZES = [10_000, 100_000, 1_000_000];

function makeJob(random, name, depth, suffixChars, n) {
  const space = SPACES[name];
  const tables = spaceTables(space);
  const parent = randomSuffix(random, depth);
  const block = randomBlock(random, parent, n, suffixChars, 2);
  const origin = parentBounds(space, parent);
  const min = new Float64Array(space.size);
  const max = new Float64Array(space.size);
  for (let axis = 0; axis < space.size; axis++) {
    const lo = origin[2 * axis];
    const extent = origin[2 * axis + 1] - lo;
    const a = lo + extent * random();
    const b = lo + extent * random();
    min[axis] = Math.min(a, b);
    max[axis] = Math.max(a, b);
  }
  const params = { origin, depth, view: { min, max }, numerator: 0, denominator: -1 };
  return { space, tables, block, params };
}

// Largest bound difference in units of the parent extent, and rows that differ.
function compare(gpu, reference, params, coordinates) {
  let maxBound = 0;
  let maxValue = 0;
  let k = 0;
  let j = 0;
  let rowsDiffer = 0;
  while (k < gpu.count || j < reference.count) {
    const a = k < gpu.count ? gpu.rows[k] : Infinity;
    const b = j < reference.count ? reference.rows[j] : Infinity;
    if (a !== b) {
      rowsDiffer++;
      if (a < b) {
        k++;
      } else {
        j++;
      }
      continue;
    }
    for (let axis = 0; axis < coordinates; axis++) {
      const extent = params.origin[2 * axis + 1] - params.origin[2 * axis];
      for (const side of [0, 1]) {
        const i = 2 * axis + side;
        const delta = Math.abs(
          gpu.cells[k * CELL_FLOATS + i] - reference.cells[j * CELL_FLOATS + i],
        );
        maxBound = Math.max(maxBound, delta / extent);
      }
    }
    for (const i of [2 * coordinates, 2 * coordinates + 1]) {
      const want = reference.cells[j * CELL_FLOATS + i];
      const delta = Math.abs(gpu.cells[k * CELL_FLOATS + i] - want);
      maxValue = Math.max(maxValue, delta / Math.max(1, Math.abs(want)));
    }
    k++;
    j++;
  }
  return { rowsDiffer, maxBound, maxValue };
}

async function runGPU(device, job) {
  const result = await projectRowsGPU(device, job.block, job.tables, job.params);
  try {
    const read = await readBackProjectionForCheck(device, result);
    const error = await result.validation;
    if (error) {
      throw new Error(error.message);
    }
    return read;
  } finally {
    await result.release();
  }
}

async function check(device, job, label) {
  const gpu = await runGPU(device, job);
  const f32 = projectRowsF32(job.block, job.tables, job.params);
  const f64 = projectRowsCPU(job.block, job.tables, job.params);
  const coordinates = job.tables.coordinates;
  const vsF32 = compare(gpu, f32, job.params, coordinates);
  const vsF64 = compare(gpu, f64, job.params, coordinates);
  // GPU must match its emulation; against float64 only rows on a view edge
  // may flip, and bounds stay within float32 rounding of the parent extent.
  const pass =
    gpu.count === f32.count &&
    vsF32.rowsDiffer === 0 &&
    vsF32.maxBound <= 2 ** -22 &&
    vsF32.maxValue <= 2 ** -22 &&
    vsF64.rowsDiffer <= Math.max(2, f64.count * 1e-4) &&
    vsF64.maxBound <= 2 ** -20;
  return { label, n: job.block.n, kept: gpu.count, keptF64: f64.count, vsF32, vsF64, pass };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeGPU(device, job) {
  const result = await projectRowsGPU(device, job.block, job.tables, job.params);
  await device.queue.onSubmittedWorkDone();
  await result.release();
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const timed = await projectRowsGPU(device, job.block, job.tables, job.params);
    await device.queue.onSubmittedWorkDone();
    samples.push(performance.now() - start);
    await timed.release();
  }
  return median(samples);
}

function timeCPU(job) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    projectRowsCPU(job.block, job.tables, job.params);
    samples.push(performance.now() - start);
  }
  return median(samples);
}

async function main() {
  const out = document.getElementById("result");
  if (!globalThis.navigator?.gpu) {
    document.title = "NO-WEBGPU";
    out.textContent = JSON.stringify({ status: "NO-WEBGPU" }, null, 2);
    return;
  }
  const context = await getGPUContext();
  if (!context) {
    document.title = "NO-WEBGPU";
    out.textContent = JSON.stringify({ status: "NO-WEBGPU", reason: "no adapter" }, null, 2);
    return;
  }
  const device = context.device;
  const random = seededRandom(SEED);

  const cases = [];
  for (const [name, depth, suffixChars] of CASES) {
    cases.push(
      await check(
        device,
        makeJob(random, name, depth, suffixChars, 5000),
        `${name} d${depth} s${suffixChars}`,
      ),
    );
  }

  const timings = [];
  for (const n of SIZES) {
    const job = makeJob(random, "spherical", 4, 2, n);
    const verdict = await check(device, job, `timing spherical d4 s2 n${n}`);
    cases.push(verdict);
    timings.push({ n, kept: verdict.kept, cpuMs: timeCPU(job), gpuMs: await timeGPU(device, job) });
  }

  const pass = cases.every((item) => item.pass);
  const adapter = context.adapter.info ?? {};
  const report = {
    status: pass ? "PASS" : "FAIL",
    seed: SEED,
    adapter: {
      vendor: adapter.vendor,
      architecture: adapter.architecture,
      description: adapter.description,
    },
    note: "gpuMs = upload + 3 passes until onSubmittedWorkDone, median of 5; cpuMs = projectRowsCPU, median of 3",
    timings,
    cases,
  };
  out.textContent = JSON.stringify(report, null, 2);
  document.title = report.status;
}

main().catch((error) => {
  document.title = "FAIL";
  document.getElementById("result").textContent = JSON.stringify(
    { status: "FAIL", error: String(error?.stack ?? error) },
    null,
    2,
  );
});
