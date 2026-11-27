// Browser check of the pack kernel (src/gpu/pack.js) on real walk plans:
// synthetic points -> the zones a node would serve -> walkViewport -> the
// GPU, read back, against the reference (walk/pack.testkit.mjs, which has parity with
// the v1 worker) and against the kernel's float32 emulation. Scenarios:
// every tier of a view, bounds and metric positions, virtual bins with
// nudged anchors, deep virtual bins, transitions with enter and leave
// markers; then timings at 10k, 100k and 1M rows.
// Bundled into dist/pack-check.html by build-pack-check.mjs. Writes JSON into
// <pre id="result"> and sets document.title to PASS, FAIL or NO-WEBGPU.
import { ROOT, ROUTING_ALPHABET } from "../../src/tree/index.js";
import { getGPUContext } from "../../src/gpu/device.js";
import { spaceTables, parentBounds } from "../../src/gpu/cells.js";
import { createArena } from "../../src/gpu/arena.js";
import {
  INSTANCE_FLOATS,
  FLAG_LEAVE,
  FLAG_NUDGE,
  FLAG_VIRTUAL,
  createPackKernel,
  createInstanceBuffer,
  readBackInstancesForCheck,
} from "../../src/gpu/pack.js";
import { packEntriesF32 } from "../../src/gpu/pack.testkit.mjs";
import { seededRandom, sortedRandomBlock } from "../../src/gpu/cells.testkit.mjs";
import { createZoneIndex, walkViewport, planMotion, ENTRY_WORDS } from "../../src/walk/index.js";
import { planToInstancesCPU, transitionToInstancesCPU } from "../../src/walk/pack.testkit.mjs";
import {
  makeSpace,
  randomPoints,
  drill,
  serve,
  ingestAll,
  makeBlock,
} from "../../src/walk/walk.testkit.mjs";

const SEED = 20261113;
const RESOLUTION = 5;
const VIEW = [41, 49, -4, 9];
const STRICT = [44, 45, 2, 3];
const HEAT = [
  { num: 0, den: 1, minDen: 1e-6, transform: 0 },
  { num: 2, den: -1, minDen: 0, transform: 0 },
  { num: -1, den: -1, minDen: 0, transform: 1 },
];
const DENSITY = [{ num: -1, den: -1, minDen: 0, transform: 1 }];
const METRICS = {
  mode: "metrics",
  latIndex: 3,
  lngIndex: 4,
  metricScale: 1e6,
  latOffset: 90,
  lngOffset: 180,
};
const BOUNDS = { mode: "bounds" };
const SIZES = [10_000, 100_000, 1_000_000];
const TOLERANCE = {
  reference: { degrees: 2e-4, relative: 1e-4 },
  emulation: { degrees: 1e-4, relative: 1e-5 },
};

const space = makeSpace();
const tables = spaceTables(space);

/** Zones answering with items below `itemThreshold` points: coarse cells split from rows. */
function itemZones(points, itemThreshold) {
  const zones = new Map();
  const queue = [ROOT];
  while (queue.length) {
    const zone = queue.shift();
    const blocks = serve(points, zone, { itemThreshold });
    zones.set(zone, blocks);
    if (!blocks.length || blocks[0].suffixChars !== 1) {
      continue;
    }
    for (const point of points) {
      const child = point.location.slice(0, (zone === ROOT ? 0 : zone.length) + 1);
      if (
        (zone === ROOT || point.location.startsWith(zone)) &&
        !queue.includes(child) &&
        !zones.has(child)
      ) {
        queue.push(child);
      }
    }
  }
  return zones;
}

function fixture({ seed, count, virtual }) {
  const points = randomPoints(space, { seed, count });
  const index = createZoneIndex(space);
  const store = ingestAll(index, virtual ? itemZones(points, 40) : drill(points, { maxDepth: 3 }));
  const walk = (zoom) =>
    walkViewport(index, {
      zoom,
      resolution: RESOLUTION,
      bounds: space.newSegment([VIEW]),
      strictBounds: space.newSegment([virtual ? STRICT : VIEW]),
      limit: virtual ? 30 : 5,
      children: 4,
      isCovered: () => virtual,
      virtualize: virtual,
      nudgeAnchors: virtual,
    });
  return { store, walk };
}

function blocksOf(store) {
  return {
    get: (handle) => ({
      rows: store.get(handle),
      origin: parentBounds(space, store.get(handle).parent),
    }),
  };
}

