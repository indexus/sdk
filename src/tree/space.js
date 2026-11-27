import { ROOT, LOCATION_ALPHABET, BITS_PER_CHAR } from "./alphabet.js";

// Alphabet index of a character code (LOCATION_ALPHABET.indexOf of the
// character): -1 outside the alphabet, as indexOf.
const CHAR_INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < LOCATION_ALPHABET.length; i++) {
  CHAR_INDEX[LOCATION_ALPHABET.charCodeAt(i)] = i;
}

function charIndex(hash, l) {
  const code = hash.charCodeAt(l);
  return code < 128 ? CHAR_INDEX[code] : -1;
}

class Space {
  constructor(dimensions, mask, offset) {
    const size = dimensions.reduce((total, dimension) => {
      return total + dimension.pointLength();
    }, 0);

    this.dimensions = dimensions;
    this.mask = mask;
    this.offset = offset;
    this.size = size;
    this.step = BITS_PER_CHAR / size; // BASE64 = 2^6
  }

  signature() {
    return this._signature();
  }

  dimension(i) {
    return this.dimensions[i];
  }

  newPoint(coordinates) {
    return this._coordinatesToPoints(coordinates);
  }

  newSegment(coordinates) {
    const segments = [];
    for (let i = 0; i < this.dimensions.length; i++) {
      const dimension = this.dimensions[i];
      segments[i] = dimension.newSegment(coordinates[i]);
    }
    return segments;
  }

  newFilter(distance, direction) {
    return this._coordinatesToFilters(distance, direction);
  }

  encode(points, precision) {
    return this._encode(this._pointsToCoordinates(points), precision);
  }

  decode(hash) {
    return this._coordinatesToSegments(this._decode(hash));
  }

  xyz(hash) {
    return this._xyz(hash);
  }

  // The cell of an xyz (as returned by xyz()). The second parameter was never
  // read; callers pass the xyz alone.
  bounds(xyz) {
    return this._coordinatesToSegments(this._bounds(xyz));
  }

  center(segments) {
    return this.dimensions.map((dimension, i) => dimension.segmentCenter(segments[i]));
  }

  extend(segments, offset) {
    return this.dimensions.map((dimension, i) => dimension.segmentExtension(segments[i], offset));
  }

  points(bounds) {
    return this._boundsToPoints(bounds);
  }

  root() {
    return this._coordinatesToSegments(this._root());
  }

  overlap(bounds, segments) {
    let overlap = true;
    let contained = true;

    for (let idx = 0; idx < this.dimensions.length; idx++) {
      const result = this.dimensions[idx].segmentsOverlap(bounds[idx], segments[idx]);

      if (!result.overlap) {
        overlap = false;
        contained = false;
        break;
      }

      if (!result.contained) {
        contained = false;
      }
    }

    return {
      overlap,
      contained,
    };
  }

  // Private methods
  _signature() {
    const length = this.dimensions.length;
    const trace = [];

    for (let i = 0; i < length; i++) {
      const dimension = this.dimensions[i];
      trace[i] = dimension.name();
      if (i === length - 1) {
        trace[i + 1] = this.mask.signature();
      }
    }
    return trace.join("|");
  }

  // Root bounds, flat: [min0, max0, min1, max1, ...], one pair per axis. The
  // dimensions do not change after construction, so this is built once;
  // callers that mutate get a copy from _root().
  _rootValues() {
    if (this._rootFlat === undefined) {
      const root = [];
      for (const dimension of this.dimensions) {
        root.push(...dimension.rootSegment().value());
      }
      this._rootFlat = root;
    }
    return this._rootFlat;
  }

  _root() {
    return this._rootValues().slice();
  }

  // mask.at(l, n) and offset.at(l) for the first `levels` levels, read once.
  // Mask and offset are duck-typed (anything with at()), pure and fixed for
  // the life of the Space; the table grows when a deeper level is asked.
  _levels(levels) {
    let table = this._levelTable;
    if (table === undefined || table.count < levels) {
      const count = Math.max(levels, table === undefined ? 32 : table.count * 2);
      const axes = new Array(count * BITS_PER_CHAR);
      const shifts = new Array(count);
      for (let l = 0; l < count; l++) {
        for (let n = 0; n < BITS_PER_CHAR; n++) {
          axes[l * BITS_PER_CHAR + n] = this.mask.at(l, n);
        }
        shifts[l] = this.offset.at(l);
      }
      table = this._levelTable = { count, axes, shifts };
    }
    return table;
  }

