// A weather variable as a collection: one metric per hour (value × area) and
// the area. The hour is a column of the heat rule, a shift turns kelvin into
// the drawn unit, two hours blend on the GPU, and the sums of a zone are those
// of the former pyramid (testdata/arome-temperature.json: AROME records of six
// zones and the pyramid's rows there).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withGPUGlobals } from "../../gpu/device.testkit.mjs";
import { packEntriesF32 } from "../../gpu/pack.testkit.mjs";
import { spaceTables, parentBounds } from "../../gpu/cells.js";
import { planToInstancesCPU } from "../../walk/pack.testkit.mjs";
import { FLOATS_PER_INSTANCE } from "../../walk/index.js";
import { connect, definitionOf, readInstances, spaceOf, startNode } from "./heat.testkit.mjs";

const DATA = JSON.parse(
  readFileSync(new URL("./testdata/arome-temperature.json", import.meta.url)),
);
const DEFINITION = definitionOf(DATA.collection);
const KELVIN = 273.15;
const BOUNDS = {
  mode: "bounds",
  latIndex: 0,
  lngIndex: 0,
  metricScale: 1,
  latOffset: 0,
  lngOffset: 0,
};
/** Hour `k` of the testdata (column 1 + k) in °C. */
const hourRule = (k) => [{ num: 1 + k, den: 0, minDen: 0, transform: 0, shift: KELVIN }];
/** walk depth = floor(zoom + resolution 5) bits per axis: zoom 5 reads the pyramid's depth 10. */
const zoomOf = (depth) => depth - 5;

function cellBounds({ depth, x, y }) {
  const lat = 180 / 2 ** depth;
  const lng = 360 / 2 ** depth;
  return [-90 + x * lat, -90 + (x + 1) * lat, -180 + y * lng, -180 + (y + 1) * lng];
}

const VIEW = (() => {
  const cells = DATA.pyramid.map(cellBounds);
  return [
    Math.min(...cells.map((c) => c[0])),
    Math.max(...cells.map((c) => c[1])),
    Math.min(...cells.map((c) => c[2])),
    Math.max(...cells.map((c) => c[3])),
  ];
})();

async function weather(body, heat = hourRule(0), previousHeat = null, options = {}) {
  await withGPUGlobals(async () => {
    const node = await startNode(
      DATA.records.map(({ location, metrics }) => ({ location, metrics })),
    );
    const h = await connect(node, {
      collection: DEFINITION,
      heat,
      previousHeat,
      position: BOUNDS,
      ...options,
    });
    try {
      await body(h);
    } finally {
      h.close();
      await node.stop();
    }
  });
}

function emulated(h, heat) {
  const { store, plan } = h.pipeline.state;
  const space = spaceOf(DEFINITION);
  const get = (handle) => {
    const rows = store.get(handle);
    return { rows, origin: parentBounds(space, rows.parent) };
  };
  return packEntriesF32({
    blocks: { get },
    tables: spaceTables(space),
    plan,
    heat,
    position: BOUNDS,
  }).data;
}

test("weather: the sums of a zone are the former pyramid's, every sampled row and hour", async () => {
  await weather(async (h) => {
    let compared = 0;
    for (const depth of [10, 13]) {
      h.move(zoomOf(depth), VIEW);
      await h.settle();
      for (const row of DATA.pyramid.filter((r) => r.depth === depth)) {
        const [south, north, west, east] = cellBounds(row);
        const bounds = [{ dimension: 0, segment: [south, north, west, east] }];
        const { totalCount, metricSums } = await h.pipeline.stats({ zoom: zoomOf(depth), bounds });
        const area = metricSums[0];
        const celsius = metricSums[1 + DATA.hours.indexOf(row.hour)] / area - KELVIN;
        assert.ok(totalCount > 0, `${depth}/${row.x}/${row.y}: records`);
        // the records keep 2 decimals of K·km² and 4 of km²: 2e-3 °C, 1e-5 of the area
        assert.ok(
          Math.abs(celsius - row.celsius) < 2e-3,
          `${depth}/${row.x}/${row.y}: ${celsius} °C`,
        );
        assert.ok(Math.abs(area - row.areaKm2) / row.areaKm2 < 1e-5, `area ${area}`);
        compared++;
      }
    }
    assert.equal(compared, DATA.pyramid.length);
  });
});