// Largest differences: positions in degrees, values relative; and instances
// whose denominator is set on one side only.
function compare(gpu, reference) {
  let degrees = 0;
  let relative = 0;
  let presence = 0;
  for (let i = 0; i < reference.length; i++) {
    const field = i % INSTANCE_FLOATS;
    const delta = Math.abs(gpu[i] - reference[i]);
    if (field < 8) {
      degrees = Math.max(degrees, delta);
    } else {
      relative = Math.max(relative, delta / Math.max(1, Math.abs(reference[i])));
    }
    if (field === 9 && gpu[i] > 0 !== reference[i] > 0) {
      presence++;
    }
  }
  return { degrees, relative, presence, lengthOK: gpu.length === reference.length };
}

function within(verdict, tolerance) {
  return (
    verdict.lengthOK &&
    verdict.presence === 0 &&
    verdict.degrees <= tolerance.degrees &&
    verdict.relative <= tolerance.relative
  );
}

function filled(data) {
  let count = 0;
  for (let i = 9; i < data.length; i += INSTANCE_FLOATS) {
    count += data[i] > 0 ? 1 : 0;
  }
  return count;
}

async function runGPU(device, kernel, job) {
  device.pushErrorScope("validation");
  const encoder = device.createCommandEncoder({ label: "pack-check" });
  const result = kernel.encode(encoder, job);
  device.queue.submit([encoder.finish()]);
  const error = await device.popErrorScope();
  if (error) {
    throw new Error(error.message);
  }
  return {
    result,
    data: await readBackInstancesForCheck(device, job.output, result.instanceCount),
  };
}

function verdictOf(label, plan, gpu, reference, emulation) {
  const vsReference = compare(gpu, reference);
  const vsEmulation = compare(gpu, emulation);
  const virtualEntries = plan.entries.filter(
    (word, at) => at % ENTRY_WORDS === 5 && word & FLAG_VIRTUAL,
  ).length;
  return {
    label,
    entries: plan.entries.length / ENTRY_WORDS,
    virtualEntries,
    instances: gpu.length / INSTANCE_FLOATS,
    filled: filled(reference),
    vsReference,
    vsEmulation,
    pass:
      within(vsReference, TOLERANCE.reference) &&
      within(vsEmulation, TOLERANCE.emulation) &&
      filled(reference) > 0,
  };
}

function fillArena(arena, store) {
  for (const [handle, rows] of store.blocks) {
    arena.put(handle, rows, parentBounds(space, rows.parent));
  }
}

/** Every zoom of one fixture, in both position modes. */
async function checkFixture(device, kernel, name, options) {
  const { store, walk } = fixture(options);
  const arena = createArena(device);
  fillArena(arena, store);
  const cases = [];
  try {
    for (const zoom of [0, 1, 2, 3, 4, 5]) {
      const plan = walk(zoom);
      for (const [position, heat] of [
        [METRICS, HEAT],
        [BOUNDS, zoom % 2 ? DENSITY : HEAT],
      ]) {
        const output = createInstanceBuffer(device, plan.capacity);
        const gpu = await runGPU(device, kernel, { arena, tables, plan, heat, position, output });
        output.destroy();
        const reference = planToInstancesCPU(plan, store, heat, { ...position, space }).data;
        const emulation = packEntriesF32({
          blocks: blocksOf(store),
          tables,
          plan,
          heat,
          position,
        }).data;
        cases.push(
          verdictOf(`${name} zoom ${zoom} ${position.mode}`, plan, gpu.data, reference, emulation),
        );
      }
    }
  } finally {
    arena.destroy();
  }
  return cases;
}

