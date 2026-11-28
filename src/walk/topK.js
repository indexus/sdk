// Keep a bounded batch and use the native sorter when it reaches 2k rows.
// The worst retained result after each sort stays a safe cutoff until the next.
export class TopK {
  constructor(limit, compare) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Expected a positive integer limit");
    this.limit = limit;
    this.compare = compare;
    this.rows = [];
    this.cutoff = undefined;
  }

  add(row) {
    if (this.cutoff && this.compare(row, this.cutoff) >= 0) return;
    this.rows.push(row);
    if (this.rows.length === 2 * this.limit) {
      this.rows.sort(this.compare);
      this.rows.length = this.limit;
      this.cutoff = this.rows[this.limit - 1];
    }
  }

  finish() {
    this.rows.sort(this.compare);
    this.rows.length = Math.min(this.rows.length, this.limit);
    return this.rows;
  }
}
