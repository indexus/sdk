import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { once } from "node:events";
import v8 from "node:v8";
import vm from "node:vm";

import { createBlockStore, adoptBlocks, sectionsOf } from "./index.js";
import { decodeBlocks, suffixAt } from "../wire/block.js";
import { encodeBlocks, wideBlock } from "./testkit.mjs";

/** A response of `zones.length` sections of `rows` rows, decoded. */
function response(zones, rows = 1000) {
  const buffer = encodeBlocks(zones.map((zone) => wideBlock(zone, rows)));
  return { buffer, blocks: decodeBlocks(buffer).blocks };
}

/** Puts every section of a response; returns the bytes it weighs. */
function putAll(store, firstHandle, { buffer, blocks }) {
  blocks.forEach((block, i) => store.put(firstHandle + i, block.parent, block));
  return buffer.byteLength;
}

test("the test encoder writes the golden files byte for byte", () => {
  for (const name of ["basic", "basic-f64", "edges", "align-f64"]) {
    const golden = JSON.parse(
      readFileSync(new URL(`../wire/testdata/${name}.json`, import.meta.url), "utf8"),
    );
    const body = encodeBlocks(golden.sections, {
      f64: golden.sections[0].metricBytes === 8,
      redirects: golden.redirects ?? [],
    });
    const expected = readFileSync(new URL(`../wire/testdata/${name}.bin`, import.meta.url));
    assert.ok(Buffer.from(body).equals(expected), name);
  }
});

test("put keeps the block as it arrived: same views, no copy", () => {
  const store = createBlockStore();
  const { buffer, blocks } = response(["7a"]);
  store.put(1, "7a", blocks[0]);

  assert.equal(store.has(1), true);
  assert.equal(store.has(2), false);
  assert.equal(store.get(2), undefined);
  assert.equal(store.get(1), blocks[0]);
  assert.equal(store.get(1).keys.buffer, buffer);
  assert.equal(store.bytes, buffer.byteLength);
});

test("the budget is in bytes and the least recently used buffer leaves first", () => {
  const a = response(["a"]);
  const b = response(["b"]);
  const c = response(["c"]);
  const size = a.buffer.byteLength;
  const store = createBlockStore({ budgetBytes: 2 * size });

  putAll(store, 1, a);
  putAll(store, 2, b);
  assert.deepEqual(store.evict(), [], "at the budget, nothing leaves");

  putAll(store, 3, c);
  assert.equal(store.bytes, 3 * size);
  assert.deepEqual(store.evict(), [1]);
  assert.equal(store.bytes, 2 * size);
  assert.equal(store.has(1), false);

  // Reading a block makes it the most recent one.
  store.get(2);
  putAll(store, 4, response(["d"]));
  assert.deepEqual(store.evict(), [3]);
  assert.deepEqual([store.has(2), store.has(3), store.has(4)], [true, false, true]);
});

test("evict takes as many buffers as the budget needs, oldest first", () => {
  const size = response(["a"]).buffer.byteLength;
  const store = createBlockStore({ budgetBytes: size });
  for (let handle = 1; handle <= 4; handle++) putAll(store, handle, response([`z${handle}`]));
  assert.deepEqual(store.evict(), [1, 2, 3]);
  assert.equal(store.bytes, size);
});

test("a pinned handle is never evicted, even over budget", () => {
  const size = response(["a"]).buffer.byteLength;
  const store = createBlockStore({ budgetBytes: size });
  for (let handle = 1; handle <= 3; handle++) putAll(store, handle, response([`z${handle}`]));

  store.pin([1, 2]);
  assert.deepEqual(store.evict(), [3]);
  assert.deepEqual(store.evict(), [], "only pinned blocks are left");
  assert.equal(store.bytes, 2 * size, "pins can hold the store above its budget");

  // The next plan replaces the pins.
  store.pin(new Uint32Array([2]));
  assert.deepEqual(store.evict(), [1]);
  assert.equal(store.has(2), true);
});