/** A transition between two zooms; `forceLeave` flags some zones as leaving. */
async function checkTransition(device, kernel, from, to, forceLeave) {
  const { store, walk } = fixture({ seed: 17, count: 800, virtual: false });
  const before = walk(from);
  const after = walk(to);
  const depths = planMotion(before, after);
  if (forceLeave) {
    for (let e = 0; e < before.entries.length; e += 3 * ENTRY_WORDS) {
      before.entries[e + 5] |= FLAG_LEAVE;
    }
  }
  const arena = createArena(device);
  fillArena(arena, store);
  const output = createInstanceBuffer(device, before.capacity + after.capacity);
  const common = { arena, tables, heat: HEAT, position: METRICS, output };
  try {
    const first = await runGPU(device, kernel, { ...common, plan: before });
    const transition = {
      previousEntries: before.entries,
      previousDepth: depths.previousDepth,
      currentDepth: depths.currentDepth,
    };
    const second = await runGPU(device, kernel, {
      ...common,
      plan: after,
      transition: { ...transition, previous: { buffer: output, count: first.result.currentCount } },
    });
    const position = { ...METRICS, space };
    const previous = planToInstancesCPU(before, store, HEAT, position).data;
    const current = planToInstancesCPU(after, store, HEAT, position).data;
    const reference = transitionToInstancesCPU(after, current, before, previous, depths).data;
    const emulation = packEntriesF32({
      blocks: blocksOf(store),
      tables,
      plan: after,
      heat: HEAT,
      position: METRICS,
      transition: { ...transition, previous: first.data },
    }).data;
    const verdict = verdictOf(
      `transition ${from} -> ${to}${forceLeave ? " (forced leave)" : ""}`,
      after,
      second.data,
      reference,
      emulation,
    );
    let entering = 0;
    let leaving = 0;
    for (let i = 0; i < reference.length; i += INSTANCE_FLOATS) {
      entering += i < current.length && reference[i + 13] === -1 ? 1 : 0;
      leaving += i >= current.length && reference[i + 8] < 0 ? 1 : 0;
    }
    return { ...verdict, entering, leaving, pass: verdict.pass && entering + leaving > 0 };
  } finally {
    output.destroy();
    arena.destroy();
  }
}

/** One character's rows, three characters deep, binned `bits` bits below the zone. */
async function checkDeepBins(device, kernel, random, bits) {
  const first = ROUTING_ALPHABET[17];
  const suffixes = new Set();
  while (suffixes.size < 900) {
    suffixes.add(
      first +
        ROUTING_ALPHABET[Math.floor(random() * 64)] +
        ROUTING_ALPHABET[Math.floor(random() * 64)],
    );
  }
  const block = makeBlock(
    "A",
    [...suffixes].map((suffix) => ({
      suffix,
      count: 1 + Math.floor(random() * 9),
      metrics: [random() * 1e5, random() * 100, random() * 1e4, random() * 180e6, random() * 360e6],
    })),
  );
  const store = { get: () => block, blocks: new Map([[1, block]]) };
  const capacity = 2 ** (bits - 6);
  const res = 3 + bits / 2;
  const plan = {
    entries: Uint32Array.from([
      1,
      0,
      block.n,
      res + 1,
      res,
      FLAG_VIRTUAL | FLAG_NUDGE,
      0,
      capacity,
    ]),
    capacity,
    parents: new Int32Array(capacity).fill(-1),
    anchors: new Float64Array(0),
    anchorStride: 7,
    metricCount: 5,
    step: 3,
    strictView: Float64Array.from([-60, 10, -100, 40]),
  };
  const arena = createArena(device);
  fillArena(arena, store);
  const output = createInstanceBuffer(device, capacity);
  try {
    const gpu = await runGPU(device, kernel, {
      arena,
      tables,
      plan,
      heat: HEAT,
      position: METRICS,
      output,
    });
    const reference = planToInstancesCPU(plan, store, HEAT, { ...METRICS, space }).data;
    const emulation = packEntriesF32({
      blocks: blocksOf(store),
      tables,
      plan,
      heat: HEAT,
      position: METRICS,
    }).data;
    return verdictOf(`deep virtual bins, ${bits} bits`, plan, gpu.data, reference, emulation);
  } finally {
    output.destroy();
    arena.destroy();
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// A plan of the two shapes that read many rows, over item blocks of 4096
// rows three characters deep: per first character, either one plain cell
// (all its rows) or one virtual entry of 16 bins.
function timingPlan(random, totalRows) {
  const blocks = new Map();
  const words = [];
  const parents = [];
  let capacity = 0;
  let rows = 0;
  for (let handle = 1; rows < totalRows; handle++) {
    const parent = ROUTING_ALPHABET[handle % 64] + ROUTING_ALPHABET[Math.floor(handle / 64) % 64];
    const block = sortedRandomBlock(random, parent, 4096, 3, 5);
    for (let row = 0; row < block.n; row++) {
      block.metrics[3 * block.n + row] = random() * 180e6 * block.count[row];
      block.metrics[4 * block.n + row] = random() * 360e6 * block.count[row];
    }
    blocks.set(handle, block);
    rows += block.n;
    let first = 0;
    while (first < block.n) {
      const digit = block.keys[first] >>> 26;
      let end = first + 1;
      while (end < block.n && block.keys[end] >>> 26 === digit) {
        end++;
      }
      if (handle % 2) {
        words.push(handle, first, end - first, 9, 9, 0, capacity, 1);
        parents.push(-1);
        capacity += 1;
      } else {
        words.push(handle, first, end - first, 11, 11, FLAG_VIRTUAL, capacity, 16);
        for (let b = 0; b < 16; b++) {
          parents.push(-1);
        }
        capacity += 16;
      }
      first = end;
    }
  }
  const plan = {
    entries: Uint32Array.from(words),
    capacity,
    parents: Int32Array.from(parents),
    anchors: new Float64Array(0),
    anchorStride: 7,
    metricCount: 5,
    step: 3,
    strictView: null,
  };
  return { plan, rows, store: { get: (handle) => blocks.get(handle), blocks } };
}

async function timing(device, kernel, random, totalRows) {
  const { plan, rows, store } = timingPlan(random, totalRows);
  const arena = createArena(device);
  const putStart = performance.now();
  fillArena(arena, store);
  await device.queue.onSubmittedWorkDone();
  const putMs = performance.now() - putStart;
  const output = createInstanceBuffer(device, plan.capacity);
  const job = { arena, tables, plan, heat: HEAT, position: METRICS, output };
  try {
    const gpu = await runGPU(device, kernel, job);
    const cpuStart = performance.now();
    const reference = planToInstancesCPU(plan, store, HEAT, { ...METRICS, space }).data;
    const cpuMs = performance.now() - cpuStart;
    const vsReference = compare(gpu.data, reference);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const encoder = device.createCommandEncoder({ label: "pack-timing" });
      kernel.encode(encoder, job);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      samples.push(performance.now() - start);
    }
    return {
      rows,
      entries: plan.entries.length / ENTRY_WORDS,
      instances: plan.capacity,
      filled: filled(reference),
      putMs,
      gpuMs: median(samples),
      cpuMs,
      vsReference,
      pass: within(vsReference, TOLERANCE.reference),
    };
  } finally {
    output.destroy();
    arena.destroy();
  }
}

function addCopyButton(out) {
  const button = document.createElement("button");
  button.textContent = "Copier le résultat";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(out.textContent);
      button.textContent = "Copié";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(out);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      button.textContent = "Sélectionné : Ctrl+C";
    }
  });
  out.before(button);
}

