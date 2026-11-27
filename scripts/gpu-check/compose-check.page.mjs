// Browser check and bench of the GPU composition (docs/compose.md) on the
// two-field mix of scripts/perf/mixJob.mjs: both collections packed with
// their fields and combined in one frame, on a real GPU. The instances are
// read back (for this check only) and compared with the kernels' float32
// emulation and with the CPU reference, a join on cell keys; then the frame
// is timed at several sizes.
// Bundled into dist/compose-check.html by build-compose-check.mjs. Writes JSON
// into <pre id="result"> and sets document.title to PASS, FAIL or NO-WEBGPU.
import { getGPUContext } from "../../src/gpu/device.js";
import { parentBounds } from "../../src/gpu/cells.js";
import { createArena } from "../../src/gpu/arena.js";
import { createFrame, FRAME_COMBINE } from "../../src/gpu/frame.js";
import { createFieldBuffer } from "../../src/gpu/field.js";
import {
  INSTANCE_FLOATS,
  createPackKernel,
  createInstanceBuffer,
  readBackInstancesForCheck,
} from "../../src/gpu/pack.js";
import { compileExpression, createCombineKernel, prepareCombine } from "../../src/gpu/combine.js";
import { packEntriesF32 } from "../../src/gpu/pack.testkit.mjs";
import { combineCPU, emulateCombineStage, fieldRows } from "../../src/gpu/combine.testkit.mjs";
import { mixJob, MIX_EXPRESSION, MIX_NAMES, MIX_POSITION } from "../perf/mixJob.mjs";

const SIZES = [2_000, 25_000, 100_000];
const EXPRESSIONS = [
  { expression: MIX_EXPRESSION },
  { expression: MIX_EXPRESSION, missing: 0 },
  { expression: "log1p(price) * ramp(canopy, 200, 20) + min(price, 1000) / max(canopy, 1)" },
];
// As pack-check (validated on hardware): positions within 1e-4°, values 1e-5 relative.
const TOLERANCE = { degrees: 1e-4, emulation: 1e-5, reference: 1e-5 };
const RUNS = 5;

function median(values) {
  return [...values].sort((a, b) => a - b)[values.length >> 1];
}

/** Arena, kernels and buffers of one collection on the device. */
async function fieldOnDevice(device, field) {
  const arena = createArena(device);
  for (const [handle, rows] of field.store.blocks) {
    arena.put(handle, rows, parentBounds(field.space, rows.parent));
  }
  const kernel = await createPackKernel(device);
  return { ...field, arena, kernel, capacity: 0, output: null, buffer: null };
}

/** One frame: both packs with their fields, then the combine; one submit. */
function encodeFrame(frame, fields, plans, combine, mix) {
  fields.forEach((field, i) => {
    const plan = plans[i];
    // Buffers grow by doubling; a replaced one is destroyed once the frame is submitted.
    if (plan.capacity > field.capacity) {
      const replaced = [field.output, field.buffer];
      frame.after(() => replaced.forEach((buffer) => buffer?.destroy()));
      field.capacity = 2 ** Math.ceil(Math.log2(plan.capacity));
      field.output = createInstanceBuffer(frame.device, field.capacity);
      field.buffer = createFieldBuffer(frame.device, field.capacity);
    }
    frame.add(field.kernel, (encoder) =>
      field.kernel.encode(encoder, {
        arena: field.arena,
        tables: field.tables,
        plan,
        heat: field.heat,
        position: MIX_POSITION,
        output: field.output,
        field: { buffer: field.buffer, cellOf: field.cellOf },
      }),
    );
  });
  frame.add(
    combine,
    (encoder) =>
      combine.encode(encoder, {
        program: mix.program,
        fields: [{ buffer: fields[0].buffer }, { buffer: fields[1].buffer, missing: mix.missing }],
        instances: fields[0].output,
        capacity: plans[0].capacity,
        steady: true,
      }),
    FRAME_COMBINE,
  );
  frame.submit();
}

/** The same frame in JS: the emulation's instances and the reference's values. */
function expected(fields, plans, mix) {
  const packed = fields.map((field, i) =>
    packEntriesF32({
      blocks: field.blocks,
      tables: field.tables,
      plan: plans[i],
      heat: field.heat,
      position: MIX_POSITION,
      field: { cellOf: field.cellOf },
    }),
  );
  const options = [{}, { missing: mix.missing }];
  const reference = combineCPU({
    fields: packed.map(({ field }, i) => ({ rows: fieldRows(field.buffer), ...options[i] })),
    program: mix.program,
  });
  const emulation = packed[0].data.slice();
  emulateCombineStage(
    "combine",
    {
      0: prepareCombine({
        program: mix.program,
        fields: options,
        capacity: plans[0].capacity,
        steady: true,
      }),
      1: emulation.buffer,
      2: packed[0].field.buffer,
      3: packed[1].field.buffer,
    },
    Math.ceil(plans[0].capacity / 64),
  );
  return { emulation, reference };
}

