// The cells-kernel input both perf suites time (Node: projectRowsCPU; the
// browser page: projectRowsGPU): one rows block of n random rows, two-char
// suffixes below a depth-4 parent of a geographic Space, viewed through a
// random window of that parent. Same seed, same job, in Node and in the page.
import { Space, Spherical } from "../../src/tree/index.js";
import { Mask } from "../../src/tree/mask.js";
import { Offset } from "../../src/tree/offset.js";
import { spaceTables, parentBounds } from "../../src/gpu/cells.js";
import { seededRandom, randomBlock, randomSuffix } from "../../src/gpu/cells.testkit.mjs";

export const CELLS_SEED = 20261113;

export function geoSpace() {
  const offset = new Offset([Array.from({ length: 32 }, (_, level) => (level * 37 + 5) % 64)]);
  return new Space([new Spherical("geo", [-90, 90, -180, 180])], new Mask([0, 1]), offset);
}

export function cellsJob(n, seed = CELLS_SEED) {
  const random = seededRandom(seed);
  const space = geoSpace();
  const tables = spaceTables(space);
  const depth = 4;
  const parent = randomSuffix(random, depth);
  const block = randomBlock(random, parent, n, 2, 2);
  const origin = parentBounds(space, parent);
  const min = new Float64Array(space.size);
  const max = new Float64Array(space.size);
  for (let axis = 0; axis < space.size; axis++) {
    const lo = origin[2 * axis];
    const extent = origin[2 * axis + 1] - lo;
    // A window over the middle of the parent: about half of the rows are kept.
    min[axis] = lo + extent * (0.1 + 0.2 * random());
    max[axis] = lo + extent * (0.7 + 0.2 * random());
  }
  return {
    block,
    tables,
    params: { origin, depth, view: { min, max }, numerator: 0, denominator: -1 },
  };
}
