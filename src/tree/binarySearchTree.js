// A binary trie of byte ids, one level per bit (most significant first); the
// network's routing table keeps its peers in it.

/** Bit `idx` of `id`, most significant bit of byte 0 first. */
const bitAt = (id, idx) => (id[idx >> 3] >> (7 - (idx & 7))) & 1;

class BinarySearchTree {
  constructor(node = null) {
    this.left = null;
    this.right = null;
    this.node = node;
  }

  /** Stores `node` at the leaf of `id`, from bit `idx` down. */
  insert(idx, id, node) {
    if (idx >> 3 === id.length) {
      this.node = node;
      return;
    }
    const side = bitAt(id, idx) ? "right" : "left";
    if (this[side] === null) this[side] = new BinarySearchTree();
    this[side].insert(idx + 1, id, node);
  }

  /**
   * Calls `process(depth, id, node)` on each leaf below the root, left first;
   * `value` is the path so far.
   */
  traverse(idx, value, process) {
    if (this.left !== null) this.left.traverse(idx + 1, Uint8Array.from(value), process);
    if (this.right !== null) {
      const id = Uint8Array.from(value);
      id[idx >> 3] |= 1 << (7 - (idx & 7));
      this.right.traverse(idx + 1, id, process);
    }
    if (idx > 0 && this.left === null && this.right === null) process(idx, value, this.node);
  }

  /** The node whose path follows `value` longest, taking the only branch where it differs. */
  nearest(idx, value) {
    if (idx >> 3 === value.length) return this.node;
    const bit = bitAt(value, idx);
    if (this.left !== null && (!bit || this.right === null)) {
      return this.left.nearest(idx + 1, value);
    }
    if (this.right !== null) return this.right.nearest(idx + 1, value);
    return this.node;
  }

  /** Removes the leaf of `value`; true when this subtree is left empty and its parent drops it. */
  remove(idx, value) {
    if (idx >> 3 === value.length) return true;
    const side = bitAt(value, idx) ? "right" : "left";
    const other = side === "left" ? "right" : "left";
    if (this[side] !== null && this[side].remove(idx + 1, value)) {
      this[side] = null;
      return this[other] === null;
    }
    return false;
  }
}

export { BinarySearchTree };
