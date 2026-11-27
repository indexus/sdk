import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Spherical } from "./spherical.js";
import { Space } from "./space.js";
import { Mask } from "./mask.js";
import { Offset } from "./offset.js";

const norm360 = (deg) => ((deg % 360) + 360) % 360;

function angleInFilter(angle, minAngle, maxAngle) {
  if (minAngle === maxAngle) {
    return true;
  }
  const a = norm360(angle);
  const start = norm360(minAngle);
  const span = norm360(maxAngle - minAngle);
  if (span === 0) {
    return true;
  }
  return norm360(a - start) <= span;
}

describe("Spherical.segmentDirection and filterDirection soundness", () => {
  const spherical = new Spherical("gps", [-90, 90, -180, 180]);

  it("does not drop a zone straddling due North when filtered near 0 degrees", () => {
    const origin = spherical.newPoint([40, 0]);
    const segment = spherical.newSegment([45, 50, -5, 5]);
    const interior = spherical.newPoint([47, 0.5]);
    const bearing = spherical.pointDirection(origin, interior);
    assert.ok(bearing > 0 && bearing < 10, `expected interior bearing in (0,10), got ${bearing}`);

    const dir = spherical.segmentDirection(origin, segment);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [0, 10]), dir), true);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [355, 5]), dir), true);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [1, 5]), dir), true);
  });

  it("does not drop a zone whose parallel tangent bearing exceeds all four corners", () => {
    const origin = spherical.newPoint([30, 0]);
    const segment = spherical.newSegment([45, 60, 20, 80]);
    const tangent = spherical.newPoint([45, 54.735610317245346]);
    const tangentBearing = spherical.pointDirection(origin, tangent);
    const cornerBearings = segment.points().map((p) => spherical.pointDirection(origin, p));
    assert.ok(
      tangentBearing > Math.max(...cornerBearings) + 2,
      `expected tangent bearing ${tangentBearing} > max corner ${Math.max(...cornerBearings)}`,
    );

    const dir = spherical.segmentDirection(origin, segment);
    const filter = spherical.newFilter([0, 0], [52, 56]);
    assert.equal(angleInFilter(tangentBearing, 52, 56), true);
    assert.equal(spherical.filterDirection(filter, dir), true);
  });

  it("treats origin on segment boundary as unbounded in bearing", () => {
    const origin = spherical.newPoint([45, 0]);
    const segment = spherical.newSegment([45, 50, 0, 5]);
    const dir = spherical.segmentDirection(origin, segment);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [80, 100]), dir), true);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [355, 5]), dir), true);
  });

  it("treats a segment containing the antipode as unbounded in bearing", () => {
    const origin = spherical.newPoint([30, 0]);
    const segment = spherical.newSegment([-45, -22.5, 135, 180]);
    const dir = spherical.segmentDirection(origin, segment);
    for (let a = 0; a < 360; a += 30) {
      assert.equal(
        spherical.filterDirection(spherical.newFilter([0, 0], [a, (a + 10) % 360]), dir),
        true,
      );
    }
  });

  it("still prunes zones strictly outside the angular sector", () => {
    const origin = spherical.newPoint([40, 0]);
    const segment = spherical.newSegment([45, 50, 10, 15]);
    const dir = spherical.segmentDirection(origin, segment);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [180, 270]), dir), false);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [300, 350]), dir), false);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [45, 60]), dir), true);
  });

  it("does not misclassify a due-North point (bearing 0) as unbounded", () => {
    const origin = spherical.newPoint([40, 0]);
    const dueNorth = spherical.newSegment([45, 45, 0, 0]);
    const dir = spherical.segmentDirection(origin, dueNorth);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [170, 190]), dir), false);
    assert.equal(spherical.filterDirection(spherical.newFilter([0, 0], [350, 10]), dir), true);
  });

  it("has zero false negatives across 20,000 seeded random zones and points", () => {
    const space = new Space([spherical], new Mask([0, 1, 0, 1, 0, 1]), new Offset([[0]]));
    let state = 0x5f3759df;
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };

    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-";
    let checked = 0;
    for (let i = 0; i < 20000; i++) {
      const origin = spherical.newPoint([rand() * 178 - 89, rand() * 360 - 180]);
      const depth = Math.floor(rand() * 7);
      let hash = "";
      for (let d = 0; d < depth; d++) {
        hash += alphabet[Math.floor(rand() * alphabet.length)];
      }
      const [segment] = space.decode(hash);
      const ptLat = segment.south + rand() * (segment.north - segment.south);
      const ptLon = segment.west + rand() * (segment.east - segment.west);
      const pt = spherical.newPoint([ptLat, ptLon]);
      const bearing = spherical.pointDirection(origin, pt);

      // Build a tight angular filter around `bearing` (including wraparound across 0/360).
      const half = 0.5 + rand() * 15;
      const minAngle = norm360(bearing - half);
      const maxAngle = norm360(bearing + half);
      const filter = spherical.newFilter([0, 0], [minAngle, maxAngle]);
      const dir = spherical.segmentDirection(origin, segment);

      assert.equal(
        spherical.filterDirection(filter, dir),
        true,
        `false negative at i=${i}: origin=${origin.print()} segment=${segment.print()} pt=${pt.print()} bearing=${bearing} filter=[${minAngle}, ${maxAngle}]`,
      );
      checked++;
    }
    assert.equal(checked, 20000);
  });
});