test("a buffer shared by several handles is counted once and leaves as a whole", () => {
  const shared = response(["a", "b", "c"]);
  const alone = response(["d"]);
  const store = createBlockStore({ budgetBytes: shared.buffer.byteLength });

  putAll(store, 10, shared);
  assert.equal(store.bytes, shared.buffer.byteLength);

  // Dropping some of its handles frees nothing: the buffer is still held.
  store.drop([10, 11]);
  assert.equal(store.bytes, shared.buffer.byteLength);
  assert.equal(store.has(12), true);
  store.drop([12]);
  assert.equal(store.bytes, 0);

  putAll(store, 10, shared);
  putAll(store, 20, alone);
  // One pinned handle keeps the whole buffer, so its other handles stay too:
  // evicting them would free nothing.
  store.pin([11]);
  assert.deepEqual(store.evict(), [20]);
  assert.deepEqual([store.has(10), store.has(11), store.has(12)], [true, true, true]);

  putAll(store, 20, alone);
  store.pin([20]);
  assert.deepEqual(store.evict(), [10, 11, 12]);
  assert.equal(store.bytes, alone.buffer.byteLength);
});

test("reading one handle of a shared buffer refreshes the buffer", () => {
  const shared = response(["a", "b"]);
  const later = response(["c"]);
  const store = createBlockStore({ budgetBytes: shared.buffer.byteLength });
  putAll(store, 1, shared);
  putAll(store, 3, later);
  store.get(2);
  assert.deepEqual(store.evict(), [3]);
});

test("putting a handle again replaces its block", () => {
  const first = response(["a"]);
  const second = response(["a"], 10);
  const store = createBlockStore();
  store.put(1, "a", first.blocks[0]);
  store.put(1, "a", second.blocks[0]);
  assert.equal(store.get(1), second.blocks[0]);
  assert.equal(store.bytes, second.buffer.byteLength);
});

test("entries lists every block with its zone; clear empties the store", () => {
  const store = createBlockStore({ budgetBytes: 1 });
  const { blocks } = response(["a", "b"]);
  store.put(1, "a", blocks[0]);
  store.put(2, "b", blocks[1]);
  store.pin([1]);
  assert.deepEqual(
    [...store.entries()].map(({ handle, zone, block }) => [handle, zone, block.n]),
    [
      [1, "a", 1000],
      [2, "b", 1000],
    ],
  );

  store.clear();
  assert.equal(store.bytes, 0);
  assert.equal(store.has(1), false);
  assert.deepEqual([...store.entries()], []);
  assert.deepEqual(store.evict(), []);

  // Pins do not survive a clear.
  store.put(1, "a", blocks[0]);
  store.put(2, "b", blocks[1]);
  assert.deepEqual(store.evict(), [1, 2]);
});

test("sectionsOf names each rows section by its offset in the body", () => {
  // A file read may be a slice of a pooled buffer: take the body alone.
  const body = new Uint8Array(
    readFileSync(new URL("../wire/testdata/basic.bin", import.meta.url)),
  ).slice().buffer;
  const { blocks } = decodeBlocks(body);

  let next = 100;
  const seen = [];
  const sections = sectionsOf(body, blocks, (zone, block) => {
    seen.push([zone, block.suffixChars]);
    return next++;
  });

  assert.deepEqual(seen, [
    ["@", 1],
    ["@", 2],
    ["7", 1],
    ["7", 4],
  ]);
  assert.deepEqual(
    sections.map(({ handle, zone }) => [handle, zone]),
    [
      [100, "@"],
      [101, "@"],
      [102, "7"],
      [103, "7"],
    ],
  );
  // Sections follow the 16-byte header and each other; the redirects section closes the body.
  assert.equal(sections[0].offset, 16);
  for (let i = 1; i < sections.length; i++) {
    assert.equal(sections[i].offset, sections[i - 1].offset + sections[i - 1].byteLength);
  }
  const last = sections.at(-1);
  assert.ok(last.offset + last.byteLength < body.byteLength);

  const other = encodeBlocks([wideBlock("a", 4)]);
  assert.throws(() => sectionsOf(other, blocks, () => 0), /does not belong/);
});

