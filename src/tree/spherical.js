// Point on a spherical dimension.
class Point {
  constructor(latitude, longitude) {
    this.latitude = latitude;
    this.longitude = longitude;
  }

  value() {
    return [this.latitude, this.longitude];
  }

  print() {
    return `(latitude: ${this.latitude}, longitude: ${this.longitude})`;
  }
}

// Segment on a spherical dimension.
class Segment {
  constructor(south, north, west, east) {
    this.south = south;
    this.north = north;
    this.west = west;
    this.east = east;
  }

  value() {
    return [this.south, this.north, this.west, this.east];
  }

  points() {
    return [
      new Point(this.south, this.west),
      new Point(this.south, this.east),
      new Point(this.north, this.west),
      new Point(this.north, this.east),
    ];
  }

  print() {
    return `(south: ${this.south}, west: ${this.west}, north: ${this.north}, east: ${this.east})`;
  }
}

// Direction on a spherical dimension.
class Direction {
  constructor(south, north, west, east, arc = null) {
    this.south = south;
    this.north = north;
    this.west = west;
    this.east = east;
    this._arc = arc;
  }

  value() {
    return [this.south, this.north, this.west, this.east];
  }
}

// Filter on a spherical dimension.
class Filter {
  constructor(minDistance, maxDistance, minAngle, maxAngle) {
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;
    this.minAngle = minAngle;
    this.maxAngle = maxAngle;
  }
}

// A dimension of (latitude, longitude) points. Spherical and Linear share one
// duck-typed interface (name, type, ratio, point*, segment*, filter*) that
// Space calls; there is no base class.
class Spherical {
  constructor(name, args) {
    this._name = name;
    this._ratio = this.pointDistance(new Point(args[0], args[2]), new Point(args[1], args[3]));
    this._rootSegment = new Segment(args[0], args[1], args[2], args[3]);
  }

  name() {
    return this._name;
  }

  type() {
    return "spherical";
  }

  ratio() {
    return this._ratio;
  }

  newPoint(coordinates) {
    return new Point(coordinates[0], coordinates[1]);
  }

  pointLength() {
    return 2;
  }

  pointDistance(origin, distant) {
    const lat1 = (Math.PI * origin.latitude) / 180;
    const lat2 = (Math.PI * distant.latitude) / 180;
    const theta = (Math.PI * (distant.longitude - origin.longitude)) / 180;
    let dist = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(theta);
    dist = Math.max(-1, Math.min(dist, 1));
    dist = Math.acos(dist);
    dist = (dist * 180) / Math.PI;
    dist *= 60 * 1.1515 * 1.609344; // Convert to kilometers
    return dist;
  }