test("weather: the hour is a column, the shift draws °C, on the kernel as on the CPU", async () => {
  for (const k of [0, 1, 2]) {
    await weather(async (h) => {
      h.move(zoomOf(10), VIEW);
      await h.settle();
      const { packed, plan, store } = h.pipeline.state;
      assert.ok(plan.capacity > 0);
      const gpu = readInstances(packed);
      assert.deepEqual(
        gpu,
        emulated(h, hourRule(k)),
        `hour ${DATA.hours[k]}: the kernel emulation`,
      );
      const space = spaceOf(DEFINITION);
      const cpu = planToInstancesCPU(plan, store, hourRule(k), { space, ...BOUNDS }).data;
      let drawn = 0;
      for (let i = 0; i < gpu.length; i += FLOATS_PER_INSTANCE) {
        const [num, den] = [gpu[i + 8], gpu[i + 9]];
        if (!(den > 0)) continue;
        drawn++;
        assert.ok(Math.abs(num / den - cpu[i + 8] / cpu[i + 9]) < 1e-3, "kernel and CPU");
        const celsius = num / den;
        assert.ok(celsius > -30 && celsius < 30, `a mean in °C: ${celsius}`);
      }
      assert.ok(drawn > 0);
    }, hourRule(k));
  }
});

test("weather: two hours of the same cells are packed together and blend in the renderer", async () => {
  await weather(
    async (h) => {
      h.move(zoomOf(10), VIEW);
      await h.settle();
      const { packed, plan } = h.pipeline.state;
      const n = plan.capacity;
      assert.equal(packed.count, 2 * n, "the hour and the hour before, one buffer");
      const both = readInstances(packed);
      const current = both.subarray(0, n * FLOATS_PER_INSTANCE);
      const previous = both.subarray(n * FLOATS_PER_INSTANCE);
      // a transition's layout (gpu/pack.js): the current half holds the hour in
      // [8..9], the previous half the hour before in [12..13], at the same cells
      const t1 = emulated(h, hourRule(1));
      const t0 = emulated(h, hourRule(0));
      let differ = 0;
      for (let i = 0; i < current.length; i += FLOATS_PER_INSTANCE) {
        for (let f = 0; f < 4; f++) assert.equal(previous[i + f], current[i + f], "same place");
        assert.deepEqual([current[i + 8], current[i + 9]], [t1[i + 8], t1[i + 9]], "current hour");
        assert.deepEqual([current[i + 12], current[i + 13]], [0, 0]);
        assert.deepEqual(
          [previous[i + 12], previous[i + 13]],
          [t0[i + 8], t0[i + 9]],
          "hour before",
        );
        assert.deepEqual([previous[i + 8], previous[i + 9]], [0, 0]);
        if (t0[i + 8] !== t1[i + 8]) differ++;
      }
      assert.ok(differ > 0, "the two hours differ");
      h.pipeline.controller.setBlend(0.25);
      assert.equal(h.pipeline.controller.getTransitionFactor(), 0.25, "the blend is the factor");
      h.pipeline.controller.setBlend(1);
      assert.equal(h.pipeline.controller.getTransitionFactor(), 1);
    },
    hourRule(1),
    hourRule(0),
  );
});

test("weather: two hours shown at rest ask for no frame (the map stays idle)", async () => {
  const frames = [];
  await weather(
    async (h) => {
      h.move(zoomOf(10), VIEW);
      await h.settle();
      h.pipeline.controller.setBlend(0.4);
      // run the frames asked until none is: a transition or a fade ends, a pair at rest never asks
      for (let k = 0; k < 200 && frames.length; k++) {
        h.clock.t += 1000;
        frames.shift()();
      }
      assert.equal(frames.length, 0, "no frame loop once the pair is on screen");
      assert.equal(h.pipeline.controller.getTransitionFactor(), 0.4, "the blend still drives the renderer");
    },
    hourRule(1),
    hourRule(0),
    { requestFrame: (callback) => frames.push(callback) },
  );
});

