#!/usr/bin/env node
// Node suite of the client read path, in the indexus-perf/1 format (docs/perf.md):
// /sets decoding (IXB2), Space encode/decode, the cells kernel CPU
// reference, a MOVE through the walk and a two-field mix. Time per operation
// and heap allocated by it.
//
//   node scripts/perf/run.mjs [--out result.json] [--quick]
//
// Prints the JSON on stdout unless --out is given; progress goes to stderr.
// Re-executes itself with --expose-gc and a large young generation so that a
// heap delta around one operation is the memory that operation allocated.
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { decodeBlocks, blocksToElements } from "../../src/wire/block.js";
import { projectRowsCPU } from "../../src/gpu/project.testkit.mjs";
import { createZoneIndex, walkViewport } from "../../src/walk/index.js";
import { planToInstancesCPU } from "../../src/walk/pack.testkit.mjs";
import {
  HEAT,
  RESOLUTION,
  makeSpace,
  randomPoints,
  drill,
  ingestAll,
} from "../../src/walk/walk.testkit.mjs";
import { fixture, encodeIXB2 } from "./wire-decode.mjs";
import { preparePack } from "../../src/gpu/pack.js";
import { compileExpression, prepareCombine } from "../../src/gpu/combine.js";
import { packEntriesF32 } from "../../src/gpu/pack.testkit.mjs";
import { combineCPU, fieldRows } from "../../src/gpu/combine.testkit.mjs";
import { cellsJob, geoSpace } from "./cellsJob.mjs";
import { mixJob, MIX_EXPRESSION, MIX_NAMES, MIX_POSITION } from "./mixJob.mjs";
import { metric, perfResult } from "./result.mjs";

const NODE_FLAGS = ["--expose-gc", "--min-semi-space-size=64", "--max-semi-space-size=64"];

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : null;
const RUNS = quick ? 5 : 15;
const WARMUP = quick ? 2 : 5;
// Warm-up also lasts at least this long, so that the JIT has tiered up
// before the first sample (short calls otherwise speed up mid-series).
const WARMUP_MS = quick ? 100 : 500;

function log(text) {
  process.stderr.write(text + "\n");
}