function compare(gpu, { emulation, reference }) {
  let vsEmulation = 0;
  let degrees = 0;
  let vsReference = 0;
  let presence = 0;
  let drawn = 0;
  for (let i = 0; i < emulation.length; i++) {
    const delta = Math.abs(gpu[i] - emulation[i]);
    if (i % INSTANCE_FLOATS < 8) degrees = Math.max(degrees, delta);
    else vsEmulation = Math.max(vsEmulation, delta / Math.max(1, Math.abs(emulation[i])));
  }
  reference.forEach((value, index) => {
    const [num, den] = value ?? [0, 0];
    const o = index * INSTANCE_FLOATS;
    vsReference = Math.max(vsReference, Math.abs(gpu[o + 8] - num) / Math.max(1, Math.abs(num)));
    presence += gpu[o + 9] > 0 !== den > 0 ? 1 : 0;
    drawn += den > 0 ? 1 : 0;
  });
  return { degrees, vsEmulation, vsReference, presence, drawn };
}

async function check(context, count) {
  const frame = createFrame(context.device, { defer: () => {} });
  const job = mixJob(count);
  const fields = await Promise.all(job.fields.map((field) => fieldOnDevice(context.device, field)));
  const combine = await createCombineKernel(context.device);
  const plans = fields.map((field) => field.walk(0));
  const cases = [];
  for (const { expression, missing } of EXPRESSIONS) {
    const mix = { program: compileExpression(expression, MIX_NAMES), missing };
    context.device.pushErrorScope("validation");
    encodeFrame(frame, fields, plans, combine, mix);
    const error = await context.device.popErrorScope();
    if (error) throw new Error(error.message);
    const gpu = await readBackInstancesForCheck(
      context.device,
      fields[0].output,
      plans[0].capacity,
    );
    const verdict = compare(gpu, expected(fields, plans, mix));
    cases.push({
      expression,
      missing: missing ?? "drop",
      outputs: plans.map((plan) => plan.capacity),
      ...verdict,
      pass:
        verdict.presence === 0 &&
        verdict.drawn > 0 &&
        verdict.degrees <= TOLERANCE.degrees &&
        verdict.vsEmulation <= TOLERANCE.emulation &&
        verdict.vsReference <= TOLERANCE.reference,
    });
  }

  // The frame, moving: a new view each time, both packs and the combine.
  const mix = { program: compileExpression(MIX_EXPRESSION, MIX_NAMES) };
  const gpuMs = [];
  const cpuMs = [];
  const submits = frame.submits;
  for (let run = 0; run < RUNS + 2; run++) {
    const start = performance.now();
    const moved = fields.map((field) => field.walk(run));
    const walked = performance.now();
    encodeFrame(frame, fields, moved, combine, mix);
    const encoded = performance.now();
    await context.device.queue.onSubmittedWorkDone();
    if (run >= 2) {
      cpuMs.push(encoded - walked);
      gpuMs.push(performance.now() - start);
    }
  }
  return {
    points: count,
    rows: job.rows,
    cases,
    frameMs: median(gpuMs),
    frameCpuMs: median(cpuMs),
    submitsPerFrame: (frame.submits - submits) / (RUNS + 2),
    pass: cases.every((item) => item.pass) && frame.submits - submits === RUNS + 2,
  };
}

async function main() {
  const out = document.getElementById("result");
  const context = globalThis.navigator?.gpu ? await getGPUContext() : null;
  if (!context) {
    document.title = "NO-WEBGPU";
    out.textContent = JSON.stringify({ status: "NO-WEBGPU" }, null, 2);
    return;
  }
  const sizes = [];
  for (const count of SIZES) {
    sizes.push(await check(context, count));
  }
  const adapter = context.adapter.info ?? {};
  const report = {
    status: sizes.every((size) => size.pass) ? "PASS" : "FAIL",
    adapter: {
      vendor: adapter.vendor,
      architecture: adapter.architecture,
      description: adapter.description,
    },
    note:
      "Per size: points per collection, two collections. vsEmulation: largest difference of the GPU instances " +
      "against the kernels run in JS in float32, relative to max(1, |value|); vsReference: of the combined " +
      "numerators against the CPU join in float64; presence: cells drawn on one side only. frameMs: walk of both " +
      "collections + encode + passes until onSubmittedWorkDone, median of 5 moving frames; frameCpuMs: the encode " +
      "alone (plan buffers, uniforms, one submit).",
    tolerance: TOLERANCE,
    sizes,
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
