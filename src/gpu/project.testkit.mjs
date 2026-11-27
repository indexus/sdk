// The first GPU kernel of the read path (wave 1): IXB2 rows -> Space bounds ->
// viewport culling -> compacted cells. No production path runs it since the
// pack kernel (gpu/pack.js) draws; it stays as the check of the shared suffix
// decode (gpu/wgsl/suffix.js) on a real GPU (scripts/gpu-check/cells-check)
// and as a perf reference (cells.projectRowsCPU). projectRowsF32 measures the
// float32 error without a GPU.
import { bufferUsage } from "./device.js";
import {
  computeContext,
  gpuUpload,
  releaseComputeJob,
  submitComputeJob,
} from "./compute.testkit.mjs";
import { BITS_PER_CHAR } from "../tree/index.js";
import { CELL_FLOATS, MAX_COORDINATES } from "./cells.js";
import { suffixWGSL } from "./wgsl/suffix.js";
import { decodeBitsInto } from "./suffix.testkit.mjs";

const WORKGROUP = 256;
const MAX_GROUPS = 65535;
const PARAMS_BYTES = 96;

/**
 * CPU reference of the kernel, in float64.
 *
 * Output, for every row whose bounds intersect params.view, in row order:
 * `cells` holds CELL_FLOATS floats per kept row — bounds relative to the
 * parent origin (absolute = params.origin[2c] + cells[2c]), numerator,
 * denominator — and `rows` the row index in the block.
 * @returns {{cells: Float64Array, rows: Uint32Array, count: number}}
 */
export function projectRowsCPU(block, tables, params) {
  return projectRows(block, tables, params, identity, Float64Array);
}

/**
 * The same computation rounded like the WGSL kernel (every f32 operation
 * through Math.fround). For tests and the browser check: it predicts the GPU
 * output and measures the float32 error without a GPU.
 * @returns {{cells: Float32Array, rows: Uint32Array, count: number}}
 */
export function projectRowsF32(block, tables, params) {
  return projectRows(block, tables, params, Math.fround, Float32Array);
}

function identity(value) {
  return value;
}

function projectRows(block, tables, params, round, CellArray) {
  const job = prepare(block, tables, params);
  const { n, coordinates, depth, suffixChars, keyWords } = job;
  const extent = job.extent.map(round);
  const viewMin = job.viewMin.map(round);
  const viewMax = job.viewMax.map(round);
  const cells = new CellArray(n * CELL_FLOATS);
  const rows = new Uint32Array(n);
  const lo = new CellArray(MAX_COORDINATES);
  const size = new CellArray(MAX_COORDINATES);
  let count = 0;

  for (let row = 0; row < n; row++) {
    decodeBitsInto(
      block.keys,
      row * keyWords,
      suffixChars * BITS_PER_CHAR,
      depth,
      tables,
      lo,
      size,
      round,
    );

    let visible = true;
    for (let axis = 0; axis < coordinates; axis++) {
      const min = round(lo[axis] * extent[axis]);
      const max = round(round(lo[axis] + size[axis]) * extent[axis]);
      if (min > viewMax[axis] || max < viewMin[axis]) {
        visible = false;
        break;
      }
      cells[count * CELL_FLOATS + 2 * axis] = min;
      cells[count * CELL_FLOATS + 2 * axis + 1] = max;
    }
    if (!visible) {
      continue;
    }

    cells[count * CELL_FLOATS + 2 * coordinates] = rowValue(block, job.numerator, row);
    cells[count * CELL_FLOATS + 2 * coordinates + 1] = rowValue(block, job.denominator, row);
    rows[count] = row;
    count++;
  }

  // A dropped row may have written bounds into the next free slot.
  cells.fill(0, count * CELL_FLOATS);
  return { cells: cells.subarray(0, count * CELL_FLOATS), rows: rows.subarray(0, count), count };
}

function rowValue(block, column, row) {
  return column < 0 ? block.count[row] : block.metrics[column * block.n + row];
}

