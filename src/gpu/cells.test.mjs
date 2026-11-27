import { test } from "node:test";
import assert from "node:assert/strict";
import { Space, Spherical, Linear, Collection } from "../tree/index.js";
import { Mask as BasicMask } from "../tree/mask.js";
import { Offset as BasicOffset } from "../tree/offset.js";
import { CELL_FLOATS, spaceTables, parentBounds } from "./cells.js";
import {
  projectRowsCPU,
  projectRowsF32,
  projectRowsGPU,
  readBackProjectionForCheck,
} from "./project.testkit.mjs";
import { seededRandom, rowsBlock, randomSuffix } from "./cells.testkit.mjs";

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
class Static {
  constructor(value) {
    this.value = value;
  }
  at(_i, j) {
    return this.value[j];
  }
}

function offsets(seed, length = 32) {
  return new BasicOffset([Array.from({ length }, (_, l) => (l * 37 + seed) % 64)]);
}

function geo() {
  return new Spherical("geo", [-90, 90, -180, 180]);
}

const dvf = new Collection("dvf", [{ type: "spherical", name: "geo", args: [-90, 90, -180, 180] }]);

// Real Spaces of the SDK, with every mask kind and offsets shorter than the tables.
const SPACES = {
  spherical: new Space([geo()], new BasicMask([0, 1]), offsets(5)),
  linear: new Space([new Linear("t", [0, 1700000000])], new BasicMask([0]), offsets(11)),
  cappedSphericalLinear: new Space(
    [geo(), new Linear("t", [-1000, 3e9])],
    new Capped([
      [0, 1, 2, 0, 1, 2],
      [0, 0, 1, 1, 2, 2],
      [2, 2, 2, 0, 1, 0],
    ]),
    offsets(23),
  ),
  staticShortOffset: new Space(
    [new Linear("z", [-5.5, 12.25])],
    new Static([0, 0, 0, 0, 0, 0]),
    offsets(3, 8),
  ),
  collection: new Space(dvf.dimensions(), dvf.mask(), dvf.offset()),
  // A root whose extents float32 cannot hold exactly.
  sphericalBox: new Space(
    [new Spherical("geo", [41.3, 51.1, -5.2, 9.6])],
    new BasicMask([0, 1]),
    offsets(7),
  ),
};

// Deepest parent whose cells Space can still tell apart in float64.
const MAX_DEPTH = {
  spherical: 12,
  linear: 6,
  cappedSphericalLinear: 10,
  staticShortOffset: 6,
  collection: 12,
  sphericalBox: 12,
};

function flatBounds(space, location) {
  return parentBounds(space, location);
}

function toSegments(space, flat) {
  const perDimension = [];
  let at = 0;
  for (const dimension of space.dimensions) {
    const length = dimension.segmentLength();
    perDimension.push(Array.from(flat.subarray(at, at + length)));
    at += length;
  }
  return space.newSegment(perDimension);
}

function fullView(space) {
  const root = parentBounds(space, "");
  const min = new Float64Array(space.size);
  const max = new Float64Array(space.size);
  for (let axis = 0; axis < space.size; axis++) {
    min[axis] = root[2 * axis];
    max[axis] = root[2 * axis + 1];
  }
  return { min, max };
}

// A view around the parent, clamped to the root: Spherical.segmentsOverlap
// wraps a longitude beyond ±180, the kernel does not (see cells.js).
function randomView(random, space, origin) {
  const root = parentBounds(space, "");
  const min = new Float64Array(space.size);
  const max = new Float64Array(space.size);
  for (let axis = 0; axis < space.size; axis++) {
    const lo = origin[2 * axis];
    const extent = origin[2 * axis + 1] - lo;
    const a = lo + extent * (random() * 1.2 - 0.1);
    const b = lo + extent * (random() * 1.2 - 0.1);
    min[axis] = Math.max(root[2 * axis], Math.min(a, b));
    max[axis] = Math.min(root[2 * axis + 1], Math.max(a, b));
  }
  return { min, max };
}

function randomCase(random, space, depth, suffixChars, n) {
  const parent = randomSuffix(random, depth);
  const suffixes = Array.from({ length: n }, () => randomSuffix(random, suffixChars));
  const block = rowsBlock(parent, suffixes, { metricCount: 2, random });
  return { parent, suffixes, block, origin: parentBounds(space, parent) };
}

