// Polygon-coverage WASM bridge.
//
// Loads the compiled module (map/wasm/polygonCovering.wasm, an Emscripten
// build without its JS glue) so the worker can ask "is this cell bounding box
// fully inside the loaded polygon?" synchronously. The walk uses this to stop
// its descent at fully covered nodes.
//
// Two-stage lifecycle:
//   1. `createPolygonWasm()` — async load; returns a runtime with
//      `loadGeojson()` and `isCovered()`.
//   2. `loadGeojson(geojson)` — call later (when the GeoJSON arrives
//      from the main thread). Until then `isCovered()` returns false,
//      which is safe (the walk just doesn't stop early).

const WASM_URL = new URL("../../wasm/polygonCovering.wasm", import.meta.url);

/**
 * The module's imports (minified by Emscripten): memcpy, a heap that cannot
 * grow, and the three WASI calls of printf, whose lines go to the console.
 */
function imports(memory) {
  const lines = [null, [], []];
  return {
    e: (dest, src, num) => memory().copyWithin(dest, src, src + num),
    c: () => {
      throw new WebAssembly.RuntimeError("Aborted(OOM)");
    },
    d: () => 52,
    b: () => 70,
    a: (fd, iov, iovcnt, pnum) => {
      const heap = memory();
      const words = new Uint32Array(heap.buffer);
      let written = 0;
      for (let i = 0; i < iovcnt; i++, iov += 8) {
        const ptr = words[iov >> 2];
        const len = words[(iov + 4) >> 2];
        for (let j = 0; j < len; j++) {
          const byte = heap[ptr + j];
          if (byte !== 0 && byte !== 10) {
            lines[fd].push(byte);
            continue;
          }
          const line = new TextDecoder().decode(Uint8Array.from(lines[fd]));
          (fd === 1 ? console.log : console.error)(line);
          lines[fd].length = 0;
        }
        written += len;
      }
      words[pnum >> 2] = written;
      return 0;
    },
  };
}

async function instantiate() {
  let exports = null;
  const memory = () => new Uint8Array(exports.f.buffer);
  const get = () => fetch(WASM_URL, { credentials: "same-origin" });
  let result;
  try {
    result = await WebAssembly.instantiateStreaming(get(), { a: imports(memory) });
  } catch {
    // A server that does not say application/wasm: compile from the bytes.
    const response = await get();
    if (!response.ok) throw new Error(`${response.status} : ${response.url}`);
    result = await WebAssembly.instantiate(await response.arrayBuffer(), { a: imports(memory) });
  }
  exports = result.instance.exports;
  exports.g(); // static constructors
  return {
    heap: memory,
    loadPolygon: exports.h,
    covers: exports.i,
    malloc: exports.j,
    free: exports.l,
  };
}

export async function createPolygonWasm() {
  const wasm = await instantiate();

  function allocateString(str) {
    const bytes = new TextEncoder().encode(str + "\0");
    const ptr = wasm.malloc(bytes.length);
    if (ptr === 0) throw new Error("WASM malloc failed (string)");
    wasm.heap().set(bytes, ptr);
    return ptr;
  }

  let polygonPtr = null;
  // `covers` is called once per visited cube cell. Keep one four-double
  // scratch allocation for the runtime lifetime instead of malloc/free per
  // cell, and one view on it (the heap never grows: its buffer stays).
  const boundsPtr = wasm.malloc(4 * Float64Array.BYTES_PER_ELEMENT);
  if (boundsPtr === 0) throw new Error("WASM malloc failed (bounds scratch)");
  const bounds = new Float64Array(wasm.heap().buffer, boundsPtr, 4);

  return {
    loadGeojson(geojson) {
      const str = typeof geojson === "string" ? geojson : JSON.stringify(geojson);
      const strPtr = allocateString(str);
      const ptr = wasm.loadPolygon(strPtr);
      wasm.free(strPtr);
      if (!ptr) return false;
      polygonPtr = ptr;
      return true;
    },

    // Cell shape: `{ bounds: [{ south, west, north, east }] }` — same
    // as the SDK's recursion node. Returns false until `loadGeojson`
    // succeeds.
    isCovered(cell) {
      if (polygonPtr === null) return false;
      const b = cell.bounds[0];
      bounds[0] = b.south;
      bounds[1] = b.west;
      bounds[2] = b.north;
      bounds[3] = b.east;
      return Boolean(wasm.covers(polygonPtr, boundsPtr));
    },
  };
}
