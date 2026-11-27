import test from "node:test";
import assert from "node:assert/strict";
import { Spherical } from "./spherical.js";

test("spherical distances remain finite at antipodes despite roundoff", () => {
  const dimension = new Spherical("gps", [-90, 90, -180, 180]);
  for (const [lat, lng] of [[43.484986, -1.520707], [12.345, 67.89], [-53.2, -140.1]]) {
    const point = dimension.newPoint([lat, lng]);
    const opposite = dimension.newPoint([-lat, ((lng + 360) % 360) - 180]);
    const distance = dimension.pointDistance(point, opposite);
    assert.ok(Number.isFinite(distance), `${lat},${lng}: ${distance}`);
    assert.ok(Math.abs(distance - dimension.ratio()) < 0.001);
    assert.ok(Number.isFinite(dimension.segmentDistance(point, dimension.rootSegment())));
  }
});


test("a spherical zone bound does not exclude a closer point along its meridian", () => {
  const d = new Spherical("gps", [-90, 90, -180, 180]);
  const origin = d.newPoint([30, 0]);
  const zone = d.newSegment([22.5, 45, 45, 90]);
  const included = d.newPoint([39.2, 45.0001]);
  assert.ok(d.segmentDistance(origin, zone) <= d.pointDistance(origin, included));
});

test("spherical bounds include edges and longitude wrapping", () => {
  const d = new Spherical("gps", [-90, 90, -180, 180]);
  for (const [point, bounds] of [
    [[30, 45], [22.5, 45, 45, 90]],
    [[45, 67.5], [22.5, 45, 45, 90]],
    [[0, 179], [-10, 10, 170, -170]],
    [[0, -179], [-10, 10, 170, -170]],
    [[0, 181], [-10, 10, 170, -170]],
    [[90, 0], [80, 90, 45, 90]],
  ]) {
    assert.ok(d.segmentDistance(d.newPoint(point), d.newSegment(bounds)) < 0.001, `${point}: ${bounds}`);
  }
  // Local uses the root's covering distance to seed its first radius.
  assert.ok(Math.abs(d.segmentDistance(d.newPoint([30, 0]), d.rootSegment()) - d.ratio()) < 0.001);
});

test("spherical zone bounds stay below sampled contained point distances", () => {
  const d = new Spherical("gps", [-90, 90, -180, 180]);
  const zones = [
    [22.5, 45, 45, 90], [-80, -20, -150, -30], [80, 90, 40, 120],
    [-90, -80, -120, -40], [-10, 10, 170, -170], [-30, 40, -180, 180],
    [0, 5, -5, 5], [-20, 10, 140, 179],
  ];
  for (const [lat, lng] of [[30, 0], [-35, -100], [89.9, 179], [-89.9, -179], [0, 0], [0, 180]]) {
    const origin = d.newPoint([lat, lng]);
    for (const coordinates of zones) {
      const [south, north, west, east] = coordinates;
      const bound = d.segmentDistance(origin, d.newSegment(coordinates));
      const span = east >= west ? east - west : east + 360 - west;
      for (let y = 0; y <= 12; y++) for (let x = 0; x <= 12; x++) {
        const point = d.newPoint([south + (north - south) * y / 12, west + span * x / 12]);
        assert.ok(bound <= d.pointDistance(origin, point) + 0.000001,
          `${lat},${lng} -> ${coordinates}: bound ${bound}, point ${point.value()}`);
      }
    }
  }
});
