// compose end to end in Node: two nodes serving two collections of one Space
// as IXB2, one heat worker each, both pipelines on one fake device that runs
// the kernels' float32 emulation (heat.testkit.mjs). The reference packs each
// plan on the CPU (walk/pack.testkit.mjs) and joins the cells in a Map (combineCPU).
import test from "node:test";
import assert from "node:assert/strict";

import { FLOATS_PER_INSTANCE } from "../../walk/index.js";
import { planToInstancesCPU } from "../../walk/pack.testkit.mjs";
import { HEAT, randomPoints } from "../../walk/walk.testkit.mjs";
import { compileExpression } from "../../gpu/combine.js";
import { combineCPU } from "../../gpu/combine.testkit.mjs";
import { withGPUGlobals } from "../../gpu/device.testkit.mjs";
import { compose } from "./compose.js";
import {
  DEFINITION,
  connect,
  connectFields,
  definitionOf,
  packDevice,
  readInstances,
  spaceOf,
  startNode,
} from "./heat.testkit.mjs";

const VIEW = [41, 49, -4, 9];
const CANOPY = definitionOf("canopyzonesAnglet");
// Rules in full: the CPU reference (walk/pack.testkit.mjs) reads them as they are.
const PRICE = [{ num: 0, den: 1, minDen: 1e-6, transform: 0 }];
const SURFACE = [{ num: 1, den: -1, minDen: 0, transform: 0 }];
const COUNT_PRICE = [{ num: 2, den: -1, minDen: 0, transform: 0 }];
const MIX = "price * (1 - canopy / 200)";

const count = (device, type) => device.log.filter((event) => event[0] === type).length;
const dispatches = (device, from) =>
  device.log
    .slice(from)
    .filter(([type]) => type === "dispatch")
    .map(([, entryPoint]) => entryPoint);

/** Two nodes, two collections: prices everywhere, canopy east of 2°E only. */
async function scenario(body, { expression = MIX, missing } = {}) {
  await withGPUGlobals(async () => {
    const spaces = [spaceOf(DEFINITION), spaceOf(CANOPY)];
    const nodes = [
      await startNode(randomPoints(spaces[0], { seed: 7, count: 600 })),
      await startNode(randomPoints(spaces[1], { seed: 11, count: 500, rect: [40, 50, 2, 10] })),
    ];
    const h = await connectFields(
      [
        { name: "price", node: nodes[0], collection: DEFINITION, rules: PRICE },
        { name: "canopy", node: nodes[1], collection: CANOPY, rules: SURFACE, missing },
      ],
      { expression },
    );
    try {
      await body(Object.assign(h, { spaces, nodes, missing }));
    } finally {
      h.close();
      for (const node of nodes) await node.stop();
    }
  });
}

/**
 * Field rows from the CPU reference of a pack, in bounds position: the
 * instance is then the centre of its cell, which gives the Cell.
 */
function referenceRows(pipeline, space, rules) {
  const { plan, store } = pipeline.state;
  const { data } = planToInstancesCPU(plan, store, rules, { space, mode: "bounds" });
  return Array.from({ length: plan.capacity }, (_, index) => {
    const [lat, lng] = data.subarray(index * FLOATS_PER_INSTANCE);
    const resolution = data[index * FLOATS_PER_INSTANCE + 10];
    if (lat === 0 && lng === 0 && resolution === 0) return null;
    const cells = 2 ** resolution;
    return {
      cell: [Math.floor(((lat + 90) / 180) * cells), Math.floor(((lng + 180) / 360) * cells), 0],
      resolution,
      num: data[index * FLOATS_PER_INSTANCE + 8],
      den: data[index * FLOATS_PER_INSTANCE + 9],
    };
  });
}

function reference(h, expression = MIX, rules = [PRICE, SURFACE]) {
  const { price, canopy } = h.pipeline.fields;
  return combineCPU({
    fields: [
      { rows: referenceRows(price, h.spaces[0], rules[0]) },
      { rows: referenceRows(canopy, h.spaces[1], rules[1]), missing: h.missing },
    ],
    program: compileExpression(expression, ["price", "canopy"]),
  });
}

/** The current half of the instances against the reference; returns the cells drawn. */
function assertCombined(h, expected, label) {
  const packed = h.pipeline.controller.getPackedData();
  const instances = readInstances(packed);
  const capacity = h.pipeline.state.plan.capacity;
  assert.equal(expected.length, capacity, `${label}: outputs`);
  let drawn = 0;
  expected.forEach((want, index) => {
    const [num, den] = want ?? [0, 0];
    const o = index * FLOATS_PER_INSTANCE;
    for (const [k, value] of [num, den].entries()) {
      const got = instances[o + 8 + k];
      assert.ok(
        Math.abs(got - value) <= 1e-5 * Math.max(1, Math.abs(value)),
        `${label}: output ${index} value ${k}: ${got} for ${value}`,
      );
    }
    drawn += den > 0 ? 1 : 0;
  });
  return drawn;
}

