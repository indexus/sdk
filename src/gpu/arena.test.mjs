import { test } from "node:test";
import assert from "node:assert/strict";
import { createArena, BLOCK_TABLE_BYTES } from "./arena.js";
import { fakeDevice, withGPUGlobals, USAGE } from "./device.testkit.mjs";
import { seededRandom, sortedRandomBlock } from "./cells.testkit.mjs";

function words(buffer, offset, length) {
  return new Uint32Array(buffer.bytes, offset * 4, length);
}

function tableRow(arena, handle) {
  const bytes = arena.table.bytes;
  return {
    u32: Array.from(new Uint32Array(bytes, handle * BLOCK_TABLE_BYTES, 8)),
    origin: Array.from(new Float32Array(bytes, handle * BLOCK_TABLE_BYTES + 32, 4)),
  };
}

// Every live block reads back, through the table, exactly as it was put.
function assertResident(arena, expected) {
  for (const [handle, { rows, origin }] of expected) {
    const { u32, origin: stored } = tableRow(arena, handle);
    const [keysOff, countOff, metricsOff, n, keyWords, suffixChars, metricCount, depth] = u32;
    assert.deepEqual(
      [n, keyWords, suffixChars, metricCount, depth],
      [rows.n, rows.keyWords, rows.suffixChars, rows.metricCount, rows.parent.length],
    );
    assert.deepEqual(stored, Array.from(Float32Array.from(origin)));
    assert.deepEqual(words(arena.buffers.keys, keysOff, n * keyWords), rows.keys);
    assert.deepEqual(words(arena.buffers.count, countOff, n), rows.count);
    assert.deepEqual(
      new Float32Array(arena.buffers.metrics.bytes, metricsOff * 4, n * metricCount),
      rows.metrics,
    );
  }
}

function blocks(seed, count, rowsPerBlock) {
  const random = seededRandom(seed);
  return Array.from({ length: count }, (_, i) => ({
    handle: i,
    rows: sortedRandomBlock(random, "Ab".slice(0, i % 3), rowsPerBlock, 2 + (i % 5), i % 3),
    origin: [-90 + i, -80 + i, -180 + i / 3, -170 + i / 3],
  }));
}

