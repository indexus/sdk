// Blocks cross from the worker to the main thread as the response buffer
// itself, transferred, plus one line per rows section: the `BLOCKS` message of
// docs/heat-pipeline.md. The views do not survive a transfer, so the main
// thread decodes the headers again; a section is recognised by its offset.

import { ROOT } from "../tree/alphabet.js";
import { decodeBlocks } from "../wire/block.js";

/** @typedef {import("../wire/block.js").RowsBlock} RowsBlock */
/** @typedef {{ handle: number, zone: string, offset: number, byteLength: number }} Section */

// core/docs/protocol/wire-block.md: section header, rows header, then the
// parent padded to 4 bytes, then the keys.
const SECTION_HEADER_BYTES = 8;
const ROWS_HEADER_BYTES = 12;

function sectionOffset(block) {
  const parentBytes = (block.parent.length + 3) & ~3;
  return block.keys.byteOffset - parentBytes - ROWS_HEADER_BYTES - SECTION_HEADER_BYTES;
}

/**
 * Worker side, before the transfer.
 * @param {ArrayBuffer} buffer whole IXB2 body
 * @param {RowsBlock[]} blocks `decodeBlocks(buffer).blocks`
 * @param {(zone: string, block: RowsBlock) => number} allocateHandle u32 per section
 * @returns {Section[]}
 */
export function sectionsOf(buffer, blocks, allocateHandle) {
  const view = new DataView(buffer);
  const sections = [];
  for (const block of blocks) {
    if (block.keys.buffer !== buffer)
      throw new Error("store: block does not belong to this buffer");
    const zone = block.parent || ROOT;
    const offset = sectionOffset(block);
    sections.push({
      handle: allocateHandle(zone, block),
      zone,
      offset,
      byteLength: view.getUint32(offset, true),
    });
  }
  return sections;
}

/**
 * Main side: puts every section of a `BLOCKS` message in the store.
 * @param {ReturnType<typeof import("./index.js").createBlockStore>} store
 * @param {{ buffer: ArrayBuffer, sections: Section[] }} message
 */
export function adoptBlocks(store, { buffer, sections }) {
  const byOffset = new Map();
  for (const block of decodeBlocks(buffer).blocks) {
    byOffset.set(sectionOffset(block), block);
  }
  for (const { handle, zone, offset } of sections) {
    const block = byOffset.get(offset);
    if (!block) throw new Error(`store: no rows section at offset ${offset}`);
    store.put(handle, zone, block);
  }
}
