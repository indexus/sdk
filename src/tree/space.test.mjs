// Space addresses: one alphabet with the router, and an offset defined at
// every level a location can reach (SETS_PRECISION = 32).
import assert from "node:assert/strict";
import { test } from "node:test";

import { Collection, Space, ROUTING_ALPHABET, ROOT } from "./index.js";
import { Offset } from "./offset.js";

const PRECISION = 32;

const DEFINITIONS = {
  spherical: [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }],
  linear: [{ name: "time", type: "linear", args: [631152000000, 4102444800000] }],
};

// Short names run out of offset after a few levels; the 16-char names are the
// width of a node id.
const NAMES = ["x", "dvf", "ScenaroChrono01", "DvFMV2020idx0001"];

function spaceOf(name, kind) {
  const collection = new Collection(name, DEFINITIONS[kind]);
  return new Space(collection.dimensions(), collection.mask(), collection.offset());
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomPoint(space, random) {
  return space.dimensions.map((dimension) => {
    const root = dimension.rootSegment().value();
    const values = [];
    for (let i = 0; i < root.length; i += 2) {
      values.push(root[i] + (root[i + 1] - root[i]) * random());
    }
    return dimension.newPoint(values);
  });
}

function flat(segments) {
  return segments.flatMap((segment) => segment.value());
}

function contains(bounds, coordinates) {
  return coordinates.every((value, i) => bounds[2 * i] <= value && value <= bounds[2 * i + 1]);
}

// A cell float64 can still split: its centre lies strictly inside it.
function splittable(bounds) {
  for (let i = 0; i < bounds.length; i += 2) {
    const centre = (bounds[i] + bounds[i + 1]) / 2;
    if (!(bounds[i] < centre && centre < bounds[i + 1])) {
      return false;
    }
  }
  return true;
}

test("Offset.at repeats the details cyclically, and an empty offset shifts nothing", () => {
  const offset = new Offset([[5, 7, 11]]);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, l) => offset.at(l)),
    [5, 7, 11, 5, 7, 11, 5, 7],
  );
  assert.equal(new Offset([[]]).at(3), 0);
});

test("a collection offset is its name in the routing alphabet, repeated to every level", () => {
  const collection = new Collection("dvf", DEFINITIONS.spherical);
  const name = ["d", "v", "f"].map((ch) => ROUTING_ALPHABET.indexOf(ch));
  for (let l = 0; l < PRECISION; l++) {
    assert.equal(collection.offset().at(l), name[l % 3], `level ${l}`);
  }
});

for (const kind of Object.keys(DEFINITIONS)) {
  for (const name of NAMES) {
    test(`${kind} ${name}: encode -> decode round trip at every depth 0..${PRECISION}`, () => {
      const space = spaceOf(name, kind);
      const random = seededRandom(name.length * 31 + kind.length);
      let exactDepth = 0;
      for (let trial = 0; trial < 20; trial++) {
        const point = randomPoint(space, random);
        const coordinates = point.flatMap((p) => p.value());
        const deepest = space.encode(point, PRECISION);
        assert.equal(deepest.length, PRECISION);
        for (let depth = 0; depth <= PRECISION; depth++) {
          const location = space.encode(point, depth);
          assert.equal(
            location,
            depth === 0 ? ROOT : deepest.slice(0, depth),
            `depth ${depth}: prefix of the deeper location`,
          );
          assert.ok(
            [...location].every((ch) => ROUTING_ALPHABET.includes(ch) || location === ROOT),
          );
          const bounds = flat(space.decode(location));
          assert.ok(
            contains(bounds, coordinates),
            `${name} depth ${depth}: ${location} holds the point`,
          );
          if (splittable(bounds)) {
            // Exact in both directions while float64 resolves the cell.
            assert.equal(
              space.encode(space.center(space.decode(location)), depth),
              location,
              `${name} depth ${depth}`,
            );
            exactDepth = Math.max(exactDepth, depth);
          }
        }
      }
      // Spherical splits each coordinate 3 bits per level, Linear 6: float64
      // stops resolving cells near level 17 and 8. Past the name's length the
      // offset must keep working as well as before it.
      assert.ok(exactDepth >= (kind === "spherical" ? 16 : 8), `exact up to depth ${exactDepth}`);
    });
  }
}

test("past the name's length a location still follows the point", () => {
  // The offset used to stop at the name: every deeper level encoded the same
  // character whatever the point, and decoded as the lowest cell.
  const space = spaceOf("dvf", "spherical");
  const random = seededRandom(9);
  const characters = new globalThis.Set();
  for (let trial = 0; trial < 200; trial++) {
    characters.add(space.encode(randomPoint(space, random), 6)[5]);
  }
  assert.ok(characters.size > 32, `${characters.size} distinct characters at level 5`);
});

test("random locations decode and re-encode to themselves while float64 resolves them", () => {
  const random = seededRandom(3);
  for (const kind of Object.keys(DEFINITIONS)) {
    for (const name of NAMES) {
      const space = spaceOf(name, kind);
      const maxDepth = kind === "spherical" ? 16 : 8;
      for (let trial = 0; trial < 50; trial++) {
        const depth = 1 + Math.floor(random() * maxDepth);
        const location = Array.from(
          { length: depth },
          () => ROUTING_ALPHABET[Math.floor(random() * 64)],
        ).join("");
        assert.equal(
          space.encode(space.center(space.decode(location)), depth),
          location,
          `${kind} ${name} ${location}`,
        );
        if (depth > maxDepth - 4) {
          continue;
        }
        // xyz -> bounds is another float64 path: equal to a hundredth of a cell
        // while the cells stay well above float64 resolution.
        const decoded = flat(space.decode(location));
        flat(space.bounds(space.xyz(location))).forEach((value, i) => {
          const cell = decoded[i | 1] - decoded[i & ~1];
          assert.ok(
            Math.abs(value - decoded[i]) <= cell / 100,
            `${kind} ${name} ${location} bound ${i}`,
          );
        });
      }
    }
  }
});

// Pins the addressing: a change here re-addresses every stored record and
// needs a data migration (archives/sdk-js/docs/alphabet-migration.md).
test("golden locations of the single alphabet", () => {
  const paris = (space) => [space.dimension(0).newPoint([48.8566, 2.3522])];
  const dvf = spaceOf("DvFMV2020idx0001", "spherical");
  assert.equal(dvf.encode(paris(dvf), 16), GOLDEN.dvf16);
  assert.equal(dvf.encode(paris(dvf), 32), GOLDEN.dvf32);
  const short = spaceOf("dvf", "spherical");
  assert.equal(short.encode(paris(short), 8), GOLDEN.short8);
  const chrono = spaceOf("ScenaroChrono01", "linear");
  assert.equal(
    chrono.encode([chrono.dimension(0).newPoint([Date.UTC(2026, 10, 13)])], 10),
    GOLDEN.chrono10,
  );
});

const GOLDEN = {
  dvf16: "5xS4R2qq77xabVnr",
  // Past float64 resolution every level is cell 0, which encodes as the offset:
  // the name, repeated.
  dvf32: "5xS4R2qq77xabVnrrX3hV2020idx0001",
  short8: "VxsLrfRh",
  chrono10: "n2NEEer3Ir",
};