  pointDirection(origin, distant) {
    const lat1 = (origin.latitude * Math.PI) / 180;
    const lat2 = (distant.latitude * Math.PI) / 180;
    const deltaLong = ((distant.longitude - origin.longitude) * Math.PI) / 180;
    const y = Math.sin(deltaLong) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLong);
    const bearing = (Math.atan2(y, x) * 180) / Math.PI;
    return (bearing + 360) % 360; // Normalize to 0-360 degrees
  }

  newSegment(coordinates) {
    return new Segment(coordinates[0], coordinates[1], coordinates[2], coordinates[3]);
  }

  rootSegment() {
    return this._rootSegment;
  }

  segmentLength() {
    return 4;
  }

  segmentDistance(point, segment) {
    const loc = this.segmentLocation(point, segment);
    if (loc === -1) {
      return this.pointDistance(
        point,
        new Point(-point.latitude, ((point.longitude + 360) % 360) - 180),
      );
    }

    // cos(latitude) is nonnegative, so first maximize cos(delta longitude).
    const longitude = this._normalizeLng(point.longitude);
    const west = this._normalizeLng(segment.west);
    const east = this._normalizeLng(segment.east);
    const withinLongitude = segment.east - segment.west >= 360 ||
      (west <= east ? longitude >= west && longitude <= east : longitude >= west || longitude <= east);
    if (withinLongitude && point.latitude >= segment.south && point.latitude <= segment.north) {
      return 0;
    }
    const radians = Math.PI / 180;
    const nearestLongitude = withinLongitude ? longitude :
      Math.cos((west - longitude) * radians) >= Math.cos((east - longitude) * radians) ? west : east;

    // On that meridian the dot product is a*sin(latitude) + b*cos(latitude).
    // Its maximum is at an endpoint or atan2(a,b), if that latitude is in range.
    const a = Math.sin(point.latitude * radians);
    const b = Math.cos(point.latitude * radians) * Math.cos((nearestLongitude - longitude) * radians);
    const latitude = Math.atan2(a, b) / radians;
    let distance = Math.min(
      this.pointDistance(point, new Point(segment.south, nearestLongitude)),
      this.pointDistance(point, new Point(segment.north, nearestLongitude)),
    );
    if (latitude >= segment.south && latitude <= segment.north) {
      distance = Math.min(distance, this.pointDistance(point, new Point(latitude, nearestLongitude)));
    }
    return distance;
  }

  segmentDirection(point, segment) {
    const longitude = this._normalizeLng(point.longitude);
    const west = this._normalizeLng(segment.west);
    const east = this._normalizeLng(segment.east);
    const lonSpan = segment.east - segment.west;
    const fullWidth = lonSpan >= 360;
    const antiLon = this._normalizeLng(longitude + 180);

    // Unbounded when origin is at a pole, the zone touches a pole, spans >= 180 deg,
    // or contains either origin or its antipode (including on its boundary).
    const crossesOriginMeridian = this._lngInSegment(longitude, west, east, fullWidth);
    const crossesAntiMeridian = this._lngInSegment(antiLon, west, east, fullWidth);
    if (
      Math.abs(point.latitude) >= 90 - 1e-12 ||
      lonSpan >= 180 ||
      segment.north >= 90 - 1e-12 ||
      segment.south <= -90 + 1e-12 ||
      (crossesOriginMeridian && point.latitude >= segment.south && point.latitude <= segment.north) ||
      (crossesAntiMeridian && -point.latitude >= segment.south && -point.latitude <= segment.north)
    ) {
      return new Direction(0, 0, 0, 0, { unbounded: true });
    }

    const sw = this.pointDirection(point, new Point(segment.south, segment.west));
    const nw = this.pointDirection(point, new Point(segment.north, segment.west));
    const ne = this.pointDirection(point, new Point(segment.north, segment.east));
    const se = this.pointDirection(point, new Point(segment.south, segment.east));
    const bearings = [sw, nw, ne, se];

    // Along meridians bearing is monotonic in latitude; along parallels it can
    // have an interior extremum where the great circle is tangent to the parallel:
    // cos(deltaLon) = tan(lat1) / tan(lat2).
    const radians = Math.PI / 180;
    const tanOrigin = Math.tan(point.latitude * radians);
    for (const lat of [segment.south, segment.north]) {
      if (crossesOriginMeridian) {
        bearings.push(this.pointDirection(point, new Point(lat, longitude)));
      }
      if (crossesAntiMeridian) {
        bearings.push(this.pointDirection(point, new Point(lat, antiLon)));
      }
      const tanLat = Math.tan(lat * radians);
      if (tanLat !== 0) {
        const ratio = tanOrigin / tanLat;
        if (ratio >= -1 && ratio <= 1) {
          const dLon = Math.acos(ratio) / radians;
          for (const cand of [
            this._normalizeLng(longitude + dLon),
            this._normalizeLng(longitude - dLon),
          ]) {
            if (this._lngInSegment(cand, west, east, false)) {
              bearings.push(this.pointDirection(point, new Point(lat, cand)));
            }
          }
        }
      }
    }

    // Because lonSpan < 180 and neither origin nor antipode is in the zone,
    // either 180 deg or 0 deg is strictly forbidden inside the zone.
    const avoidsSouth =
      (crossesOriginMeridian && segment.south > point.latitude) ||
      (crossesAntiMeridian && segment.south > -point.latitude);
    let minA = Infinity;
    let maxA = -Infinity;
    for (const raw of bearings) {
      const a = avoidsSouth && raw > 180 ? raw - 360 : raw;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
    }

    const eps = 1e-9;
    const span = Math.min(360, maxA - minA + 2 * eps);
    const start = this._normAngle(minA - eps);
    return new Direction(sw, nw, ne, se, { start, span });
  }

  segmentCenter(segment) {
    return new Point((segment.south + segment.north) / 2, (segment.west + segment.east) / 2);
  }

  segmentExtension(segment, offset) {
    const latStep = offset * (segment.north - segment.south);
    const lngStep = offset * (segment.east - segment.west);

    if (lngStep * (2 + 1 / offset) > 360) {
      return new Segment(
        this._normalizeLat(segment.south - latStep),
        this._normalizeLat(segment.north + latStep),
        this._normalizeLng(-180),
        this._normalizeLng(180),
      );
    }
    return new Segment(
      this._normalizeLat(segment.south - latStep),
      this._normalizeLat(segment.north + latStep),
      this._normalizeLng(segment.west - lngStep),
      this._normalizeLng(segment.east + lngStep),
    );
  }

  segmentLocation(point, segment) {
    if (
      segment.south === this._rootSegment.south &&
      segment.west === this._rootSegment.west &&
      segment.north === this._rootSegment.north &&
      segment.east === this._rootSegment.east
    ) {
      return -1;
    }
    let location = 0;
    if (point.latitude > segment.south && point.latitude < segment.north) {
      location += 1;
    }
    if (point.longitude > segment.west && point.longitude < segment.east) {
      location += 2;
    }
    return location;
  }

  segmentsOverlap(segment1, segment2) {
    const aWest = this._normalizeLng(segment1.west);
    const aEast = this._normalizeLng(segment1.east);
    const bWest = this._normalizeLng(segment2.west);
    const bEast = this._normalizeLng(segment2.east);

    const wraps = (west, east) => west > east;

    const lngOverlap = (west1, east1, west2, east2) => {
      const wraps1 = wraps(west1, east1);
      const wraps2 = wraps(west2, east2);

      if (!wraps1 && !wraps2) {
        return west1 <= east2 && east1 >= west2;
      }

      if (wraps1) {
        return lngOverlap(west1, 180, west2, east2) || lngOverlap(-180, east1, west2, east2);
      }

      if (wraps2) {
        return lngOverlap(west1, east1, west2, 180) || lngOverlap(west1, east1, -180, east2);
      }

      return false;
    };

    const latOverlap = !(segment1.north < segment2.south || segment2.north < segment1.south);

    const doesOverlap = latOverlap && lngOverlap(aWest, aEast, bWest, bEast);

    if (!doesOverlap) {
      return { overlap: false, contained: false };
    }

    const latContained = segment1.south <= segment2.south && segment1.north >= segment2.north;

    const lngContained = (() => {
      const intervals = (west, east) =>
        wraps(west, east)
          ? [
              [west, 180],
              [-180, east],
            ]
          : [[west, east]];
      const outer = intervals(aWest, aEast);
      return intervals(bWest, bEast).every(([west, east]) =>
        outer.some(([lo, hi]) => lo <= west && hi >= east),
      );
    })();

    const isContained = latContained && lngContained;

    return {
      overlap: true,
      contained: isContained,
    };
  }

  newFilter(distance, direction) {
    return new Filter(distance[0], distance[1], direction[0], direction[1]);
  }

  // A zone lower bound can reject the outer radius, but cannot reject the inner one.
  filterDistance(filter, distance, lowerBound = false) {
    return (
      (lowerBound || filter.minDistance === 0 || distance >= filter.minDistance) &&
      (filter.maxDistance === 0 || distance <= filter.maxDistance)
    );
  }

  filterDirection(filter, direction) {
    if (filter.minAngle === filter.maxAngle) {
      return true;
    }
    const arc = direction?._arc;
    if (!arc || arc.unbounded) {
      return true;
    }
    const fStart = this._normAngle(filter.minAngle);
    const fSpan = this._normAngle(filter.maxAngle - filter.minAngle);
    if (fSpan === 0) {
      return true;
    }
    return (
      this._normAngle(fStart - arc.start) <= arc.span ||
      this._normAngle(arc.start - fStart) <= fSpan
    );
  }

  _lngInSegment(lng, west, east, fullWidth) {
    if (fullWidth) {
      return true;
    }
    return west <= east ? lng >= west && lng <= east : lng >= west || lng <= east;
  }

  _normAngle(deg) {
    return ((deg % 360) + 360) % 360;
  }

  _normalizeLat(lat) {
    if (lat > 90) {
      return 90;
    }
    if (lat < -90) {
      return -90;
    }
    return lat;
  }

  _normalizeLng(lng) {
    while (lng < -180) lng += 360;
    while (lng > 180) lng -= 360;
    return lng;
  }
}

export { Spherical };