// JS heap plus ArrayBuffer backing stores, which live outside heapUsed.
function memory() {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

// Below this a single call is too short for the timer: a sample repeats it.
const SAMPLE_MS = 5;

/**
 * Times `operation` RUNS times after WARMUP calls. Each sample: wall time per
 * call, and memory growth across it with every result still referenced
 * (garbage it made plus what it returns, i.e. what it allocated), per call.
 */
function measure(name, operation) {
  let start = performance.now();
  let calls = 0;
  while (calls < WARMUP || performance.now() - start < WARMUP_MS) {
    operation();
    calls++;
  }
  const repeat = Math.max(1, Math.ceil(SAMPLE_MS / ((performance.now() - start) / calls)));
  const ms = [];
  const kib = [];
  for (let i = 0; i < RUNS; i++) {
    const kept = new Array(repeat);
    globalThis.gc();
    const before = memory();
    start = performance.now();
    for (let j = 0; j < repeat; j++) kept[j] = operation();
    ms.push((performance.now() - start) / repeat);
    kib.push((memory() - before) / 1024 / repeat);
    if (kept[0] === undefined) throw new Error(`${name} returned nothing`);
  }
  log(
    `  ${name}: ${[...ms].sort((a, b) => a - b)[ms.length >> 1].toFixed(3)} ms (×${repeat} per sample)`,
  );
  return [metric(name, "ms", ms), metric(name, "KiB", kib)];
}

function wireMetrics() {
  const rows = 10_000;
  const parents = fixture(rows, 50);
  const ixb2 = encodeIXB2(parents);
  return [
    ...measure(`wire.ixb2.decode/${rows}`, () => decodeBlocks(ixb2).blocks),
    ...measure(`wire.ixb2.decode+elements/${rows}`, () =>
      blocksToElements("c", decodeBlocks(ixb2).blocks),
    ),
    // Sizes are exact: one sample, no noise.
    metric(`wire.ixb2.body/${rows}`, "B", ixb2.byteLength),
    metric(`wire.ixb2.gzip/${rows}`, "B", gzipSync(ixb2).byteLength),
  ];
}

function spaceMetrics() {
  const n = 10_000;
  const space = geoSpace();
  let seed = 11;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const points = Array.from({ length: n }, () =>
    space.newPoint([[-90 + 180 * random(), -180 + 360 * random()]]),
  );
  const hashes = points.map((point) => space.encode(point, 8));
  return [
    ...measure(`space.encode/${n}`, () => points.map((point) => space.encode(point, 8))),
    ...measure(`space.decode/${n}`, () => hashes.map((hash) => space.decode(hash))),
    ...measure(`space.xyz/${n}`, () => hashes.map((hash) => space.xyz(hash))),
  ];
}

function cellsMetrics() {
  return [10_000, 100_000].flatMap((n) => {
    const job = cellsJob(n);
    return measure(`cells.projectRowsCPU/${n}`, () =>
      projectRowsCPU(job.block, job.tables, job.params),
    );
  });
}

// MOVE → instances ready, on the same blocks already read: the worker walks
// the zone index, then packs on the GPU, which Node cannot time:
// planToInstancesCPU, the kernel's CPU reference, stands for it. Two views
// alternate, so no call reuses the previous one's display.
function moveMetrics() {
  const space = makeSpace();
  const points = randomPoints(space, { seed: 3, count: 50_000, rect: [41, 51, -5, 9] });
  const zones = drill(points, { maxDepth: 3 });
  const rows = [...zones.values()].flat().reduce((sum, block) => sum + block.n, 0);
  const options = { limit: 5, children: 4, isCovered: () => false };
  const index = createZoneIndex(space);
  const store = ingestAll(index, zones);
  const position = { space, mode: "metrics", latIndex: 3, lngIndex: 4, metricScale: 1e6 };
  Object.assign(position, { latOffset: 90, lngOffset: 180 });
  const zoom = 4;
  const views = [
    [43, 47, -1, 4],
    [45, 49, 2, 7],
  ].map((view) => space.newSegment([view]));
  let turn = 0;
  const next = () => views[turn++ % views.length];
  const walk = (bounds) =>
    walkViewport(index, { zoom, resolution: RESOLUTION, bounds, strictBounds: bounds, ...options });
  log(`  ${zones.size} zones, ${rows} rows`);
  return [
    ...measure(`move.v2.walk/${rows}`, () => walk(next())),
    ...measure(
      `move.v2.walk+cpuPack/${rows}`,
      () => planToInstancesCPU(walk(next()), store, HEAT, position).data,
    ),
  ];
}

// A frame of a two-field mix (docs/compose.md) on blocks already read. The
// GPU packs both collections, indexes their cells and combines them, which
// Node cannot time. `frame-cpu` is what the main thread pays for that frame:
// the plan buffers and uniforms of both packs and of the combine. `cpuJoin`
// is the same result computed on the CPU (the kernels' emulation, then a join
// on cell keys in a Map): what the GPU takes off the main thread.
function mixMetrics() {
  const { fields, rows } = mixJob(25_000);
  const program = compileExpression(MIX_EXPRESSION, MIX_NAMES);
  const info = (store) => (handle) => {
    const block = store.get(handle);
    return { n: block.n, depth: block.parent.length, suffixChars: block.suffixChars };
  };
  let turn = 0;
  const plans = () => {
    turn++;
    return fields.map((field) => field.walk(turn));
  };
  const job = (field, plan) => ({
    tables: field.tables,
    plan,
    heat: field.heat,
    position: MIX_POSITION,
    field: { cellOf: field.cellOf },
  });
  log(`  2 collections, ${rows} rows, ${plans().map((plan) => plan.capacity)} outputs`);
  return [
    ...measure(`mix.walk/${rows}`, plans),
    ...measure(`mix.walk+frame-cpu/${rows}`, () => {
      const [first, second] = plans();
      return [
        preparePack({ ...job(fields[0], first), info: info(fields[0].store) }),
        preparePack({ ...job(fields[1], second), info: info(fields[1].store) }),
        prepareCombine({ program, fields: [{}, {}], capacity: first.capacity, steady: true }),
      ];
    }),
    ...measure(`mix.walk+cpuJoin/${rows}`, () => {
      const packed = plans().map((plan, i) =>
        packEntriesF32({ ...job(fields[i], plan), blocks: fields[i].blocks }),
      );
      return combineCPU({
        fields: packed.map(({ field }) => ({ rows: fieldRows(field.buffer) })),
        program,
      });
    }),
  ];
}

function git(command) {
  try {
    return execFileSync("git", command, {
      cwd: dirname(fileURLToPath(import.meta.url)),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function environment() {
  const cpus = os.cpus();
  return {
    machine: process.env.PERF_MACHINE || os.hostname(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpus[0]?.model?.trim() ?? null,
    cores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    runtime: `node ${process.version}`,
    flags: NODE_FLAGS.join(" "),
    runs: RUNS,
    warmup: `${WARMUP} calls and ${WARMUP_MS} ms`,
  };
}

function main() {
  const metrics = [];
  const suites = [
    ["wire", wireMetrics],
    ["space", spaceMetrics],
    ["cells", cellsMetrics],
    ["move", moveMetrics],
    ["mix", mixMetrics],
  ];
  for (const [label, suite] of suites) {
    log(label);
    metrics.push(...suite());
  }
  // Dirty means the measured code (src/) differs from the commit, not the scripts.
  const dirty = git(["status", "--porcelain", "--untracked-files=no", "--", ":/src"]);
  const commit = git(["rev-parse", "--short", "HEAD"]);
  const result = perfResult({
    suite: "sdk-js/node",
    commit: commit && dirty ? `${commit}-dirty` : commit,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    env: environment(),
    metrics,
  });
  const text = JSON.stringify(result, null, 2) + "\n";
  if (out) {
    writeFileSync(out, text);
    log(`→ ${out}`);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (typeof globalThis.gc !== "function") {
    const child = spawnSync(
      process.execPath,
      [...NODE_FLAGS, fileURLToPath(import.meta.url), ...args],
      { stdio: "inherit" },
    );
    process.exitCode = child.status ?? 1;
  } else {
    main();
  }
}
