// The combine kernel on real walk plans of two collections of one Space:
// their keys differ (each collection has its offset), their Cells do not.
// The fake device runs the kernels' float32 emulation; the reference is
// combineCPU, a join on cell keys in float64 (combine.testkit.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

import { Collection, Space } from "../tree/index.js";
import { createZoneIndex, walkViewport } from "../walk/index.js";
import { HEAT, RESOLUTION, randomPoints, drill, ingestAll } from "../walk/walk.testkit.mjs";
import { spaceTables, parentBounds } from "./cells.js";
import { createArena } from "./arena.js";
import { createFrame, FRAME_PACK, FRAME_COMBINE } from "./frame.js";
import { createFieldBuffer, fieldLayout, FIELD_HEADER_WORDS } from "./field.js";
import { createPackKernel, createInstanceBuffer, INSTANCE_FLOATS, preparePack } from "./pack.js";
import {
  MAX_OPS,
  COMBINE_UNIFORM_BYTES,
  combineShader,
  compileExpression,
  createCombineKernel,
  evaluate,
} from "./combine.js";
import { packEntriesF32 } from "./pack.testkit.mjs";
import { combineCPU, emulateStage, fieldRows } from "./combine.testkit.mjs";
import { fakeDevice, withGPUGlobals } from "./device.testkit.mjs";

const VIEW = [41, 49, -4, 9];
const DIMENSIONS = [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }];
const METRICS = {
  mode: "metrics",
  latIndex: 3,
  lngIndex: 4,
  metricScale: 1e6,
  latOffset: 90,
  lngOffset: 180,
};
// Value per surface; and the mean surface, 20 to 200, a share once divided.
const PRICE = [{ num: 0, den: 1, minDen: 1e-6 }];
const SHARE = [{ num: 1, den: -1 }];
const MIX = "price * (1 - canopy / 200)";

/** A collection of the shared Space, its drilled zones and its walk. */
function fixture(name, { seed, count, rect }) {
  const collection = new Collection(name, DIMENSIONS);
  const space = new Space(collection.dimensions(), collection.mask(), collection.offset());
  const points = randomPoints(space, { seed, count, rect });
  const index = createZoneIndex(space);
  const store = ingestAll(index, drill(points, { maxDepth: 3 }));
  const blocks = {
    get: (handle) => ({
      rows: store.get(handle),
      origin: parentBounds(space, store.get(handle).parent),
    }),
  };
  const walk = (zoom) =>
    walkViewport(index, {
      zoom,
      resolution: RESOLUTION,
      bounds: space.newSegment([VIEW]),
      strictBounds: space.newSegment([VIEW]),
      limit: 5,
      children: 4,
      isCovered: () => false,
    });
  const cellOf = (handle) => space.xyz(store.get(handle).parent || "@").coordinates;
  return { space, store, blocks, tables: spaceTables(space), walk, cellOf };
}

const price = () => fixture("walkparityzones", { seed: 7, count: 600 });
// Another offset, other points, and nothing west of 2°E.
const canopy = () => fixture("canopyzonesAnglet", { seed: 11, count: 500, rect: [40, 50, 2, 10] });

function pack(f, plan, heat, position = METRICS) {
  const { blocks, tables, cellOf } = f;
  return packEntriesF32({ blocks, tables, plan, heat, position, field: { cellOf } });
}

const keyOf = (row) => `${row.resolution}:${row.cell.join(",")}`;

test("expressions compile to a bounded postfix program, total on every input", () => {
  const names = ["price", "heat", "canopy"];
  const run = (text, values) => evaluate(compileExpression(text, names), values, (v) => v);
  assert.equal(run("price", [3, 0, 0]), 3);
  assert.equal(run("price * (1 - canopy)", [200, 0, 0.25]), 150);
  assert.equal(run("1 + 2 * 3 - 4 / 8", []), 6.5);
  assert.equal(run("-price + 5", [2]), 3);
  assert.equal(run("2 - -price", [2]), 4);
  assert.equal(run("min(price, heat) + max(price, heat)", [2, 7]), 9);
  assert.equal(run("clamp(heat, 0, 1)", [0, 4]), 1);
  assert.equal(run("abs(price - heat)", [2, 7]), 5);
  assert.equal(run("log1p(price)", [Math.E - 1]), 1);
  // 0 at `from`, 1 at `to`, either way round.
  assert.equal(run("ramp(heat, 10, 30)", [0, 15]), 0.25);
  assert.equal(run("ramp(heat, 35, 15)", [0, 20]), 0.75);
  assert.equal(run("ramp(heat, 35, 15)", [0, 50]), 0);
  // Total: no infinity, no NaN.
  assert.equal(run("price / canopy", [5, 0, 0]), 0);
  assert.equal(run("ramp(heat, 3, 3)", [0, 3]), 0);
  assert.equal(run("log1p(price)", [-4]), 0);
  assert.equal(run("price * 1.5e2 + .5", [2]), 300.5);
  // Float32, as the kernel: every operation rounded.
  const third = evaluate(compileExpression("price / 3", names), [1]);
  assert.equal(third, Math.fround(1 / 3));

  for (const [text, message] of [
    ["price *", /operand is missing/],
    ["price * (1 - shade)", /"shade" is not a field/],
    ["sqrt(price)", /"sqrt" is not a function/],
    ["min(price)", /"," expected/],
    ["price heat", /"heat" is not expected/],
    ["(price", /"\)" expected/],
    [Array(MAX_OPS).fill("price").join(" + "), /more than 24 operations/],
    ["1+(1+(1+(1+(1+(1+(1+(1+(1+1))))))))", /more than 8 values/],
  ]) {
    assert.throws(() => compileExpression(text, names), message, text);
  }
});