async function main() {
  const out = document.getElementById("result");
  addCopyButton(out);
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
  const kernel = await createPackKernel(device);
  const random = seededRandom(SEED);

  const cases = [
    ...(await checkFixture(device, kernel, "zones", { seed: 7, count: 600, virtual: false })),
    ...(await checkFixture(device, kernel, "items", { seed: 21, count: 500, virtual: true })),
  ];
  for (const bits of [8, 12, 14, 18]) {
    cases.push(await checkDeepBins(device, kernel, random, bits));
  }
  cases.push(await checkTransition(device, kernel, 1.5, 3.5, false));
  cases.push(await checkTransition(device, kernel, 2.5, 4.5, false));
  cases.push(await checkTransition(device, kernel, 3.9, 2.1, true));
  const timings = [];
  for (const n of SIZES) {
    timings.push(await timing(device, kernel, random, n));
  }

  const virtualCases = cases.filter((item) => item.virtualEntries > 0).length;
  const pass =
    cases.every((item) => item.pass) && timings.every((item) => item.pass) && virtualCases > 4;
  const adapter = context.adapter.info ?? {};
  const report = {
    status: pass ? "PASS" : "FAIL",
    seed: SEED,
    adapter: {
      vendor: adapter.vendor,
      architecture: adapter.architecture,
      description: adapter.description,
    },
    note:
      "vsReference: GPU against walk/pack.testkit.mjs (float64, parity with v1); vsEmulation: against the kernel run in JS in " +
      "float32. degrees: largest position difference; relative: largest value difference / max(1, |value|); presence: " +
      "instances with d > 0 on one side only. gpuMs = encode + passes until onSubmittedWorkDone, median of 5; putMs = " +
      "arena upload of every block; cpuMs = the reference, once.",
    tolerance: TOLERANCE,
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
