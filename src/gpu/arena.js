// GPU arena: the rows blocks of the store (docs/heat-pipeline.md §c), as
// three STORAGE buffers sub-allocated per block, plus a block table indexed by
// handle. One writeBuffer per column of a block on put; nothing is read back.
//
// Allocation is a bump pointer per buffer. drop() leaves a hole. When a put
// does not fit after the pointer, the buffer is reallocated and its live
// blocks are copied GPU→GPU, packed in their current order:
// - at the same size when the holes are at least COMPACT_RATIO of it
//   (compaction),
// - otherwise at twice the size (growth, which compacts too).
// So the CPU never copies block data twice, compaction costs one copy per run
// of live blocks, and the peak during a move is the old plus the new buffer.
// Puts that replace a handle reuse nothing in place: blocks are immutable.
//
// Handles index the table directly (48 bytes each): the worker allocates them
// densely, and the table grows by doubling, copied GPU→GPU too.
import { bufferUsage } from "./device.js";

/** Bytes per handle in the block table. */
export const BLOCK_TABLE_BYTES = 48;
const TABLE_WORDS = BLOCK_TABLE_BYTES / 4;

const MIN_HEAP_WORDS = 1 << 14;
const MIN_TABLE_HANDLES = 256;
const COMPACT_RATIO = 0.25;
const HEAPS = ["keys", "count", "metrics"];

/**
 * @param {GPUDevice} device
 * @param {{budgetBytes?: number}} options budgetBytes caps the three buffers
 *   together (default 256 MiB, the store's budget: the arena mirrors it).
 */