// Checks the inputs and moves the view into the parent's frame, in float64.
function prepare(block, tables, params) {
  const coordinates = tables.coordinates;
  const depth = params.depth;
  const suffixChars = block.suffixChars;
  if (!Number.isInteger(depth) || depth < 0 || depth + suffixChars > tables.maxLevels) {
    throw new RangeError(
      `cells: levels ${depth}+${suffixChars} exceed the tables (${tables.maxLevels})`,
    );
  }
  if (block.keyWords !== Math.ceil((BITS_PER_CHAR * suffixChars) / 32)) {
    throw new RangeError(
      `cells: keyWords ${block.keyWords} does not match suffixChars ${suffixChars}`,
    );
  }
  for (const column of [params.numerator, params.denominator]) {
    if (!Number.isInteger(column) || column < -1 || column >= block.metricCount) {
      throw new RangeError(`cells: column ${column} is neither -1 (count) nor a metric`);
    }
  }

  const extent = new Float64Array(MAX_COORDINATES);
  const viewMin = new Float64Array(MAX_COORDINATES);
  const viewMax = new Float64Array(MAX_COORDINATES);
  for (let axis = 0; axis < coordinates; axis++) {
    const origin = params.origin[2 * axis];
    extent[axis] = params.origin[2 * axis + 1] - origin;
    viewMin[axis] = params.view.min[axis] - origin;
    viewMax[axis] = params.view.max[axis] - origin;
  }

  return {
    n: block.n,
    coordinates,
    depth,
    suffixChars,
    keyWords: block.keyWords,
    numerator: params.numerator,
    denominator: params.denominator,
    extent,
    viewMin,
    viewMax,
  };
}

// Three passes, no atomics: count the visible rows of each workgroup, scan
// those counts, then write every visible row at its rank. The output keeps
// row order and the scan leaves the total at offsets[groups].
export const cellsShader = /* wgsl */ `
struct Params {
  viewMin: vec4f,
  viewMax: vec4f,
  extent: vec4f,
  n: u32,
  coordinates: u32,
  depth: u32,
  suffixChars: u32,
  keyWords: u32,
  maxLevels: u32,
  numerator: i32,
  denominator: i32,
  groups: u32,
}

struct Cell {
  lo: array<f32, 3>,
  hi: array<f32, 3>,
  visible: bool,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> tables: array<u32>;
@group(0) @binding(2) var<storage, read> keys: array<u32>;
@group(0) @binding(3) var<storage, read> counts: array<u32>;
@group(0) @binding(4) var<storage, read> metrics: array<f32>;
@group(0) @binding(5) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(6) var<storage, read_write> cells: array<f32>;
@group(0) @binding(7) var<storage, read_write> rows: array<u32>;

var<workgroup> visibleInGroup: atomic<u32>;
var<workgroup> sums: array<u32, 256>;

${suffixWGSL()}
fn project(row: u32) -> Cell {
  // A var, not a let: some compilers refuse a runtime index into an array value.
  var box = decodeBits(row * params.keyWords, params.suffixChars * 6u, params.depth, params.maxLevels);
  var projected: Cell;
  projected.visible = true;
  for (var axis = 0u; axis < 3u; axis++) {
    let low = box.lo[axis] * params.extent[axis];
    let high = (box.lo[axis] + box.size[axis]) * params.extent[axis];
    projected.lo[axis] = low;
    projected.hi[axis] = high;
    if (axis < params.coordinates && (low > params.viewMax[axis] || high < params.viewMin[axis])) {
      projected.visible = false;
    }
  }
  return projected;
}

fn rowValue(column: i32, row: u32) -> f32 {
  if (column < 0) {
    return f32(counts[row]);
  }
  return metrics[u32(column) * params.n + row];
}

@compute @workgroup_size(256)
fn countVisible(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u,
                @builtin(workgroup_id) group: vec3u) {
  if (lid.x == 0u) {
    atomicStore(&visibleInGroup, 0u);
  }
  workgroupBarrier();
  if (gid.x < params.n && project(gid.x).visible) {
    atomicAdd(&visibleInGroup, 1u);
  }
  workgroupBarrier();
  if (lid.x == 0u) {
    offsets[group.x] = atomicLoad(&visibleInGroup);
  }
}

@compute @workgroup_size(256)
fn scanGroups(@builtin(local_invocation_id) lid: vec3u) {
  let t = lid.x;
  let chunk = (params.groups + 255u) / 256u;
  let start = min(t * chunk, params.groups);
  let stop = min(start + chunk, params.groups);
  var total = 0u;
  for (var g = start; g < stop; g++) {
    total += offsets[g];
  }
  sums[t] = total;
  workgroupBarrier();
  for (var step = 1u; step < 256u; step *= 2u) {
    var add = 0u;
    if (t >= step) {
      add = sums[t - step];
    }
    workgroupBarrier();
    sums[t] += add;
    workgroupBarrier();
  }
  var running = sums[t] - total;
  for (var g = start; g < stop; g++) {
    let value = offsets[g];
    offsets[g] = running;
    running += value;
  }
  if (t == 255u) {
    offsets[params.groups] = sums[255];
  }
}

@compute @workgroup_size(256)
fn writeVisible(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u,
                @builtin(workgroup_id) group: vec3u) {
  let row = gid.x;
  var cell: Cell;
  var flag = 0u;
  if (row < params.n) {
    cell = project(row);
    if (cell.visible) {
      flag = 1u;
    }
  }
  sums[lid.x] = flag;
  workgroupBarrier();
  for (var step = 1u; step < 256u; step *= 2u) {
    var add = 0u;
    if (lid.x >= step) {
      add = sums[lid.x - step];
    }
    workgroupBarrier();
    sums[lid.x] += add;
    workgroupBarrier();
  }
  if (flag == 0u) {
    return;
  }
  let rank = offsets[group.x] + sums[lid.x] - 1u;
  let base = rank * ${CELL_FLOATS}u;
  for (var axis = 0u; axis < params.coordinates; axis++) {
    cells[base + 2u * axis] = cell.lo[axis];
    cells[base + 2u * axis + 1u] = cell.hi[axis];
  }
  cells[base + 2u * params.coordinates] = rowValue(params.numerator, row);
  cells[base + 2u * params.coordinates + 1u] = rowValue(params.denominator, row);
  rows[rank] = row;
}
`;

