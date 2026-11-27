// The CPU copy of every block, on the main thread: the response buffers as
// they arrived, under one byte budget. The GPU arena is rebuilt from here
// after a device loss, without the network (docs/heat-pipeline.md).
//
// A response buffer carries one section per (zone, key depth), and each
// section has its own handle. The budget counts a buffer once, and a buffer
// leaves only as a whole: dropping one handle of a shared buffer frees
// nothing, so eviction never does it.

/** @typedef {import("../wire/block.js").RowsBlock} RowsBlock */

/**
 * @typedef {object} StoredBlock
 * @property {number} handle
 * @property {string} zone
 * @property {RowsBlock} block  views on the stored buffer
 */

export { adoptBlocks, sectionsOf } from "./transfer.js";

/**
 * @param {{ budgetBytes?: number }} [options]
 */
export function createBlockStore({ budgetBytes = 256 << 20 } = {}) {
  /** @type {Map<number, StoredBlock & { buffer: ArrayBufferLike }>} */
  const blocks = new Map();
  // Least recently used first. `byteLength` is kept here because a buffer
  // that was transferred away reports 0.
  /** @type {Map<ArrayBufferLike, { byteLength: number, handles: Set<number> }>} */
  const buffers = new Map();
  /** @type {Set<number>} */
  let pinned = new Set();
  let bytes = 0;

  function release(handle) {
    const stored = blocks.get(handle);
    if (!stored) return;
    blocks.delete(handle);
    const shared = buffers.get(stored.buffer);
    shared.handles.delete(handle);
    if (shared.handles.size > 0) return;
    buffers.delete(stored.buffer);
    bytes -= shared.byteLength;
  }

  function isPinned(shared) {
    for (const handle of shared.handles) {
      if (pinned.has(handle)) return true;
    }
    return false;
  }

  return {
    /**
     * Keeps `rowsBlock` and, through its views, the buffer it came in. No
     * copy. A handle already there is replaced.
     * @param {number} handle
     * @param {string} zone
     * @param {RowsBlock} rowsBlock
     */
    put(handle, zone, rowsBlock) {
      release(handle);
      const buffer = rowsBlock.keys.buffer;
      let shared = buffers.get(buffer);
      if (shared) {
        buffers.delete(buffer);
      } else {
        shared = { byteLength: buffer.byteLength, handles: new Set() };
        bytes += shared.byteLength;
      }
      buffers.set(buffer, shared);
      shared.handles.add(handle);
      blocks.set(handle, { handle, zone, block: rowsBlock, buffer });
    },

    /**
     * The block of `handle`, which becomes the most recently used.
     * @param {number} handle
     * @returns {RowsBlock | undefined}
     */
    get(handle) {
      const stored = blocks.get(handle);
      if (!stored) return undefined;
      const shared = buffers.get(stored.buffer);
      buffers.delete(stored.buffer);
      buffers.set(stored.buffer, shared);
      return stored.block;
    },

    /** @param {number} handle */
    has(handle) {
      return blocks.has(handle);
    },

    /**
     * The handles the last plan draws. They replace the previous pins, and
     * `evict` never takes them.
     * @param {Iterable<number>} handles
     */
    pin(handles) {
      pinned = new Set(handles);
    },

    /**
     * Brings the store back under its budget: least recently used buffers
     * first, skipping any buffer that holds a pinned handle. Pins can keep
     * the store above its budget.
     * @returns {number[]} evicted handles, for `STORE_EVICTED`
     */
    evict() {
      const evicted = [];
      if (bytes <= budgetBytes) return evicted;
      for (const shared of [...buffers.values()]) {
        if (isPinned(shared)) continue;
        for (const handle of [...shared.handles]) {
          evicted.push(handle);
          release(handle);
        }
        if (bytes <= budgetBytes) break;
      }
      return evicted;
    },

    /**
     * Blocks replaced by a reconcile (`DROP`). A shared buffer is freed with
     * its last handle.
     * @param {Iterable<number>} handles
     */
    drop(handles) {
      for (const handle of handles) release(handle);
    },

    /**
     * Every stored block, to rebuild the GPU arena. Does not touch the LRU
     * order.
     * @returns {IterableIterator<StoredBlock>}
     */
    entries() {
      return blocks.values();
    },

    /** Bytes of the buffers held, each counted once. */
    get bytes() {
      return bytes;
    },

    clear() {
      blocks.clear();
      buffers.clear();
      pinned = new Set();
      bytes = 0;
    },
  };
}