function params(origin, depth, view, numerator = -1, denominator = -1) {
  return { origin, depth, view, numerator, denominator };
}

function assertBoundsMatchSpace(space, origin, result, parent, suffixes) {
  const C = space.size;
  for (let k = 0; k < result.count; k++) {
    const expected = flatBounds(space, parent + suffixes[result.rows[k]]);
    for (let i = 0; i < 2 * C; i++) {
      const actual = origin[2 * (i >> 1)] + result.cells[k * CELL_FLOATS + i];
      const want = expected[i];
      const cell = expected[i | 1] - expected[i & ~1];
      const scale = Math.max(Math.abs(want), Math.abs(cell));
      assert.ok(
        Math.abs(actual - want) <= 1e-9 * scale,
        `${parent}+${suffixes[result.rows[k]]} bound ${i}: ${actual} vs Space ${want}`,
      );
    }
  }
}

test("spaceTables mirror mask.at and offset.at", () => {
  for (const [name, space] of Object.entries(SPACES)) {
    const tables = spaceTables(space);
    assert.equal(tables.coordinates, space.size, name);
    assert.equal(tables.maxLevels, 32);
    for (let l = 0; l < 32; l++) {
      for (let n = 0; n < 6; n++) {
        assert.equal(tables.mask[l * 6 + n], space.mask.at(l, n));
      }
    }
    for (let l = 0; l < 32; l++) {
      assert.equal(tables.offset[l], space.offset.at(l));
    }
  }
  // A collection's offset repeats its name past the name's length.
  const short = spaceTables(SPACES.collection).offset;
  const name = dvf.offset().details;
  assert.deepEqual(
    Array.from(short),
    Array.from({ length: 32 }, (_, l) => name[l % name.length]),
  );
  assert.throws(
    () => spaceTables(new Space([geo(), geo()], new BasicMask([0, 1, 2, 3]), offsets(1))),
    RangeError,
  );
  assert.throws(
    () => spaceTables(new Space([geo()], new BasicMask([0, 2]), offsets(1))),
    RangeError,
  );
});

test("parentBounds is the float64 Space decode of the parent, root for an empty parent", () => {
  const space = SPACES.spherical;
  assert.deepEqual(Array.from(parentBounds(space, "")), [-90, 90, -180, 180]);
  assert.deepEqual(Array.from(parentBounds(space, "@")), [-90, 90, -180, 180]);
  const segment = space.decode("Vx7")[0];
  assert.deepEqual(Array.from(parentBounds(space, "Vx7")), segment.value());
});

test("projectRowsCPU gives the bounds of Space.decode(parent + suffix) for every Space", () => {
  const random = seededRandom(1);
  for (const [name, space] of Object.entries(SPACES)) {
    const tables = spaceTables(space);
    for (let depth = 0; depth <= MAX_DEPTH[name]; depth += 2) {
      for (const suffixChars of [1, 2, 3, 5, 6]) {
        const { parent, suffixes, block, origin } = randomCase(
          random,
          space,
          depth,
          suffixChars,
          40,
        );
        const result = projectRowsCPU(block, tables, params(origin, depth, fullView(space), 1, -1));
        assert.equal(
          result.count,
          block.n,
          `${name} depth ${depth}: the root view keeps every row`,
        );
        assert.deepEqual(
          Array.from(result.rows),
          Array.from({ length: block.n }, (_, i) => i),
        );
        assertBoundsMatchSpace(space, origin, result, parent, suffixes);
      }
    }
  }
});

