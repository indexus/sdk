// The mask's Mercator projection is maplibre's MercatorCoordinate.fromLngLat,
// to the double: values below were printed by maplibre-gl 6.18.0.
import test from "node:test";
import assert from "node:assert/strict";

import { buildMaskGeometry } from "./mask.js";

const MAPLIBRE = [
  [2.35, 48.86, 0.5065277777777778, 0.3440140481399792],
  [-180, 0, 0, 0.5],
  [180, 85.051129, 1, -7.090199558332541e-9],
  [0, -89.9, 0.5, 1.6210808913590486],
  [-73.98, 40.75, 0.2945, 0.37584443444886306],
  [139.69, 35.69, 0.8880277777777777, 0.39374803518567136],
];

const polygon = (ring) => ({ features: [{ geometry: { type: "Polygon", coordinates: [ring] } }] });

test("vertices are maplibre's Mercator coordinates", () => {
  const ring = MAPLIBRE.map(([lng, lat]) => [lng, lat]);
  const { vertices } = buildMaskGeometry(polygon(ring));
  assert.deepEqual(
    vertices,
    MAPLIBRE.flatMap(([, , x, y]) => [x, y]),
  );
});

test("an invalid position throws maplibre's LngLat error", () => {
  assert.throws(
    () =>
      buildMaskGeometry(
        polygon([
          [0, 91],
          [1, 0],
          [2, 2],
        ]),
      ),
    { message: "Invalid LngLat latitude value: must be between -90 and 90" },
  );
  assert.throws(
    () =>
      buildMaskGeometry(
        polygon([
          ["x", 0],
          [1, 0],
          [2, 2],
        ]),
      ),
    {
      message: "Invalid LngLat object: (NaN, 0)",
    },
  );
});