test("arena buffers are STORAGE, copyable, and a put is one writeBuffer per column plus its table row", async () => {
  await withGPUGlobals(async () => {
    const device = fakeDevice();
    const arena = createArena(device);
    for (const buffer of [
      arena.buffers.keys,
      arena.buffers.count,
      arena.buffers.metrics,
      arena.table,
    ]) {
      assert.equal(buffer.usage, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
    }
    const [{ rows, origin }] = blocks(1, 1, 300);
    device.log.length = 0;
    arena.put(7, rows, origin);
    const writes = device.log.filter((event) => event[0] === "write").map((event) => event[1]);
    assert.deepEqual(
      writes,
      ["arena-keys", "arena-count", "arena-table"],
      "no metric column, no metric write",
    );
    assert.equal(device.log.filter((event) => event[0] === "map").length, 0);
    assert.ok(arena.has(7));
    assertResident(arena, new Map([[7, { rows, origin }]]));
    assert.equal(arena.bytes, (rows.n * rows.keyWords + rows.n) * 4);
  });
});

test("arena grows by copying live blocks GPU to GPU, never through the CPU", async () => {
  await withGPUGlobals(async () => {
    const device = fakeDevice();
    const arena = createArena(device);
    const all = blocks(2, 40, 2000);
    const expected = new Map();
    const generation = arena.generation;
    for (const block of all) {
      const before = device.log.length;
      arena.put(block.handle, block.rows, block.origin);
      expected.set(block.handle, block);
      const events = device.log.slice(before);
      // Data reaches the GPU once: the writes of a put are its own columns.
      const written = events.filter((event) => event[0] === "write" && event[1] !== "arena-table");
      const bytes = written.reduce((total, event) => total + event[3], 0);
      const rows = block.rows;
      assert.equal(bytes, (rows.n * rows.keyWords + rows.n + rows.n * rows.metricCount) * 4);
    }
    assert.ok(arena.generation > generation, "buffers were replaced");
    assert.ok(device.log.some((event) => event[0] === "copy" && event[1] === "arena-keys"));
    assert.ok(
      device.buffers.filter((buffer) => buffer.label === "arena-keys" && buffer.destroyed).length >
        0,
    );
    assertResident(arena, expected);
  });
});

test("arena compacts when holes pass the threshold, at the same size", async () => {
  await withGPUGlobals(async () => {
    const device = fakeDevice();
    const arena = createArena(device);
    const all = blocks(3, 30, 1500);
    for (const block of all) {
      arena.put(block.handle, block.rows, block.origin);
    }
    const capacity = arena.capacityBytes;
    const expected = new Map();
    for (const block of all) {
      if (block.handle % 3 === 0) {
        expected.set(block.handle, block);
      } else {
        assert.equal(arena.drop(block.handle), true);
      }
    }
    assert.equal(arena.drop(1), false, "a second drop is a no-op");
    assert.deepEqual(tableRow(arena, 1).u32, [0, 0, 0, 0, 0, 0, 0, 0]);
    // Refill: the holes are reused by compaction before any growth.
    const random = seededRandom(4);
    const moves = device.log.length;
    for (let handle = 100; handle < 110; handle++) {
      const rows = sortedRandomBlock(random, "Z", 1500, 3, 2);
      const block = { handle, rows, origin: [0, 1, 2, 3] };
      arena.put(handle, rows, block.origin);
      expected.set(handle, block);
    }
    assert.equal(arena.capacityBytes, capacity, "compaction kept the size");
    assert.ok(
      device.log.slice(moves).some((event) => event[0] === "copy"),
      "live blocks were moved",
    );
    assertResident(arena, expected);
    // Replacing a handle frees its old ranges.
    const again = expected.get(100);
    const bytes = arena.bytes;
    arena.put(100, again.rows, again.origin);
    assert.equal(arena.bytes, bytes);
    assertResident(arena, expected);
  });
});

test("arena table grows past its first handles and refuses non-u32 handles", async () => {
  await withGPUGlobals(async () => {
    const device = fakeDevice();
    const arena = createArena(device);
    const [a, b] = blocks(5, 2, 100);
    arena.put(3, a.rows, a.origin);
    const table = arena.table;
    arena.put(5000, b.rows, b.origin);
    assert.notEqual(arena.table, table);
    assert.ok(table.destroyed);
    assert.ok(arena.table.size >= 5001 * BLOCK_TABLE_BYTES);
    assert.ok(device.log.some((event) => event[0] === "copy" && event[1] === "arena-table"));
    assertResident(
      arena,
      new Map([
        [3, a],
        [5000, b],
      ]),
    );
    for (const handle of [-1, 1.5, 2 ** 32]) {
      assert.throws(() => arena.put(handle, a.rows, a.origin), RangeError);
    }
    assert.throws(() => arena.put(9, { ...a.rows, keyWords: 3 }, a.origin), RangeError);
  });
});

test("arena refuses a block beyond its budget", async () => {
  await withGPUGlobals(async () => {
    const arena = createArena(fakeDevice(), { budgetBytes: 1 << 20 });
    const random = seededRandom(6);
    const rows = sortedRandomBlock(random, "", 200000, 4, 1);
    assert.throws(() => arena.put(0, rows, [0, 1, 0, 1]), /budget/);
  });
});

test("arena rebuild rewrites every block from the store on a new device", async () => {
  await withGPUGlobals(async () => {
    const first = fakeDevice();
    const arena = createArena(first);
    const all = blocks(7, 12, 800);
    const store = new Map();
    for (const block of all) {
      arena.put(block.handle, block.rows, block.origin);
      store.set(block.handle, block.rows);
    }
    store.delete(4);
    const second = fakeDevice();
    const result = arena.rebuild({ get: (handle) => store.get(handle) }, second);
    assert.deepEqual(result.missing, [4]);
    assert.deepEqual(
      result.rebuilt,
      all.map((block) => block.handle).filter((handle) => handle !== 4),
    );
    assert.equal(arena.device, second);
    assert.ok(first.buffers.every((buffer) => buffer.destroyed));
    assert.equal(arena.has(4), false);
    assert.equal(
      second.log.filter((event) => event[0] === "copy").length,
      0,
      "sized from the store, nothing moves",
    );
    assertResident(
      arena,
      new Map(all.filter((block) => block.handle !== 4).map((block) => [block.handle, block])),
    );
  });
});

test("arena rounds 8-byte metrics to f32 on put", async () => {
  await withGPUGlobals(async () => {
    const arena = createArena(fakeDevice());
    const [{ rows, origin }] = blocks(8, 1, 200).map((block) => ({
      ...block,
      rows: sortedRandomBlock(seededRandom(8), "", 200, 2, 3),
    }));
    const wide = {
      ...rows,
      metricBytes: 8,
      metrics: Float64Array.from(rows.metrics, (value) => value + 1e-9),
    };
    arena.put(2, wide, origin);
    assertResident(
      arena,
      new Map([[2, { rows: { ...rows, metrics: Float32Array.from(wide.metrics) }, origin }]]),
    );
    assert.equal(arena.buffers.metrics.bytes.byteLength >= rows.n * 3 * 4, true);
  });
});