// A cell that only touches the view edge is a tie: float64 rounding of Space
// and of the kernel may decide it either way when the root is not dyadic.
// Every other row must get the same answer.
test("projectRowsCPU keeps the rows Space.overlap keeps, in row order", () => {
  const random = seededRandom(2);
  for (const [name, space] of Object.entries(SPACES)) {
    const tables = spaceTables(space);
    let kept = 0;
    let dropped = 0;
    for (let trial = 0; trial < 30; trial++) {
      const depth = Math.floor(random() * (MAX_DEPTH[name] / 2));
      const suffixChars = 1 + Math.floor(random() * 3);
      const { parent, suffixes, block, origin } = randomCase(random, space, depth, suffixChars, 60);
      // Every third view is the exact bounds of one cell: its neighbours touch it.
      const view =
        trial % 3 === 2 ? cellView(space, parent + suffixes[0]) : randomView(random, space, origin);
      const viewSegments = toSegments(space, interleave(view));
      const expected = [];
      const ties = new Set();
      suffixes.forEach((suffix, row) => {
        const bounds = flatBounds(space, parent + suffix);
        if (space.overlap(viewSegments, toSegments(space, bounds)).overlap) {
          expected.push(row);
        }
        if (touches(bounds, view)) {
          ties.add(row);
        }
      });
      const result = projectRowsCPU(block, tables, params(origin, depth, view, 0, -1));
      const rows = Array.from(result.rows);
      assert.deepEqual(
        rows,
        [...rows].sort((a, b) => a - b),
        `${name} trial ${trial}: row order`,
      );
      assert.deepEqual(
        rows.filter((row) => !ties.has(row)),
        expected.filter((row) => !ties.has(row)),
        `${name} trial ${trial}`,
      );
      assertBoundsMatchSpace(space, origin, result, parent, suffixes);
      result.rows.forEach((row, k) => {
        const at = k * CELL_FLOATS + 2 * space.size;
        assert.equal(result.cells[at], block.metrics[row]);
        assert.equal(result.cells[at + 1], block.count[row]);
      });
      kept += expected.length;
      dropped += block.n - expected.length;
    }
    assert.ok(kept > 0 && dropped > 0, `${name}: views both keep and drop rows`);
  }
});

function touches(bounds, view) {
  for (let axis = 0; axis < view.min.length; axis++) {
    const scale = 1e-9 * (Math.abs(bounds[2 * axis]) + Math.abs(bounds[2 * axis + 1]));
    if (
      Math.abs(bounds[2 * axis] - view.max[axis]) <= scale ||
      Math.abs(bounds[2 * axis + 1] - view.min[axis]) <= scale
    ) {
      return true;
    }
  }
  return false;
}

function cellView(space, location) {
  const bounds = flatBounds(space, location);
  const min = new Float64Array(space.size);
  const max = new Float64Array(space.size);
  for (let axis = 0; axis < space.size; axis++) {
    min[axis] = bounds[2 * axis];
    max[axis] = bounds[2 * axis + 1];
  }
  return { min, max };
}

function interleave(view) {
  const flat = new Float64Array(2 * view.min.length);
  view.min.forEach((value, axis) => {
    flat[2 * axis] = value;
    flat[2 * axis + 1] = view.max[axis];
  });
  return flat;
}

test("projectRowsCPU reads keys across word boundaries and zeroes the padding", () => {
  const space = SPACES.linear;
  const suffixes = ["0000_", "_____", "zZ9a-"].map((s) => s + "Qq");
  const block = rowsBlock("Ab", suffixes, { random: seededRandom(3) });
  assert.equal(block.keyWords, 2);
  const origin = parentBounds(space, "Ab");
  const result = projectRowsCPU(
    block,
    spaceTables(space),
    params(origin, 2, fullView(space), -1, -1),
  );
  assertBoundsMatchSpace(space, origin, result, "Ab", suffixes);
  for (let k = 0; k < result.count; k++) {
    assert.deepEqual(
      Array.from(result.cells.subarray(k * CELL_FLOATS + 4, (k + 1) * CELL_FLOATS)),
      [0, 0, 0, 0],
    );
  }
});

test("inputs outside the tables or the block are rejected", () => {
  const space = SPACES.spherical;
  const tables = spaceTables(space, 4);
  const block = rowsBlock("", ["AB"], { metricCount: 1 });
  const origin = parentBounds(space, "");
  const view = fullView(space);
  assert.throws(() => projectRowsCPU(block, tables, params(origin, 3, view)), RangeError);
  assert.throws(() => projectRowsCPU(block, tables, params(origin, 0, view, 1, -1)), RangeError);
  assert.throws(
    () => projectRowsCPU({ ...block, keyWords: 2 }, tables, params(origin, 0, view)),
    RangeError,
  );
});