test("two collections on one layer: the instances are the CPU join of their cells", async () => {
  await scenario(async (h) => {
    h.move(6, VIEW);
    await h.settle();
    const { price, canopy } = h.pipeline.fields;
    assert.ok(price.state.plan.capacity > 50 && canopy.state.plan.capacity > 50);
    assert.equal(h.pipeline.controller, price.controller, "the layer reads the first field");
    const expected = reference(h);
    const drawn = assertCombined(h, expected, "zoom 6");
    const own = referenceRows(price, h.spaces[0], PRICE).filter((row) => row?.den > 0).length;
    // Canopy has nothing west of 2°E: those cells of the price are not drawn.
    assert.ok(drawn > 20 && own - drawn > 20, `${drawn} of ${own} cells drawn`);
    assert.equal(price.state.steady, true);
    const instances = readInstances(h.pipeline.controller.getPackedData());
    for (let o = 0; o < instances.length; o += FLOATS_PER_INSTANCE) {
      assert.deepEqual(instances.subarray(o + 12, o + 14), instances.subarray(o + 8, o + 10));
    }
    // The second field alone is untouched: its own heat, readable by another layer.
    const alone = readInstances(canopy.controller.getPackedData());
    const rows = referenceRows(canopy, h.spaces[1], SURFACE);
    rows.forEach((row, index) => {
      if (row) assert.equal(alone[index * FLOATS_PER_INSTANCE + 9], row.den);
    });
    assert.equal(count(h.device, "map"), 0, "nothing was read back from the GPU");
  });
});

test("a `missing` value keeps the cells the other field lacks", async () => {
  await scenario(
    async (h) => {
      h.move(6, VIEW);
      await h.settle();
      const rows = referenceRows(h.pipeline.fields.price, h.spaces[0], PRICE);
      const drawn = assertCombined(h, reference(h), "missing: 0");
      assert.equal(drawn, rows.filter((row) => row?.den > 0).length);
    },
    { missing: 0 },
  );
});

test("one submit per frame: both packs, then the combine; a field or the expression changes without a repack", async () => {
  await scenario(async (h) => {
    h.move(6, VIEW);
    await h.settle();
    const { device } = h;
    const { price, canopy } = h.pipeline.fields;

    // Everything in one turn: one submit, packs before the combine.
    let from = device.log.length;
    let submits = count(device, "submit");
    price.controller.setHeat(HEAT);
    canopy.controller.setHeat(COUNT_PRICE);
    h.pipeline.setExpression("price + canopy / 1000");
    assert.equal(count(device, "submit"), submits, "nothing is submitted before the turn ends");
    await null;
    assert.equal(count(device, "submit"), submits + 1);
    const stages = dispatches(device, from).filter((stage) => stage !== "reduceParents");
    assert.deepEqual(stages, [
      "writeOutputs",
      "indexField",
      "writeOutputs",
      "indexField",
      "combine",
    ]);
    assertCombined(
      h,
      reference(h, "price + canopy / 1000", [HEAT, COUNT_PRICE]),
      "new rules and expression",
    );

    // A new expression: the combine alone, on the fields as they are.
    from = device.log.length;
    submits = count(device, "submit");
    const version = h.pipeline.controller.getPackedData().version;
    h.pipeline.setExpression("max(price, canopy)");
    await null;
    assert.deepEqual(dispatches(device, from), ["combine"]);
    assert.equal(count(device, "submit"), submits + 1);
    assert.ok(h.pipeline.controller.getPackedData().version > version, "the layer repaints");
    assertCombined(h, reference(h, "max(price, canopy)", [HEAT, COUNT_PRICE]), "max");

    // The other field changes: its pack, and the first field's combine only.
    from = device.log.length;
    canopy.controller.setHeat(SURFACE);
    await null;
    assert.deepEqual(
      dispatches(device, from).filter((stage) => stage !== "reduceParents"),
      ["writeOutputs", "indexField", "combine"],
    );
    assertCombined(h, reference(h, "max(price, canopy)", [HEAT, SURFACE]), "canopy changed");
    assert.throws(() => h.pipeline.setExpression("price * shade"), /"shade" is not a field/);
    assert.equal(count(device, "map"), 0);
  });
});

