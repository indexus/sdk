class Mask {
  /**
   * Constructs a new Mask instance.
   * @param {number[]} value - An array of integers.
   */
  constructor(value) {
    this.value = value;
  }

  /**
   * Retrieves the mask value at the specified indices.
   * @param {number} i
   * @param {number} j
   * @returns {number}
   */
  at(i, j) {
    const idx = (i * 6 + j) % this.value.length;
    return this.value[idx];
  }
}

export { Mask };