test("layouts: the uniform is the WGSL struct, a field is header, table, rows", () => {
  const fields = combineShader.match(/struct Params \{([^}]*)\}/)[1];
  const sizes = { "array<vec4u, 12>": 192, vec4f: 16, vec4u: 16, u32: 4 };
  const bytes = [...fields.matchAll(/: ([^,\n]+(?:, \d+>)?),\n/g)].map(([, type]) => sizes[type]);
  assert.equal(
    bytes.reduce((sum, size) => sum + size, 0),
    COMBINE_UNIFORM_BYTES,
  );
  assert.deepEqual(fieldLayout(0), { tableSize: 4, rowsAt: 8, words: 8 });
  assert.deepEqual(fieldLayout(5), { tableSize: 16, rowsAt: 20, words: 50 });
  assert.deepEqual(fieldLayout(1000), { tableSize: 2048, rowsAt: 2052, words: 8052 });
});

test("the Cell of an output is its square, whatever the collection's offset", () => {
  const seen = [];
  for (const f of [price(), canopy()]) {
    const plan = f.walk(6);
    const packed = pack(f, plan, HEAT, { mode: "bounds" });
    const rows = fieldRows(packed.field.buffer);
    assert.equal(rows.length, plan.capacity);
    let checked = 0;
    rows.forEach((row, index) => {
      const o = index * INSTANCE_FLOATS;
      if (!row) {
        assert.equal(packed.data[o + 9], 0, "an output without rows has no value");
        return;
      }
      // Bounds position: the instance is the centre of its cell.
      const [lat, lng] = packed.data.subarray(o, o + 2);
      const cells = 2 ** row.resolution;
      const expected = [
        Math.floor(((lat + 90) / 180) * cells),
        Math.floor(((lng + 180) / 360) * cells),
        0,
      ];
      assert.deepEqual(row.cell, expected, `output ${index}`);
      assert.equal(row.resolution, packed.data[o + 10]);
      assert.deepEqual([row.num, row.den], [packed.data[o + 8], packed.data[o + 9]]);
      checked++;
    });
    assert.ok(checked > 50, `${checked} cells checked`);
    // The header: table size, capacity, coarsest resolution.
    const header = new Uint32Array(packed.field.buffer, 0, FIELD_HEADER_WORDS);
    const coarsest = Math.min(...rows.filter(Boolean).map((row) => row.resolution));
    assert.deepEqual(
      [...header],
      [fieldLayout(plan.capacity).tableSize, plan.capacity, coarsest, 0],
    );
    // Every row is in the table once.
    const table = new Uint32Array(packed.field.buffer, 16, header[0]);
    const owners = [...table].filter((owner) => owner !== 0).sort((a, b) => a - b);
    assert.deepEqual(
      owners,
      rows.flatMap((row, index) => (row ? [index + 1] : [])),
    );
    seen.push(new Set(rows.filter(Boolean).map(keyOf)));
  }
  const shared = [...seen[0]].filter((key) => seen[1].has(key));
  assert.ok(shared.length > 20, `the two collections share ${shared.length} cells`);
});

test("a field holds resolutions up to 32 and needs the zones' cells", () => {
  const f = price();
  const plan = f.walk(6);
  const info = (handle) => {
    const rows = f.store.get(handle);
    return { n: rows.n, depth: rows.parent.length, suffixChars: rows.suffixChars };
  };
  const job = { info, tables: f.tables, plan, heat: HEAT, position: METRICS };
  assert.equal(preparePack(job).field, null);
  const prepared = preparePack({ ...job, field: { cellOf: f.cellOf } });
  assert.equal(prepared.field.words, fieldLayout(plan.capacity).words);
  const deep = { ...plan, entries: plan.entries.slice() };
  deep.entries[4] = 33;
  assert.throws(
    () => preparePack({ ...job, plan: deep, field: { cellOf: f.cellOf } }),
    /resolutions up to 32|outside its block/,
  );
});

