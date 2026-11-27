# SDK layers — contract

Status: contract. It mirrors the node's layers (`core/docs/protocol/`) so
that one word means one thing on both sides (glossary:
[core/docs/glossary.md](https://github.com/indexus/core/blob/main/docs/glossary.md)).
A layer imports only the layers above it in this list.

| # | Layer | Directory | Question it answers | May import |
|---|-------|-----------|---------------------|------------|
| 1 | tree  | `src/tree/`  | Where is it in the binary tree? | — |
| 2 | wire  | `src/wire/`, `src/api/`, `src/network/` | How do bytes reach us from a peer? | tree |
| 3 | store | `src/store/` | Which blocks do we hold, within which budget? | tree, wire (types only) |
| 4 | walk  | `src/walk/`  | In which order do we descend the tree? | tree, wire, store |
| 5 | gpu   | `src/gpu/`   | How do we compute and draw on the GPU? | tree, wire (types only) |
| 6 | edges | `src/map/`, `src/react/`, `src/index.js` | Who uses it? | everything above |

Beside the layers: `src/local/` (the nearest-records read, `Local`),
`src/runtime/` (thread-local factories, `GatewaySession`), `src/utilities/`
(debug, url64, shared reads).

Rules that hold from now on:

- Inside the SDK, imports are relative. Never `from "js-indexus-sdk"`.
- No collection-specific business logic (DVF, weather) below `edges`.
- `src/index.js`, `./map`, `./gpu`, `./react`, `./map/heat-worker`, `./store`
  keep every export they have until a change explicitly retires one; a
  move keeps a re-export at the old public name, never at an old internal
  path.

## 1. tree

The only home for the address algebra. Pure functions and small classes, no
I/O, no globals, no `Buffer` polyfill in new code (use `Uint8Array`).

```js
// src/tree/index.js — stable surface
export const ROOT;                 // "@"
export const ROUTING_ALPHABET;     // "0-9A-Za-z-_"  (node ids, zone keys, wire keys, Space cells)
export const BITS_PER_CHAR;        // 6
export function parent(location);           // "@" for depth 1, "" for root
export function isDirectChild(location, child);
export function zoneKey(collection, location);   // "collection/location", map keys only
export function zoneKeyID(collection, location); // Uint8Array, routing space
export function encodeFixed(bytes, length), decodeFixed(text);
export class Space;                // coordinates <-> location, bounds, xyz
export class Spherical, Linear;    // dimensions
export /* masks, offsets */;
export /* abelian* */;             // count + metric sums algebra
export class Item, Set, Collection;
```

`LOCATION_ALPHABET` remains exported under its old name from `src/index.js`.
There is one alphabet: `Space` writes the cell index of level `l` as
`ROUTING_ALPHABET[(cell + offset.at(l)) mod 64]`. A collection's offset is its
name read in that alphabet, repeated cyclically past the name's length, so it
is defined at every level up to `SETS_PRECISION` (32) and beyond. See
`core/docs/protocol/wire-block.md`, "Geometry".

## 2. wire

Everything between a peer and a decoded block: peers, routing table,
redirects, transports, the IXB2 decoder. The `Network` class stays here too.

```js
/**
 * One rows section of an IXB2 response. Views share the response buffer:
 * no per-row object, no copy.
 * @typedef {object} RowsBlock
 * @property {string} parent        requested zone ("" for the root)
 * @property {number} suffixChars   characters of every key below parent
 * @property {number} keyWords      u32 words per key
 * @property {number} metricCount   m
 * @property {number} revision      0 = unknown
 * @property {number} n             rows
 * @property {4|8} metricBytes      4, or 8 when the session asked metrics=f64
 * @property {Uint32Array} keys     n·keyWords, row-major
 * @property {Uint32Array} count    n
 * @property {Float32Array|Float64Array} metrics m·n, column-major (metric j at [j·n, j·n+n))
 */

/** @typedef {{location:string, name:string, ip:string, port:number}} Redirect */

// src/wire/block.js
export const BLOCK_CONTENT_TYPE = "application/vnd.indexus.block";
export function decodeBlocks(buffer) /* → {blocks: RowsBlock[], redirects: Redirect[]} */;
export function suffixAt(block, row)  /* → string; for tests and edges only */;
export function blocksToElements(collection, blocks) /* Item/Set shape for element reads */;
```

`/sets` is read as IXB2 only. An answer whose content type is not
`BLOCK_CONTENT_TYPE` is a read error. Elements built from blocks carry the
metrics the former element view carried (2 truncated, 3, 4; nothing at 0
and 1); the blocks keep every column.

`raw: true` hands the answers over as they arrived, for a caller
that keeps the blocks in the store:

```js
// api: one HTTP answer, always raw
getSets(protocol, peer, collection, locations)
  /* → {format: "block", buffer, blocks, redirects, ingress, bytes, rows} */
// Network: redirects followed, owners remembered, callers merged
network.getSets(collection, locations, {raw: true})
  /* → {format: "block", responses: RawAnswer[], empty: string[], unresolved: string[]} */
```

`buffer` is the whole body alone in its ArrayBuffer (transferable). Every
read is raw: one pool, one in-flight table. A raw read never enters
`network._cache`; an element read (no `raw`) builds Items and Sets from the
same answers once and caches them per zone. `format` is always `"block"`;
apps still check it. See `src/network/setsRaw.js` and `setsFetch.js`.

`/records` is asked for as IXRB version 2 (`format=binary`, `src/wire/records.js`);
a node that answers JSON is read as JSON. Either way records keep the JSON
answer's shape and a binary record's payload is a `Uint8Array` (a view on
the body), never a base64 string. Golden file shared with the node:
`src/api/testdata/records/` (core `indexus/testdata/records`).

## 3. store

One cache, keyed by zone, holding `RowsBlock`s as they arrived, with one byte
budget. Upper layers keep views, not copies.

`src/store` (public sub-path `./store`): `createBlockStore`, and the two ends
of the `BLOCKS` message, `sectionsOf` (worker) and `adoptBlocks` (main). API
in `docs/heat-pipeline.md` §(b), plus `drop(handles)` for the `DROP`
message and `entries()` to rebuild the GPU arena. A response buffer is
counted once and leaves as a whole.

## 4. walk

One descent of the tree with two policies: by distance (`Local`) and by
viewport overlap and depth (`walkViewport`, `src/walk/index.js`). Output: the
list of zones to show and the blocks that cover them. `createZoneIndex`
keeps per-zone summaries; `planMotion` decides the subdivision fades.
`src/walk/heat/` is the heat worker's core (reads, handles, plans, reconcile,
points, nearby search): it also builds the `Network` and a `Local`.
`map/workers/heat.worker.js` only runs it in a dedicated worker, with the
polygon covering of `map/wasm`.

## 5. gpu

```js
// src/gpu/cells.js
/**
 * Tables a kernel needs to turn wire keys into Space bounds. A wire key digit
 * r at level l is the Space cell (r - offset[l]) mod 64: one alphabet.
 * @returns {{
 *   coordinates: number,            // C, coordinates of the Space
 *   maxLevels: number,
 *   mask: Uint32Array,              // maxLevels·6: coordinate refined by bit n of level l
 *   offset: Uint32Array,            // maxLevels: Space offset of level l, in 0..63
 * }}
 */
export function spaceTables(space, maxLevels = 32);

/**
 * Bounds of a block's parent zone, computed on the CPU in float64 once per
 * block. The kernel only decodes the suffix, so float32 keeps its precision
 * at any depth.
 * @returns {Float64Array} 2·C (min, max per coordinate)
 */
export function parentBounds(space, parentLocation);
```

The first cells kernel (`projectRowsCPU`, `projectRowsGPU`: rows → bounds →
viewport culling) has no production caller since the pack kernel draws. It
lives in `src/gpu/project.testkit.mjs` as the real-GPU check of the shared
suffix decode (`scripts/gpu-check/cells-check`) and a perf reference.

Rules: one device per realm (`gpu/device.js`); no read-back between two GPU
stages; `mapAsync` only for what the CPU must actually read.

The other modules of `./gpu`: `arena.js` (a collection's blocks on the GPU),
`pack.js` (blocks → instances), `frame.js` (one submit per device and turn),
`field.js` and `combine.js` (see [compose.md](compose.md)), `raster.js` (a
field as a texture), `draw.js` (the heat of instances: mask, accumulation,
normalize; WGSL in `wgsl/draw.js`, mask geometry in `mask.js`), `copy.js`.
`map/visualization/AverageGridLayerWebGPU.js` puts `draw.js` on a MapLibre
map.

## Shared fixtures

`src/wire/testdata/` holds copies of `core/indexus/testdata/sets_block/`.
Changing one side without the other fails both test suites.
