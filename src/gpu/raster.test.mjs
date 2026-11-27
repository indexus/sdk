import test from "node:test";
import assert from "node:assert/strict";

import { mercatorRect } from "./raster.js";

// The raster's rectangle is MapLibre's MercatorCoordinate of the view's corners.
test("mercatorRect: west x, north y, east x, south y in Mercator units", () => {
  const [west, north, east, south] = mercatorRect([-180, -85.05, 180, 85.05]);
  assert.equal(west, 0);
  assert.equal(east, 1);
  assert.ok(Math.abs(north) < 1e-3 && Math.abs(south - 1) < 1e-3);
  const [, y] = mercatorRect([0, 0, 0, 0]);
  assert.ok(Math.abs(y - 0.5) < 1e-12, "the equator is y = 0.5");
  const [x0, y0, x1, y1] = mercatorRect([-1.53, 43.47, -1.51, 43.49]);
  assert.ok(x1 > x0 && y1 > y0, "north above south: y grows southward");
});