// Error of the WGSL arithmetic (emulated with Math.fround), in units of the
// child cell size: against the float64 reference (the float32 cost alone) and
// against Space. "absolute f32" is what float32 absolute coordinates would cost.
test("float32 error stays far below one cell when the suffix keeps ≤ 12 bits per coordinate", (t) => {
  const random = seededRandom(4);
  const lines = [
    "space depth suffix bits/coord | f32 vs f64 ref | f32 vs Space | absolute f32 (in cells)",
  ];
  for (const name of ["spherical", "sphericalBox", "linear"]) {
    const space = SPACES[name];
    const tables = spaceTables(space);
    for (const depth of [0, 2, 4, 6, 8, 12]) {
      if (depth > MAX_DEPTH[name]) {
        continue;
      }
      for (const suffixChars of [1, 2, 4]) {
        const bits = (6 * suffixChars) / space.size;
        const { parent, suffixes, block, origin } = randomCase(
          random,
          space,
          depth,
          suffixChars,
          200,
        );
        const p = params(origin, depth, fullView(space));
        const f32 = projectRowsF32(block, tables, p);
        const f64 = projectRowsCPU(block, tables, p);
        let reference = 0;
        let error = 0;
        let absolute = 0;
        for (let k = 0; k < f32.count; k++) {
          const expected = flatBounds(space, parent + suffixes[f32.rows[k]]);
          for (let i = 0; i < 2 * space.size; i++) {
            const at = k * CELL_FLOATS + i;
            const cell = expected[i | 1] - expected[i & ~1];
            if (cell === 0) {
              continue; // Space itself no longer splits this cell in float64.
            }
            const actual = origin[2 * (i >> 1)] + f32.cells[at];
            reference = Math.max(reference, Math.abs(f32.cells[at] - f64.cells[at]) / cell);
            error = Math.max(error, Math.abs(actual - expected[i]) / cell);
            absolute = Math.max(absolute, Math.abs(Math.fround(expected[i]) - expected[i]) / cell);
          }
        }
        const row = [name, depth, suffixChars, bits, reference, error, absolute];
        lines.push(
          row
            .map((v) => (typeof v === "number" && !Number.isInteger(v) ? v.toExponential(1) : v))
            .join(" "),
        );
        if (bits <= 12) {
          assert.ok(
            reference <= 2 ** (bits - 23),
            `${name} depth ${depth} suffix ${suffixChars}: ${reference}`,
          );
        }
      }
    }
  }
  for (const line of lines) {
    t.diagnostic(line);
  }
});

test("projectRowsF32 keeps the rows of projectRowsCPU away from the view edges", () => {
  const random = seededRandom(5);
  const space = SPACES.cappedSphericalLinear;
  const tables = spaceTables(space);
  for (let trial = 0; trial < 20; trial++) {
    const { block, origin } = randomCase(random, space, 4, 2, 100);
    const view = randomView(random, space, origin);
    const p = params(origin, 4, view, 1, 0);
    assert.deepEqual(
      Array.from(projectRowsF32(block, tables, p).rows),
      Array.from(projectRowsCPU(block, tables, p).rows),
    );
  }
});

test("projectRowsGPU returns null without WebGPU", async () => {
  const space = SPACES.spherical;
  const block = rowsBlock("", ["AB"]);
  const result = await projectRowsGPU(
    {},
    block,
    spaceTables(space),
    params(parentBounds(space, ""), 0, fullView(space)),
  );
  assert.equal(result, null);
});

// One fake device for the file: gpu/device.js keeps the first device it gets.
const events = [];
const device = executingDevice(events);
const adapter = { features: new Set(), requestDevice: async () => device };

async function withFakeGPU(run) {
  Object.defineProperty(globalThis.navigator, "gpu", {
    configurable: true,
    value: { requestAdapter: async () => adapter },
  });
  globalThis.GPUBufferUsage = {
    MAP_READ: 1,
    COPY_DST: 8,
    COPY_SRC: 4,
    STORAGE: 0x80,
    UNIFORM: 0x40,
  };
  globalThis.GPUMapMode = { READ: 1 };
  events.length = 0;
  try {
    await run();
  } finally {
    delete globalThis.navigator.gpu;
    delete globalThis.GPUBufferUsage;
    delete globalThis.GPUMapMode;
  }
}