test("zooming fades combined values into combined values", async () => {
  await scenario(async (h) => {
    h.move(5, VIEW);
    await h.settle();
    const { price } = h.pipeline.fields;
    const before = readInstances(h.pipeline.controller.getPackedData());
    const previousCapacity = price.state.plan.capacity;
    assertCombined(h, reference(h), "zoom 5");

    h.move(6, VIEW);
    await h.until(() => price.state.fade.active);
    // Let the other field reach the same zoom while the first one fades.
    await h.settle({ fades: false });
    assert.equal(price.state.fade.active, true);
    assert.equal(price.state.steady, false);
    const packed = h.pipeline.controller.getPackedData();
    const capacity = price.state.plan.capacity;
    assert.equal(packed.count, capacity + previousCapacity);
    const pair = readInstances(packed);
    // Current half: the new cells, combined. Previous half: what was on screen.
    assertCombined(h, reference(h), "zoom 6, fading");
    let faded = 0;
    for (let i = 0; i < previousCapacity; i++) {
      const o = (capacity + i) * FLOATS_PER_INSTANCE;
      const was = before.subarray(i * FLOATS_PER_INSTANCE + 8, i * FLOATS_PER_INSTANCE + 10);
      assert.deepEqual(pair.subarray(o + 12, o + 14), was, `previous output ${i}`);
      faded += was[1] > 0 ? 1 : 0;
    }
    assert.ok(faded > 10);

    await h.settle();
    assert.equal(price.state.steady, true);
    assert.equal(h.pipeline.controller.getPackedData().count, capacity);
    assertCombined(h, reference(h), "zoom 6");
    assert.equal(count(h.device, "map"), 0);
  });
});

test("after a device loss the fields are rebuilt and combined on the new device", async () => {
  await scenario(async (h) => {
    h.move(6, VIEW);
    await h.settle();
    const expected = reference(h);
    h.pipeline.deviceLost();
    assert.equal(h.pipeline.controller.getPackedData().count, 0);
    assert.equal(h.pipeline.fields.canopy.field.buffer, null);

    // One field back before the other: it is missing until it is on the same device.
    const next = packDevice();
    await h.pipeline.fields.price.restore(next);
    await null;
    assert.ok(dispatches(next, 0).includes("combine"));
    assert.equal(
      assertCombined(
        h,
        reference(h).map((value) => value && [0, 0]),
        "alone",
      ),
      0,
    );

    await h.pipeline.restore(next);
    await null;
    assert.ok(assertCombined(h, expected, "restored") > 20);
    assert.equal(count(next, "map"), 0);
  });
});

test("one field and no expression is the plain pipeline: no field, no combine", async () => {
  await withGPUGlobals(async () => {
    const points = randomPoints(spaceOf(DEFINITION), { seed: 7, count: 600 });
    const nodes = [await startNode(points), await startNode(points)];
    const plain = await connect(nodes[0], { heat: HEAT });
    const one = await connectFields([
      { name: "price", node: nodes[1], collection: DEFINITION, rules: HEAT },
    ]);
    try {
      for (const h of [plain, one]) {
        h.move(6, VIEW);
        await h.settle();
      }
      assert.deepEqual(
        readInstances(one.pipeline.controller.getPackedData()),
        readInstances(plain.pipeline.controller.getPackedData()),
      );
      for (const stage of dispatches(one.device, 0)) {
        assert.ok(stage !== "combine" && stage !== "indexField", stage);
      }
      assert.equal(one.pipeline.field.buffer, null);
      assert.deepEqual(Object.keys(one.pipeline.fields), ["price"]);
    } finally {
      plain.close();
      one.close();
      for (const node of nodes) await node.stop();
    }
  });
});

test("compose refuses fields it cannot join", () => {
  const field = (name, collection = DEFINITION) => ({ name, collection, rules: HEAT });
  const device = packDevice();
  assert.throws(() => compose({ fields: [], device }), /1 to 4 fields/);
  assert.throws(
    () => compose({ fields: ["a", "b", "c", "d", "e"].map((name) => field(name)), device }),
    /1 to 4 fields/,
  );
  assert.throws(() => compose({ fields: [field("a"), field("a")], device }), /distinct words/);
  assert.throws(() => compose({ fields: [field("1 + 1")], device }), /distinct words/);
  const linear = { name: "timeline", dimensions: [{ name: "t", type: "linear", args: [0, 1] }] };
  assert.throws(
    () => compose({ fields: [field("a"), field("b", linear)], device }),
    /share their dimensions/,
  );
});