// Bindings each entry point uses; layout "auto" drops the others.
const STAGES = [
  { entryPoint: "countVisible", bindings: [0, 1, 2, 5] },
  { entryPoint: "scanGroups", bindings: [0, 5] },
  { entryPoint: "writeVisible", bindings: [0, 1, 2, 3, 4, 5, 6, 7] },
];

/**
 * Encodes and submits the kernel on the shared device (gpu/device.js).
 * Nothing is read back: the result stays on the GPU for the render pass.
 *
 * @returns {Promise<null | {
 *   cells: GPUBuffer,      // capacity n·CELL_FLOATS f32, same layout as projectRowsCPU
 *   rows: GPUBuffer,       // capacity n u32, row index of each kept cell
 *   offsets: GPUBuffer,    // u32 count of kept rows at byte countOffset
 *   countOffset: number,
 *   capacity: number,
 *   validation: Promise<GPUError | null>,
 *   release: () => Promise<void>,
 * }>} null when WebGPU is unavailable
 */
export async function projectRowsGPU(device, block, tables, params) {
  const job = prepare(block, tables, params);
  const groups = Math.ceil(job.n / WORKGROUP);
  if (groups > MAX_GROUPS) {
    throw new RangeError(`cells: at most ${MAX_GROUPS * WORKGROUP} rows per block, got ${job.n}`);
  }

  const pipelines = await Promise.all(
    STAGES.map(({ entryPoint }) =>
      computeContext(`cells-${entryPoint}`, cellsShader, { entryPoint }),
    ),
  );
  if (pipelines.some((compiled) => !compiled)) {
    return null;
  }
  if (pipelines[0].device !== device) {
    throw new Error("cells: projectRowsGPU needs the shared device of gpu/device.js");
  }

  const buffers = [];
  let scope = true;
  device.pushErrorScope("validation");
  try {
    const resources = {
      0: gpuUpload(device, buffers, paramsBytes(job, tables, groups), bufferUsage.UNIFORM),
      1: gpuUpload(device, buffers, packTables(tables), bufferUsage.STORAGE),
      2: gpuUpload(device, buffers, block.keys, bufferUsage.STORAGE),
      3: gpuUpload(device, buffers, block.count, bufferUsage.STORAGE),
      4: gpuUpload(device, buffers, block.metrics, bufferUsage.STORAGE),
      5: storageBuffer(device, buffers, (groups + 1) * 4),
      6: storageBuffer(device, buffers, job.n * CELL_FLOATS * 4),
      7: storageBuffer(device, buffers, job.n * 4),
    };

    const encoder = device.createCommandEncoder({ label: "cells" });
    const dispatches = [groups, 1, groups];
    STAGES.forEach(({ bindings }, stage) => {
      const pipeline = pipelines[stage].pipeline;
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: bindings.map((binding) => ({ binding, resource: { buffer: resources[binding] } })),
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(dispatches[stage]);
      pass.end();
    });

    const validation = submitComputeJob(device, encoder);
    scope = false;
    return {
      cells: resources[6],
      rows: resources[7],
      offsets: resources[5],
      countOffset: groups * 4,
      capacity: job.n,
      validation,
      release: () => releaseComputeJob(device, buffers),
    };
  } catch (error) {
    await releaseComputeJob(device, buffers, { scope });
    throw error;
  }
}

