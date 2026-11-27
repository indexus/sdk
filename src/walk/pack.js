// Layout of a plan entry and of an instance, shared by the walk (which emits
// entries), the pack kernel (gpu/pack.js) and the renderer. The CPU reference
// of the kernel is in walk/pack.testkit.mjs.

/** u32 words per entry: handle, firstRow, rowCount, slot (i32), targetResolution, flags, outBase, binCapacity. */
export const ENTRY_WORDS = 8;
export const FLAG_ENTER = 1;
export const FLAG_LEAVE = 2;
/** Slide the cell and parent anchors into the strict view when they fall outside. */
export const FLAG_NUDGE = 4;
/**
 * Virtual entry: the rows of one character, binned by the geometric bits that
 * follow it down to targetResolution; bin b is output outBase + b and its
 * parent is the enclosing bin b >> size of the same entry. Other entries are
 * one bin each.
 */
export const FLAG_VIRTUAL = 8;
export const FLOATS_PER_INSTANCE = 14;