/** Packs both collections and combines them on one fake device, in one frame. */
async function combineOnDevice({ zooms = [6, 6], missing, expression, steady = true }) {
  const device = fakeDevice({ run: emulateStage });
  const frame = createFrame(device, { defer: () => {} });
  const program = compileExpression(expression, ["price", "canopy"]);
  const fields = [];
  for (const [i, f] of [price(), canopy()].entries()) {
    const arena = createArena(device);
    for (const [handle, rows] of f.store.blocks) {
      arena.put(handle, rows, parentBounds(f.space, rows.parent));
    }
    const plan = f.walk(zooms[i]);
    const kernel = await createPackKernel(device);
    const output = createInstanceBuffer(device, plan.capacity);
    const buffer = createFieldBuffer(device, plan.capacity);
    const job = { arena, tables: f.tables, plan, heat: i === 0 ? PRICE : SHARE, position: METRICS };
    frame.add(kernel, (encoder) =>
      kernel.encode(encoder, { ...job, output, field: { buffer, cellOf: f.cellOf } }),
    );
    fields.push({ f, plan, output, buffer, job });
  }
  const [first, second] = fields;
  // What the pack alone writes: the combine must leave the rest as it is.
  const packed = pack(first.f, first.plan, PRICE).data;
  const combine = await createCombineKernel(device);
  const before = device.log.length;
  frame.add(
    combine,
    (encoder) =>
      combine.encode(encoder, {
        program,
        fields: [{ buffer: first.buffer }, { buffer: second.buffer, missing }],
        instances: first.output,
        capacity: first.plan.capacity,
        steady,
      }),
    FRAME_COMBINE,
  );
  frame.submit();
  const events = device.log.slice(before);
  const rows = fields.map(({ buffer }) => fieldRows(buffer.bytes));
  const expected = combineCPU({
    fields: [{ rows: rows[0] }, { rows: rows[1], missing }],
    program,
  });
  const instances = new Float32Array(first.output.bytes, 0, first.plan.capacity * INSTANCE_FLOATS);
  return { device, events, rows, expected, instances, packed, plan: first.plan };
}

function assertCombined({ instances, packed, expected, plan }, steady = true) {
  let drawn = 0;
  for (let index = 0; index < plan.capacity; index++) {
    const o = index * INSTANCE_FLOATS;
    const want = expected[index] ?? [0, 0];
    for (const [k, value] of want.entries()) {
      const got = instances[o + 8 + k];
      assert.ok(
        Math.abs(got - value) <= 1e-5 * Math.max(1, Math.abs(value)),
        `output ${index} value ${k}: ${got} for ${value}`,
      );
      assert.equal(instances[o + 12 + k], steady ? got : packed[o + 12 + k]);
    }
    drawn += want[1] > 0 ? 1 : 0;
    // Geometry, resolution and slot are the pack's.
    for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 10, 11]) {
      assert.equal(instances[o + k], packed[o + k], `output ${index} float ${k}`);
    }
  }
  return drawn;
}

test("two fields, one frame: the combine equals the CPU reference, with one submit and no map", async () => {
  await withGPUGlobals(async () => {
    const run = await combineOnDevice({ expression: MIX });
    const { events, rows, expected, plan } = run;
    assert.equal(events.filter(([type]) => type === "submit").length, 1);
    assert.equal(run.device.log.filter(([type]) => type === "map").length, 0);
    const stages = events
      .filter(([type]) => type === "dispatch")
      .map(([, entryPoint]) => entryPoint);
    assert.deepEqual(stages, [
      "writeOutputs",
      "indexField",
      "writeOutputs",
      "indexField",
      "combine",
    ]);

    const drawn = assertCombined(run);
    // Cells of the first field only (nothing west of 2°E in the second) are
    // not drawn; cells of the second only are no output at all.
    const own = rows[0].filter((row) => row && row.den > 0).length;
    assert.ok(drawn > 20 && own - drawn > 20, `${drawn} of ${own} cells are drawn`);
    assert.equal(expected.length, plan.capacity);
    const firstKeys = new Set(rows[0].filter(Boolean).map(keyOf));
    const secondOnly = rows[1].filter((row) => row && !firstKeys.has(keyOf(row)));
    assert.ok(secondOnly.length > 20, `${secondOnly.length} cells are the second field's only`);

    // The value is the expression of the two means, on the first field's weight.
    const index = expected.findIndex((value) => value && value[1] > 0);
    const price = rows[0][index];
    const second = new Map(rows[1].filter(Boolean).map((row) => [keyOf(row), row]));
    let cell = { ...price };
    while (!second.has(keyOf(cell))) {
      cell = { resolution: cell.resolution - 1, cell: cell.cell.map((c) => c >> 1) };
    }
    const share = second.get(keyOf(cell));
    const value = (price.num / price.den) * (1 - share.num / share.den / 200);
    assert.ok(value > 0);
    assert.ok(
      Math.abs(expected[index][0] - value * price.den) < 1e-6 * Math.abs(value * price.den),
    );
  });
});