test("weather: the map reads only the columns of its hours; a swap re-reads the zones held", async () => {
  const full = {};
  await weather(async (h) => {
    h.move(zoomOf(10), VIEW);
    await h.settle();
    full.h13 = readInstances(h.pipeline.state.packed);
  }, hourRule(1));
  await weather(async (h) => {
    // area, hour 0, hour 13: hour 13 is position 2
    h.pipeline.controller.setColumns([0, 1, 2]);
    h.move(zoomOf(10), VIEW);
    await h.settle();
    assert.ok(h.node.columnsAsked.length > 0);
    assert.ok(
      h.node.columnsAsked.every((c) => String(c) === "0,1,2"),
      "only the selected columns",
    );
    const { packed, store, plan } = h.pipeline.state;
    assert.equal(store.get(plan.entries[0]).metricCount, 3, "blocks hold three metrics");
    assert.deepEqual(readInstances(packed), full.h13, "the same cells and values as all columns");
    // the next hours: hour 71 alone, the zones held are read again before a plan
    const asked = h.node.columnsAsked.length;
    h.pipeline.controller.setColumns([0, 3]);
    h.pipeline.controller.setHeat(hourRule(0));
    await h.settle();
    assert.ok(h.node.columnsAsked.slice(asked).every((c) => String(c) === "0,3"));
    const { store: after, plan: next } = h.pipeline.state;
    assert.equal(after.get(next.entries[0]).metricCount, 2);
    const gpu = readInstances(h.pipeline.state.packed);
    let drawn = 0;
    for (let i = 0; i < gpu.length; i += FLOATS_PER_INSTANCE) {
      if (!(gpu[i + 9] > 0)) continue;
      drawn++;
      const celsius = gpu[i + 8] / gpu[i + 9];
      assert.ok(celsius > -30 && celsius < 30, `hour 71 in °C: ${celsius}`);
    }
    assert.ok(drawn > 0);
  }, hourRule(1));
});

test("weather: a coarse read of a region gives every hour of the pyramid's rows", async () => {
  await weather(async (h) => {
    h.move(zoomOf(10), VIEW);
    await h.settle();
    for (const row of DATA.pyramid.filter((r) => r.depth === 10)) {
      const [south, north, west, east] = cellBounds(row);
      const bounds = [{ dimension: 0, segment: [south, north, west, east] }];
      const { metricSums } = await h.pipeline.sums({ bounds, columns: [0, 1, 2, 3] });
      const area = metricSums[0];
      const celsius = metricSums[1 + DATA.hours.indexOf(row.hour)] / area - KELVIN;
      assert.ok(Math.abs(celsius - row.celsius) < 2e-3, `${row.x}/${row.y}: ${celsius}`);
      assert.ok(Math.abs(area - row.areaKm2) / row.areaKm2 < 1e-5);
    }
  });
});

test("weather: rules handed with their columns apply with the first plan of the new blocks", async () => {
  const full = {};
  await weather(async (h) => {
    h.move(zoomOf(10), VIEW);
    await h.settle();
    full.h1 = readInstances(h.pipeline.state.packed);
  }, hourRule(1));
  await weather(
    async (h) => {
      h.pipeline.controller.setColumns([0, 1]);
      h.move(zoomOf(10), VIEW);
      await h.settle({ fades: false });
      assert.equal(h.pipeline.controller.rulesPending(), false, "no rules were handed");
      const before = readInstances(h.pipeline.state.packed);
      // hour 1 is column 2: its rule names position 1 of the new list
      h.pipeline.controller.setColumns([0, 2], { heat: hourRule(0) });
      assert.equal(h.pipeline.controller.rulesPending(), true);
      // nothing repacks with the new rules before the new blocks: what is drawn is unchanged
      assert.deepEqual(readInstances(h.pipeline.state.packed), before);
      await h.settle({ fades: false });
      assert.equal(h.pipeline.controller.rulesPending(), false);
      assert.deepEqual(
        readInstances(h.pipeline.state.packed),
        full.h1,
        "hour 1 from its own column",
      );
      assert.equal(
        h.pipeline.state.fade.active,
        false,
        "no cross-fade: the plan replaced the one on screen",
      );
    },
    hourRule(0),
    null,
    { fades: false, init: { completePlans: true } },
  );
});
