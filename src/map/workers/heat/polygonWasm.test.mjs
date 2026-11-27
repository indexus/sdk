// The polygon-coverage bridge over the Emscripten module: a cell is covered
// when its box lies wholly inside the polygon (holes excluded). Node's fetch
// has no file: URLs, so the .wasm is read from disk here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function withFileFetch(body) {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("file:")) return fetch(url, init);
    const bytes = await readFile(fileURLToPath(String(url)));
    return new Response(bytes, { headers: { "content-type": "application/wasm" } });
  };
  try {
    await body();
  } finally {
    globalThis.fetch = fetch;
  }
}

const square = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
const cell = (south, west, north, east) => ({ bounds: [{ south, west, north, east }] });

test("isCovered: inside, outside, across the edge, in a hole; false before a polygon", async () => {
  await withFileFetch(async () => {
    const { createPolygonWasm } = await import("./polygonWasm.js");
    const polygon = await createPolygonWasm();
    assert.equal(polygon.isCovered(cell(1, 1, 2, 2)), false, "no polygon yet");
    // lng/lat: x is the longitude (west, east), y the latitude (south, north).
    const geojson = { type: "Polygon", coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] };
    assert.equal(polygon.loadGeojson(geojson), true);
    const cases = [
      [cell(1, 1, 2, 2), true],
      [cell(1, 11, 2, 12), false],
      [cell(8, 8, 12, 12), false],
      [cell(4.5, 4.5, 5.5, 5.5), false],
      [cell(1, 1, 3, 9), true],
    ];
    // Repeated and interleaved: the scratch bounds are rewritten every call.
    for (let round = 0; round < 50; round++) {
      for (const [box, covered] of cases) assert.equal(polygon.isCovered(box), covered);
    }
    assert.equal(polygon.loadGeojson(JSON.stringify(geojson)), true, "a string is accepted");
    assert.equal(polygon.isCovered(cell(1, 1, 2, 2)), true);
  });
});