/**
 * Copies a projectRowsGPU result back to the CPU. For tests and the browser
 * check only: the read path never maps its cells.
 * @returns {Promise<{cells: Float32Array, rows: Uint32Array, count: number}>}
 */
export async function readBackProjectionForCheck(device, result) {
  const cellBytes = result.capacity * CELL_FLOATS * 4;
  const rowBytes = result.capacity * 4;
  const usage = globalThis.GPUBufferUsage.MAP_READ | globalThis.GPUBufferUsage.COPY_DST;
  const read = device.createBuffer({ size: 4 + rowBytes + cellBytes, usage });
  try {
    const encoder = device.createCommandEncoder({ label: "cells-readback" });
    encoder.copyBufferToBuffer(result.offsets, result.countOffset, read, 0, 4);
    encoder.copyBufferToBuffer(result.rows, 0, read, 4, rowBytes);
    encoder.copyBufferToBuffer(result.cells, 0, read, 4 + rowBytes, cellBytes);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(globalThis.GPUMapMode.READ);
    const mapped = read.getMappedRange();
    const count = new Uint32Array(mapped, 0, 1)[0];
    const rows = new Uint32Array(mapped, 4, count).slice();
    const cells = new Float32Array(mapped, 4 + rowBytes, count * CELL_FLOATS).slice();
    read.unmap();
    return { cells, rows, count };
  } finally {
    read.destroy();
  }
}

function storageBuffer(device, buffers, bytes) {
  const usage = bufferUsage.STORAGE | bufferUsage.COPY_SRC;
  const buffer = device.createBuffer({ size: Math.max(4, bytes), usage });
  buffers.push(buffer);
  return buffer;
}

function packTables(tables) {
  const packed = new Uint32Array(tables.mask.length + tables.offset.length);
  packed.set(tables.mask, 0);
  packed.set(tables.offset, tables.mask.length);
  return packed;
}

// Layout of struct Params in cellsShader.
function paramsBytes(job, tables, groups) {
  const bytes = new ArrayBuffer(PARAMS_BYTES);
  const floats = new Float32Array(bytes);
  floats.set(job.viewMin, 0);
  floats.set(job.viewMax, 4);
  floats.set(job.extent, 8);
  new Uint32Array(bytes, 48).set([
    job.n,
    job.coordinates,
    job.depth,
    job.suffixChars,
    job.keyWords,
    tables.maxLevels,
  ]);
  new Int32Array(bytes, 72).set([job.numerator, job.denominator]);
  new Uint32Array(bytes, 80).set([groups]);
  return new Uint8Array(bytes);
}