test("projectRowsGPU encodes three passes on the shared device and never maps a buffer", async () => {
  await withFakeGPU(async () => {
    const space = SPACES.spherical;
    const random = seededRandom(6);
    const suffixes = Array.from({ length: 600 }, () => randomSuffix(random, 2));
    const block = rowsBlock("Ab", suffixes, { metricCount: 1, random });
    const p = params(parentBounds(space, "Ab"), 2, fullView(space), 0, -1);
    const created = device.created.length;
    const result = await projectRowsGPU(device, block, spaceTables(space), p);
    assert.equal(result.capacity, 600);
    assert.equal(result.countOffset, 3 * 4);
    assert.equal(await result.validation, null);
    const passes = events.filter((event) => event[0] === "dispatch").map((event) => event.slice(1));
    assert.deepEqual(passes, [
      ["countVisible", 3, [0, 1, 2, 5]],
      ["scanGroups", 1, [0, 5]],
      ["writeVisible", 3, [0, 1, 2, 3, 4, 5, 6, 7]],
    ]);
    assert.equal(events.filter((event) => event[0] === "map").length, 0);
    assert.equal(events.filter((event) => event[0] === "submit").length, 1);
    await result.release();
    assert.ok(device.created.slice(created).every((buffer) => buffer.destroyed));
    await assert.rejects(projectRowsGPU({}, block, spaceTables(space), p), /shared device/);
  });
});

// The fake executes each entry point in JS from the bytes the host uploaded:
// it checks the uniform layout, the table packing and the readback offsets.
test("projectRowsGPU buffers, read back, equal projectRowsF32", async () => {
  await withFakeGPU(async () => {
    const random = seededRandom(7);
    for (const [name, depth, suffixChars, n] of [
      ["spherical", 3, 2, 1000],
      ["sphericalBox", 5, 6, 700],
      ["cappedSphericalLinear", 2, 3, 257],
      ["collection", 1, 3, 300],
    ]) {
      const space = SPACES[name];
      const tables = spaceTables(space);
      const parent = randomSuffix(random, depth);
      const block = rowsBlock(
        parent,
        Array.from({ length: n }, () => randomSuffix(random, suffixChars)),
        {
          metricCount: 2,
          random,
        },
      );
      const origin = parentBounds(space, parent);
      const p = params(origin, depth, randomView(random, space, origin), 1, -1);
      const result = await projectRowsGPU(device, block, tables, p);
      const read = await readBackProjectionForCheck(device, result);
      await result.release();
      const expected = projectRowsF32(block, tables, p);
      assert.ok(expected.count > 0 && expected.count < n, `${name}: the view keeps some rows`);
      assert.equal(read.count, expected.count, name);
      assert.deepEqual(read.rows, expected.rows, name);
      assert.deepEqual(read.cells, expected.cells, name);
    }
  });
});