export function createArena(device, { budgetBytes = 256 << 20 } = {}) {
  const blocks = new Map();
  const heaps = {};
  let table = null;
  let tableHandles = 0;
  let mirror = new Uint32Array(0);
  let generation = 0;

  function limit() {
    const limits = device.limits ?? {};
    return Math.min(
      limits.maxStorageBufferBindingSize ?? 128 << 20,
      limits.maxBufferSize ?? 256 << 20,
    );
  }

  function capacityBytes() {
    return HEAPS.reduce((total, name) => total + heaps[name].capacity * 4, 0);
  }

  function createStorage(label, bytes) {
    const usage = bufferUsage.STORAGE | bufferUsage.COPY_DST | bufferUsage.COPY_SRC;
    return device.createBuffer({ label, size: Math.max(4, bytes), usage });
  }

  function allocate(words) {
    for (const name of HEAPS) {
      heaps[name] = {
        name,
        buffer: createStorage(`arena-${name}`, words[name] * 4),
        capacity: words[name],
        top: 0,
        live: 0,
      };
    }
    tableHandles = MIN_TABLE_HANDLES;
    table = createStorage("arena-table", tableHandles * BLOCK_TABLE_BYTES);
    mirror = new Uint32Array(tableHandles * TABLE_WORDS);
    generation++;
  }

  allocate({ keys: MIN_HEAP_WORDS, count: MIN_HEAP_WORDS, metrics: MIN_HEAP_WORDS });

  function ensureHandle(handle) {
    if (handle < tableHandles) {
      return;
    }
    let handles = tableHandles;
    while (handles <= handle) {
      handles *= 2;
    }
    if (handles * BLOCK_TABLE_BYTES > limit()) {
      throw new RangeError(
        `arena: handle ${handle} needs a table above the device limit; allocate handles densely`,
      );
    }
    const next = createStorage("arena-table", handles * BLOCK_TABLE_BYTES);
    const encoder = device.createCommandEncoder({ label: "arena-table-grow" });
    encoder.copyBufferToBuffer(table, 0, next, 0, tableHandles * BLOCK_TABLE_BYTES);
    device.queue.submit([encoder.finish()]);
    table.destroy();
    table = next;
    const grown = new Uint32Array(handles * TABLE_WORDS);
    grown.set(mirror);
    mirror = grown;
    tableHandles = handles;
    generation++;
  }

  // Makes room for `words` after the bump pointer of one heap.
  function reserve(heap, words) {
    if (heap.top + words <= heap.capacity) {
      return false;
    }
    const needed = heap.live + words;
    const holes = heap.top - heap.live;
    let capacity = heap.capacity;
    if (needed > capacity || holes < capacity * COMPACT_RATIO) {
      capacity = Math.max(capacity * 2, needed);
    }
    const others = capacityBytes() - heap.capacity * 4;
    capacity = Math.min(capacity, Math.floor((budgetBytes - others) / 4), Math.floor(limit() / 4));
    if (capacity < needed) {
      throw new RangeError(
        `arena: ${heap.name} needs ${needed * 4} bytes, budget ${budgetBytes} and device limit ${limit()} allow ${capacity * 4}`,
      );
    }
    relocate(heap, capacity);
    return true;
  }

  // Copies the live blocks of one heap, in offset order, into a new buffer.
  function relocate(heap, capacity) {
    const next = createStorage(`arena-${heap.name}`, capacity * 4);
    const live = [...blocks.values()].filter((block) => block[heap.name].words > 0);
    live.sort((a, b) => a[heap.name].offset - b[heap.name].offset);
    const encoder = device.createCommandEncoder({ label: `arena-${heap.name}-move` });
    let top = 0;
    let run = null;
    for (const block of live) {
      const range = block[heap.name];
      if (run && run.from + run.words === range.offset) {
        run.words += range.words;
      } else {
        if (run) {
          encoder.copyBufferToBuffer(heap.buffer, run.from * 4, next, run.to * 4, run.words * 4);
        }
        run = { from: range.offset, to: top, words: range.words };
      }
      range.offset = top;
      top += range.words;
    }
    if (run) {
      encoder.copyBufferToBuffer(heap.buffer, run.from * 4, next, run.to * 4, run.words * 4);
    }
    device.queue.submit([encoder.finish()]);
    heap.buffer.destroy();
    heap.buffer = next;
    heap.capacity = capacity;
    heap.top = top;
    generation++;
    for (const block of live) {
      writeMirror(block);
    }
  }

  function writeMirror(block) {
    const at = block.handle * TABLE_WORDS;
    mirror.set(
      [
        block.keys.offset,
        block.count.offset,
        block.metrics.offset,
        block.n,
        block.keyWords,
        block.suffixChars,
        block.metricCount,
        block.depth,
      ],
      at,
    );
    new Float32Array(mirror.buffer, (at + 8) * 4, 4).set(block.origin);
  }

  function put(handle, rows, origin) {
    if (!Number.isInteger(handle) || handle < 0 || handle > 0xffffffff) {
      throw new RangeError(`arena: handle ${handle} is not a u32`);
    }
    const { n, keyWords, suffixChars, metricCount } = rows;
    if (keyWords !== Math.ceil((6 * suffixChars) / 32)) {
      throw new RangeError(`arena: keyWords ${keyWords} does not match suffixChars ${suffixChars}`);
    }
    if (
      rows.keys.length < n * keyWords ||
      rows.count.length < n ||
      rows.metrics.length < metricCount * n
    ) {
      throw new RangeError("arena: a column is shorter than the block's header says");
    }
    if (blocks.has(handle)) {
      drop(handle);
    }
    ensureHandle(handle);

    const columns = {
      keys: rows.keys.subarray(0, n * keyWords),
      count: rows.count.subarray(0, n),
      // The kernels read f32: a block served with 8-byte metrics is rounded here, once.
      metrics:
        rows.metrics instanceof Float64Array
          ? Float32Array.from(rows.metrics.subarray(0, metricCount * n))
          : rows.metrics.subarray(0, metricCount * n),
    };
    const block = {
      handle,
      n,
      keyWords,
      suffixChars,
      metricCount,
      depth: rows.parent ? rows.parent.length : 0,
      origin: Float32Array.from({ length: 4 }, (_, i) => origin[i] ?? 0),
    };
    let moved = false;
    for (const name of HEAPS) {
      const heap = heaps[name];
      const words = columns[name].length;
      moved = reserve(heap, words) || moved;
      block[name] = { offset: heap.top, words };
      heap.top += words;
      heap.live += words;
    }
    blocks.set(handle, block);
    for (const name of HEAPS) {
      if (block[name].words > 0) {
        device.queue.writeBuffer(heaps[name].buffer, block[name].offset * 4, columns[name]);
      }
    }
    writeMirror(block);
    writeTable(moved ? null : handle);
  }

  // One row of the table, or all of it after blocks moved.
  function writeTable(handle) {
    if (handle === null) {
      device.queue.writeBuffer(table, 0, mirror);
      return;
    }
    device.queue.writeBuffer(
      table,
      handle * BLOCK_TABLE_BYTES,
      mirror.subarray(handle * TABLE_WORDS, (handle + 1) * TABLE_WORDS),
    );
  }

  function drop(handle) {
    const block = blocks.get(handle);
    if (!block) {
      return false;
    }
    blocks.delete(handle);
    for (const name of HEAPS) {
      heaps[name].live -= block[name].words;
      if (heaps[name].live === 0) {
        heaps[name].top = 0;
      }
    }
    mirror.fill(0, handle * TABLE_WORDS, (handle + 1) * TABLE_WORDS);
    writeTable(handle);
    return true;
  }

  function destroyBuffers() {
    for (const name of HEAPS) {
      heaps[name].buffer.destroy();
    }
    table.destroy();
  }

  /**
   * Rewrites every block from the store's CPU copy, on a new device after a
   * loss (decision 6). Handles the store no longer holds are forgotten.
   * `store.get(handle)` returns the RowsBlock given to store.put.
   * @returns {{rebuilt: number[], missing: number[]}}
   */
  function rebuild(store, nextDevice = device) {
    const previous = [...blocks.values()].sort((a, b) => a.handle - b.handle);
    try {
      destroyBuffers();
    } catch {
      // A lost device may refuse destroy(); its buffers are gone anyway.
    }
    device = nextDevice;
    blocks.clear();
    const kept = [];
    const missing = [];
    const words = { keys: MIN_HEAP_WORDS, count: MIN_HEAP_WORDS, metrics: MIN_HEAP_WORDS };
    const used = { keys: 0, count: 0, metrics: 0 };
    for (const block of previous) {
      const rows = store.get(block.handle);
      if (!rows) {
        missing.push(block.handle);
        continue;
      }
      kept.push({ handle: block.handle, rows, origin: block.origin });
      used.keys += rows.n * rows.keyWords;
      used.count += rows.n;
      used.metrics += rows.n * rows.metricCount;
    }
    // Sized once from the store, so that the rewrite moves nothing.
    for (const name of HEAPS) {
      words[name] = Math.max(MIN_HEAP_WORDS, Math.ceil(used[name] * 1.25));
    }
    allocate(words);
    for (const { handle, rows, origin } of kept) {
      put(handle, rows, origin);
    }
    return { rebuilt: kept.map((item) => item.handle), missing };
  }

  return {
    put,
    drop,
    has: (handle) => blocks.has(handle),
    /** CPU description of a block, for the pack kernel's checks. */
    info: (handle) => blocks.get(handle) ?? null,
    rebuild,
    destroy: destroyBuffers,
    get table() {
      return table;
    },
    get buffers() {
      return { keys: heaps.keys.buffer, count: heaps.count.buffer, metrics: heaps.metrics.buffer };
    },
    /** Changes whenever a buffer is replaced: bind groups made before are stale. */
    get generation() {
      return generation;
    },
    get device() {
      return device;
    },
    get bytes() {
      return HEAPS.reduce((total, name) => total + heaps[name].live * 4, 0);
    },
    get capacityBytes() {
      return capacityBytes();
    },
  };
}