  _encode(coordinates, precision) {
    if (precision === 0) {
      return ROOT;
    }

    const src = this._root();
    const { axes, shifts } = this._levels(precision);
    let hash = "";

    for (let l = 0; l < precision; l++) {
      let idx = 0;
      for (let n = 0; n < BITS_PER_CHAR; n++) {
        const maskIndex = axes[l * BITS_PER_CHAR + n];
        const mid = (src[maskIndex * 2] + src[maskIndex * 2 + 1]) / 2;
        if (coordinates[maskIndex] > mid) {
          idx = idx * 2 + 1;
          src[maskIndex * 2] = mid;
        } else {
          idx = idx * 2;
          src[maskIndex * 2 + 1] = mid;
        }
      }
      const baseIndex = (shifts[l] + idx) % 64;
      hash += LOCATION_ALPHABET.charAt(baseIndex);
    }

    return hash;
  }

  _decode(hash) {
    const src = this._root();

    if (hash === ROOT) {
      return src;
    }

    const { axes, shifts } = this._levels(hash.length);
    for (let l = 0; l < hash.length; l++) {
      const idx = (64 + charIndex(hash, l) - shifts[l]) % 64;
      for (let n = 0; n < BITS_PER_CHAR; n++) {
        const maskIndex = axes[l * BITS_PER_CHAR + n];
        const mid = (src[maskIndex * 2] + src[maskIndex * 2 + 1]) / 2;
        if (((idx >> (BITS_PER_CHAR - 1 - n)) & 1) === 1) {
          src[maskIndex * 2] = mid;
        } else {
          src[maskIndex * 2 + 1] = mid;
        }
      }
    }

    return src;
  }

  _xyz(hash) {
    const axisCount = this._rootValues().length / 2;
    const coordinates = [];
    let resolution = 0;
    const resolutions = new Array(this.size).fill(0);

    for (let i = 0; i < axisCount; i++) {
      coordinates[i] = 0;
    }

    if (hash === ROOT) {
      return { coordinates, resolution };
    }

    const { axes, shifts } = this._levels(hash.length);
    for (let l = 0; l < hash.length; l++) {
      const idx = (64 + charIndex(hash, l) - shifts[l]) % 64;
      for (let n = 0; n < BITS_PER_CHAR; n++) {
        const maskIndex = axes[l * BITS_PER_CHAR + n];
        coordinates[maskIndex] *= 2;
        resolutions[maskIndex]++;
        resolution++;
        if (((idx >> (BITS_PER_CHAR - 1 - n)) & 1) === 1) {
          coordinates[maskIndex] += 1;
        }
      }
    }

    resolution /= coordinates.length;

    return resolutions.every((r) => r === resolution)
      ? { resolution, coordinates }
      : { resolution, coordinates, resolutions };
  }

  _bounds(xyz) {
    const root = this._rootValues();
    const bounds = [];
    let idx = 0;
    for (let i = 0; i < this.dimensions.length; i++) {
      const axes = this.dimensions[i].segmentLength() / 2;
      for (let j = 0; j < axes; j++) {
        const min = root[idx * 2];
        const max = root[idx * 2 + 1];

        const step = (max - min) / 2 ** (xyz.resolutions?.[idx] ?? xyz.resolution);

        bounds[idx * 2] = xyz.coordinates[idx] * step + min;
        bounds[idx * 2 + 1] = (xyz.coordinates[idx] + 1) * step + min;

        idx++;
      }
    }

    return bounds;
  }

  _coordinatesToPoints(coordinates) {
    const origin = [];
    for (let i = 0; i < this.dimensions.length; i++) {
      const dimension = this.dimensions[i];
      origin.push(dimension.newPoint(coordinates[i]));
    }
    return origin;
  }

  _coordinatesToFilters(distance, direction) {
    const filters = [];
    for (let i = 0; i < this.dimensions.length; i++) {
      const dimension = this.dimensions[i];
      filters.push(dimension.newFilter(distance[i], direction[i]));
    }
    return filters;
  }

  _pointsToCoordinates(points) {
    const coordinates = [];
    for (const point of points) {
      coordinates.push(...point.value());
    }
    return coordinates;
  }

  _coordinatesToSegments(coordinates) {
    let min = 0,
      max = 0;
    const indexes = [];

    for (let i = 0; i < this.dimensions.length; i++) {
      const dimension = this.dimensions[i];
      min = max;
      max += dimension.segmentLength();
      indexes[i] = dimension.newSegment(coordinates.slice(min, max));
    }

    return indexes;
  }

  _boundsToPoints(bounds) {
    let coordinates = [];

    this.dimensions.forEach((dimension, i) => {
      const tmp = [];
      const points = bounds[i].points();

      points.forEach((point) => {
        if (i === 0) {
          tmp.push(point.value());
          return;
        }

        coordinates.forEach((coordinate) => {
          tmp.push([coordinate, point.value()]);
        });
      });

      coordinates = tmp;
    });

    return coordinates.map((coordinate) => this._coordinatesToPoints(coordinate));
  }
}

export { Space };
