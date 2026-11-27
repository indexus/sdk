import { Spherical } from "./spherical.js";
import { Linear } from "./linear.js";
import { Offset } from "./offset.js";
import { Mask } from "./mask.js";
import { charsToNumbers } from "./alphabet.js";

const DIMENSIONS = {
  spherical: Spherical,
  linear: Linear,
};

function mapDimension(type, name, args) {
  return new DIMENSIONS[type](name, args);
}

class Collection {
  constructor(name, dimensions) {
    this._name = name;
    this._dimensions = [];

    const m = dimensions.reduce((total, dimension) => {
      const d = mapDimension(dimension.type, dimension.name, dimension.args);
      this._dimensions.push(d);
      return total + d.pointLength();
    }, 0);

    const mask = Array.from({ length: m }, (_, i) => i);

    this._mask = new Mask(mask);
    this._offset = new Offset([charsToNumbers(name)]);
  }

  /**
   * Returns the name of the collection.
   * @returns {string}
   */
  name() {
    return this._name;
  }

  /**
   * Returns an array of dimension names associated with the collection.
   * @returns {Dimension[]}
   */
  dimensions() {
    return this._dimensions;
  }

  /**
   * Returns a mask.
   * @returns {Mask}
   */
  mask() {
    return this._mask;
  }

  /**
   * Returns a offset.
   * @returns {Offset}
   */
  offset() {
    return this._offset;
  }
}

export { Collection };