function executingDevice(log) {
  const created = [];
  const run = { countVisible, scanGroups, writeVisible };
  return {
    created,
    features: new Set(),
    lost: new Promise(() => {}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async ({ compute }) => ({
      entryPoint: compute.entryPoint,
      getBindGroupLayout: () => compute.entryPoint,
    }),
    createBuffer({ size }) {
      const bytes = new ArrayBuffer(size);
      const buffer = {
        size,
        bytes,
        destroyed: false,
        getMappedRange: () => bytes,
        unmap() {},
        mapAsync: async () => log.push(["map"]),
        destroy() {
          this.destroyed = true;
        },
      };
      created.push(buffer);
      return buffer;
    },
    createBindGroup({ entries }) {
      return Object.fromEntries(
        entries.map((entry) => [entry.binding, entry.resource.buffer.bytes]),
      );
    },
    createCommandEncoder: () => {
      const commands = [];
      return {
        beginComputePass: () => {
          let entryPoint;
          let group;
          return {
            setPipeline: (pipeline) => {
              entryPoint = pipeline.entryPoint;
            },
            setBindGroup: (_, value) => {
              group = value;
            },
            dispatchWorkgroups: (groups) => {
              log.push(["dispatch", entryPoint, groups, Object.keys(group).map(Number)]);
              commands.push(() => run[entryPoint](group, groups));
            },
            end() {},
          };
        },
        copyBufferToBuffer: (source, from, target, to, size) => {
          commands.push(() =>
            new Uint8Array(target.bytes, to, size).set(new Uint8Array(source.bytes, from, size)),
          );
        },
        finish: () => commands,
      };
    },
    pushErrorScope() {},
    popErrorScope: async () => null,
    queue: {
      submit: (buffers) => {
        log.push(["submit"]);
        for (const commands of buffers) {
          commands.forEach((command) => command());
        }
      },
    },
  };
}

// The WGSL entry points, read from raw bindings (struct Params at binding 0).
function readParams(bytes) {
  const f = new Float32Array(bytes);
  const u = new Uint32Array(bytes);
  const i = new Int32Array(bytes);
  return {
    viewMin: f.subarray(0, 3),
    viewMax: f.subarray(4, 7),
    extent: f.subarray(8, 11),
    n: u[12],
    coordinates: u[13],
    depth: u[14],
    suffixChars: u[15],
    keyWords: u[16],
    maxLevels: u[17],
    numerator: i[18],
    denominator: i[19],
    groups: u[20],
  };
}

function project(group, row) {
  const p = readParams(group[0]);
  const tables = new Uint32Array(group[1]);
  const keys = new Uint32Array(group[2]);
  const lo = new Float32Array(3);
  const size = new Float32Array([1, 1, 1]);
  for (let c = 0; c < p.suffixChars; c++) {
    const level = p.depth + c;
    const bit = c * 6;
    const word = row * p.keyWords + (bit >>> 5);
    const shift = bit & 31;
    let value = (keys[word] << shift) >>> 0;
    if (shift > 26) {
      value = (value | (keys[word + 1] >>> (32 - shift))) >>> 0;
    }
    const cell = ((value >>> 26) + 64 - tables[p.maxLevels * 6 + level]) & 63;
    for (let b = 0; b < 6; b++) {
      const axis = tables[level * 6 + b];
      size[axis] *= 0.5;
      if ((cell >> (5 - b)) & 1) {
        lo[axis] += size[axis];
      }
    }
  }
  const low = new Float32Array(3);
  const high = new Float32Array(3);
  let visible = true;
  for (let axis = 0; axis < 3; axis++) {
    low[axis] = lo[axis] * p.extent[axis];
    high[axis] = Math.fround(lo[axis] + size[axis]) * p.extent[axis];
    if (axis < p.coordinates && (low[axis] > p.viewMax[axis] || high[axis] < p.viewMin[axis])) {
      visible = false;
    }
  }
  return { p, low, high, visible };
}

function countVisible(group, groups) {
  const p = readParams(group[0]);
  const offsets = new Uint32Array(group[5]);
  for (let g = 0; g < groups; g++) {
    offsets[g] = 0;
    for (let row = g * 256; row < Math.min(p.n, (g + 1) * 256); row++) {
      offsets[g] += project(group, row).visible ? 1 : 0;
    }
  }
}

function scanGroups(group) {
  const p = readParams(group[0]);
  const offsets = new Uint32Array(group[5]);
  let running = 0;
  for (let g = 0; g < p.groups; g++) {
    const value = offsets[g];
    offsets[g] = running;
    running += value;
  }
  offsets[p.groups] = running;
}

function writeVisible(group, groups) {
  const offsets = new Uint32Array(group[5]);
  const cells = new Float32Array(group[6]);
  const rows = new Uint32Array(group[7]);
  const counts = new Uint32Array(group[3]);
  const metrics = new Float32Array(group[4]);
  for (let g = 0; g < groups; g++) {
    let rank = offsets[g];
    for (let row = g * 256; row < (g + 1) * 256; row++) {
      const { p, low, high, visible } = project(group, row);
      if (row >= p.n || !visible) {
        continue;
      }
      const base = rank * CELL_FLOATS;
      for (let axis = 0; axis < p.coordinates; axis++) {
        cells[base + 2 * axis] = low[axis];
        cells[base + 2 * axis + 1] = high[axis];
      }
      const value = (column) => (column < 0 ? counts[row] : metrics[column * p.n + row]);
      cells[base + 2 * p.coordinates] = value(p.numerator);
      cells[base + 2 * p.coordinates + 1] = value(p.denominator);
      rows[rank++] = row;
    }
  }
}
