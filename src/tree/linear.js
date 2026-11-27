// Point on a linear dimension.
class Point {
  constructor(value) {
    this._value = value;
  }

  value() {
    return [this._value];
  }

  print() {
    return `(value: ${this._value})`;
  }
}

// Segment on a linear dimension.
class Segment {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }

  value() {
    return [this.start, this.end];
  }

  points() {
    return [new Point(this.start), new Point(this.end)];
  }

  print() {
    const startDate = new Date(this.start * 1000);
    const endDate = new Date(this.end * 1000);
    return `(start: ${startDate.toISOString()}, end: ${endDate.toISOString()})`;
  }
}

// Direction on a linear dimension.
class Direction {
  constructor(value) {
    this._value = value;
  }

  value() {
    return [this._value];
  }
}

// Filter on a linear dimension.
class Filter {
  constructor(minDistance, maxDistance, direction) {
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;
    this.direction = direction;
  }
}

// A dimension of scalar points; same interface as Spherical.
class Linear {
  constructor(name, args) {
    this._name = name;
    this._rootSegment = new Segment(args[0], args[1]);
    this._ratio = (this._rootSegment.end - this._rootSegment.start) / 2;
  }

  name() {
    return this._name;
  }

  type() {
    return "linear";
  }

  ratio() {
    return this._ratio;
  }

  newPoint(coordinates) {
    return new Point(coordinates[0]);
  }

  pointLength() {
    return 1;
  }

  pointDistance(origin, distant) {
    return Math.abs(distant._value - origin._value);
  }

  pointDirection(origin, distant) {
    if (origin._value < distant._value) {
      return 1;
    } else if (origin._value > distant._value) {
      return -1;
    }
    return 0;
  }

  newSegment(coordinates) {
    return new Segment(coordinates[0], coordinates[1]);
  }

  rootSegment() {
    return this._rootSegment;
  }

  segmentLength() {
    return 2;
  }

  segmentDistance(point, segment) {
    if (segment.start === this._rootSegment.start && segment.end === this._rootSegment.end) {
      return segment.end - segment.start;
    } else if (point._value < segment.start) {
      return segment.start - point._value;
    } else if (point._value > segment.end) {
      return point._value - segment.end;
    }
    return 0;
  }

  segmentDirection(point, segment) {
    const direction = new Direction(0);
    if (point._value < segment.start) {
      direction._value = 1;
    } else if (point._value > segment.end) {
      direction._value = -1;
    }
    return direction;
  }

  segmentCenter(segment) {
    return new Point((segment.start + segment.end) / 2);
  }

  segmentExtension(segment, offset) {
    const step = offset * (segment.end - segment.start);

    return new Segment(segment.start - step, segment.end + step);
  }

  segmentsOverlap(segment1, segment2) {
    return {
      overlap: segment1.start <= segment2.end && segment1.end >= segment2.start,
      contained: segment1.start <= segment2.start && segment1.end >= segment2.end,
    };
  }

  newFilter(distance, direction) {
    return new Filter(distance[0], distance[1], direction[0]);
  }

  // A zone lower bound can reject the outer radius, but cannot reject the inner one.
  filterDistance(filter, distance, lowerBound = false) {
    return (
      (lowerBound || filter.minDistance === 0 || distance >= filter.minDistance) &&
      (filter.maxDistance === 0 || distance <= filter.maxDistance)
    );
  }

  filterDirection(filter, direction) {
    const srcValue = filter.direction;
    const directionValue = direction.value()[0];

    if (srcValue === 0 || directionValue === 0) {
      return true;
    }

    return srcValue === directionValue;
  }
}

export { Linear };