test("BLOCKS crosses a MessageChannel: the sender loses the buffer, the store reads the same values", async () => {
  const buffer = encodeBlocks(
    [wideBlock("7a", 500, 3), wideBlock("7b", 200, 1), wideBlock("", 64, 2)],
    {
      redirects: [{ location: "c", name: "peerC", ip: "10.0.0.3", port: 21000 }],
    },
  );
  const { blocks } = decodeBlocks(buffer);
  // What the worker read before the transfer, copied out of the buffer.
  const expected = blocks.map((block) => ({
    parent: block.parent,
    n: block.n,
    suffixChars: block.suffixChars,
    metricCount: block.metricCount,
    first: suffixAt(block, 0),
    last: suffixAt(block, block.n - 1),
    keys: Array.from(block.keys),
    count: Array.from(block.count),
    metrics: Array.from(block.metrics),
  }));
  let next = 1;
  const sections = sectionsOf(buffer, blocks, () => next++);
  const byteLength = buffer.byteLength;

  const { port1, port2 } = new MessageChannel();
  try {
    const received = once(port2, "message");
    port1.postMessage({ type: "BLOCKS", buffer, sections }, [buffer]);
    assert.equal(buffer.byteLength, 0, "the buffer left the sender");
    assert.equal(blocks[0].keys.length, 0, "and its views with it");

    const [message] = await received;
    assert.equal(message.buffer.byteLength, byteLength);

    const store = createBlockStore();
    adoptBlocks(store, message);
    assert.equal(store.bytes, byteLength);
    assert.deepEqual(
      [...store.entries()].map(({ handle, zone }) => [handle, zone]),
      [
        [1, "7a"],
        [2, "7b"],
        [3, "@"],
      ],
    );
    for (let i = 0; i < expected.length; i++) {
      const block = store.get(i + 1);
      const want = expected[i];
      assert.equal(block.keys.buffer, message.buffer, "views on the received buffer");
      assert.equal(block.parent, want.parent);
      assert.equal(block.n, want.n);
      assert.equal(block.suffixChars, want.suffixChars);
      assert.equal(block.metricCount, want.metricCount);
      assert.equal(suffixAt(block, 0), want.first);
      assert.equal(suffixAt(block, block.n - 1), want.last);
      assert.deepEqual(Array.from(block.keys), want.keys);
      assert.deepEqual(Array.from(block.count), want.count);
      assert.deepEqual(Array.from(block.metrics), want.metrics);
    }
  } finally {
    port1.close();
    port2.close();
  }
});

test("adoptBlocks refuses a section that is not in the body", () => {
  const buffer = encodeBlocks([wideBlock("a", 4)]);
  const store = createBlockStore();
  assert.throws(
    () =>
      adoptBlocks(store, {
        buffer,
        sections: [{ handle: 1, zone: "a", offset: 20, byteLength: 8 }],
      }),
    /no rows section at offset 20/,
  );
});

test("100 000 rows through the store allocate no object per row", () => {
  // `npm test` runs without --expose-gc; the flag can still be set from here.
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  const settledHeap = () => {
    // Twice: the first pass can leave what finalizers release.
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  const rows = 100_000;
  const perBuffer = 25_000;
  // Built in its own frame, so the rows the encoder was given are garbage
  // before the first measure.
  const buffers = (() => {
    const bodies = [];
    for (let i = 0; i < rows / perBuffer; i++)
      bodies.push(encodeBlocks([wideBlock(`z${i}`, perBuffer)]));
    return bodies;
  })();
  const store = createBlockStore({ budgetBytes: 2 * buffers[0].byteLength });

  const before = settledHeap();
  let handle = 0;
  let total = 0;
  for (const buffer of buffers) {
    const { blocks } = decodeBlocks(buffer);
    const sections = sectionsOf(buffer, blocks, () => ++handle);
    adoptBlocks(store, { buffer, sections });
    total += store.get(handle).n;
  }
  store.pin([handle]);
  const evicted = store.evict();
  const grown = settledHeap() - before;

  // The same measure sees the smallest per-row object there is.
  const perRow = [];
  for (const { block } of store.entries()) {
    for (let row = 0; row < block.n; row++) perRow.push({ row });
  }
  for (const buffer of buffers.slice(0, 2)) {
    const { n } = decodeBlocks(buffer).blocks[0];
    for (let row = 0; row < n; row++) perRow.push({ row });
  }
  const control = settledHeap() - before - grown;

  assert.equal(total, rows);
  assert.equal(perRow.length, rows);
  assert.deepEqual(evicted, [1, 2]);
  // Columns live outside the heap. The margin absorbs the runner's own noise.
  assert.ok(grown < 400_000, `heap grew by ${grown} bytes for ${rows} rows`);
  assert.ok(control > 1_000_000, `the control only grew the heap by ${control} bytes`);
});
