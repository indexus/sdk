class Offset {
  /**
   * Constructs a new Offset instance.
   * @param {number[]} details - An array of integers.
   */
  constructor(args) {
    if (!Array.isArray(args[0])) {
      throw new Error("Details must be an array of integers.");
    }
    this.details = args[0];
  }

  /**
   * Retrieves the offset value at the specified level.
   *
   * The details repeat cyclically: a collection's offset is as long as its
   * name, and a location may be deeper than that (SETS_PRECISION is 32).
   * Repeating keeps every level shifted by a defined value; an empty offset
   * shifts nothing.
   * @param {number} l - The level to retrieve.
   * @returns {number}
   */
  at(l) {
    const length = this.details.length;
    return length === 0 ? 0 : this.details[l % length];
  }
}

export { Offset };