test("a missing field stands in with its `missing` value, or drops the cell", async () => {
  await withGPUGlobals(async () => {
    const dropped = await combineOnDevice({ expression: MIX });
    const kept = await combineOnDevice({ expression: MIX, missing: 0 });
    const own = kept.rows[0].filter((row) => row && row.den > 0).length;
    assert.equal(
      assertCombined(kept),
      own,
      "with a stand-in every cell of the first field is drawn",
    );
    assert.ok(assertCombined(dropped) < own);
    // Where the second field is missing, canopy = 0: the price itself.
    let alone = 0;
    kept.rows[0].forEach((row, index) => {
      if (!row || row.den === 0 || dropped.expected[index][1] > 0) return;
      const o = index * INSTANCE_FLOATS;
      assert.equal(kept.instances[o + 8], Math.fround(Math.fround(row.num / row.den) * row.den));
      alone++;
    });
    assert.ok(alone > 20);
  });
});

test("a coarser field is read at the enclosing cell; a finer one is missing", async () => {
  await withGPUGlobals(async () => {
    // The second collection walked two zooms out: its cells enclose the first's.
    const coarse = await combineOnDevice({ zooms: [7, 5], expression: "price * canopy" });
    const exact = new Set(coarse.rows[1].filter(Boolean).map(keyOf));
    const enclosed = coarse.rows[0].filter(
      (row, index) => row && coarse.expected[index][1] > 0 && !exact.has(keyOf(row)),
    );
    assert.ok(enclosed.length > 20, `${enclosed.length} cells read an enclosing cell`);
    assert.ok(assertCombined(coarse) > 20);

    // The other way round, the first field's cells are coarser than every
    // cell of the second: nothing encloses them.
    const fine = await combineOnDevice({ zooms: [3, 7], expression: "price * canopy" });
    const coarsest = Math.min(...fine.rows[1].filter(Boolean).map((row) => row.resolution));
    const below = fine.rows[0].filter((row) => row && row.resolution < coarsest);
    assert.ok(below.length > 0);
    assertCombined(fine);
    fine.rows[0].forEach((row, index) => {
      if (row && row.resolution < coarsest) {
        assert.deepEqual(fine.expected[index], [0, 0]);
      }
    });
  });
});

test("during a fade the combine leaves the previous values to the pack", async () => {
  await withGPUGlobals(async () => {
    const run = await combineOnDevice({ expression: MIX, steady: false });
    assert.ok(assertCombined(run, false) > 20);
  });
});

test("a field with no cell yet is missing everywhere, on its bound stand-in", async () => {
  await withGPUGlobals(async () => {
    const device = fakeDevice({ run: emulateStage });
    const f = price();
    const plan = f.walk(6);
    const arena = createArena(device);
    for (const [handle, rows] of f.store.blocks) {
      arena.put(handle, rows, parentBounds(f.space, rows.parent));
    }
    const kernel = await createPackKernel(device);
    const combine = await createCombineKernel(device);
    const output = createInstanceBuffer(device, plan.capacity);
    const buffer = createFieldBuffer(device, plan.capacity);
    const encoder = device.createCommandEncoder();
    kernel.encode(encoder, {
      arena,
      tables: f.tables,
      plan,
      heat: PRICE,
      position: METRICS,
      output,
      field: { buffer, cellOf: f.cellOf },
    });
    combine.encode(encoder, {
      program: compileExpression("price + canopy", ["price", "canopy"]),
      fields: [{ buffer }, { buffer: null, missing: 1000 }],
      instances: output,
      capacity: plan.capacity,
      steady: true,
    });
    device.queue.submit([encoder.finish()]);
    const groups = device.log.filter(
      ([type, layout]) => type === "bindGroup" && layout === "combine",
    );
    assert.deepEqual(groups.at(-1)[2], [0, 1, 2, 3, 4, 5]);
    const instances = new Float32Array(output.bytes);
    let drawn = 0;
    fieldRows(buffer.bytes).forEach((row, index) => {
      if (!row || row.den === 0) return;
      const value = Math.fround(Math.fround(row.num / row.den) + 1000);
      assert.equal(instances[index * INSTANCE_FLOATS + 8], Math.fround(value * row.den));
      drawn++;
    });
    assert.ok(drawn > 50);
  });
});
