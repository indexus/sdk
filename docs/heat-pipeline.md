# Heat pipeline — contract

Status: contract of the aggregated map (dashboard heatmap, Explore's real
estate and weather layers): how it reads blocks from the network and draws
them on the GPU. The former CPU pipeline was removed; its outputs on the
walk fixtures are frozen in `src/walk/testdata/v1-reference.json` and the
walk is tested against them.

## Decisions

1. Blocks are served and read as IXB2 by default (`core/docs/protocol/wire-block.md`).
2. One alphabet (routing) for geometry and routing.
3. Child virtualisation is kept in a **generic** form: an item's key is its
   full address in the tree, so items can always be grouped by prefix at any
   depth below their zone.
4. Subdivision motion is decided **per zone** (all cells of a zone that
   subdivides move together), to be checked in the browser.
5. Without WebGPU, the map shows a clear message instead of the heatmap. No
   fallback renderer.
6. The store keeps a CPU copy of every block (default budget 256 MiB) so the
   GPU arena can be rebuilt after a device loss without the network.
7. DVF leaves the SDK: apps pass generic `heat` rules and a `summarize`
   callback, and the meaning of their metrics: the palette (built with
   `rgbRamp`), its top (`normalizer`, default 1), the centroid's columns
   (`cellPosition`, default the cell's centre) and the column a point shows
   (`valueMetricIndex`, default 0).

Words: a **zone** is a node of the tree (a location such as `7a`), delivered
as one block. A **cell** is one square drawn on the map; a zone yields up to 64
cells one character below it, more below that.

## Realms

```
worker (heat.worker.js)                    main thread
-----------------------                    -----------
network: /sets?format=block                store: ArrayBuffers as they arrived
decodeBlocks (headers only)                  (CPU copy, budget, LRU, pins)
zoneIndex.ingest  (one pass per block,     GPU arena: one writeBuffer per block
  TypedArrays only)                        pack kernel  → instances (14 floats)
walkViewport → PLAN                        existing 3-pass renderer
transfer block buffers ──── BLOCKS ────▶   composite into MapLibre
                     ◀── STORE_EVICTED ──
                     ──── PLAN ─────────▶
```

GPU buffers live in one realm; the renderer's device is on the main thread
(MapLibre composites there with the frame's matrix), so the arena and the
kernels are on the main thread. Transferred buffers leave the worker, so the
byte store is on the main thread too; the worker keeps only per-zone
summaries.

Files: the worker is `walk/heat/worker.js` (run by `map/workers/heat.worker.js`);
on the main thread, `map/heat/pipeline.js` takes its messages and times the
fades, and `gpu/plans.js` holds the arena, the packs and the combine.

## (a) Messages worker ↔ main

Unchanged: `MOVE`, `SET_*`, `SET_VISIBILITY`, `SEARCH`, `STATS`, `RECONCILE`,
`CLEAR_SETS_CACHE`, `FORGET_PEER`, `TRANSITION_COMPLETE`, `VIEWPORT`.

- A node that does not answer IXB2 is a read error: its zones are retried
  later and nothing is drawn from it.
- worker → main `BLOCKS {buffer /*transferred*/, sections: [{handle, zone,
  offset, byteLength}]}`. `handle` is a u32 allocated by the worker.
- worker → main `PLAN {snapshotVersion, previousCenterDepth, dataDriven,
  emptyConfirmed, plan /* the walk's Plan, see (b); its typed arrays are
  transferred */, motion /* planMotion's result */, previousEntries /* the
  last plan's entries, with their leave flags */, ...viewportPayload stats}`,
  plus `pointsBuffer` as today. `heat` and `position` are known to the main
  thread (app options), not sent per plan.
- worker → main `DROP {handles}`: blocks replaced by a reconcile.
- main → worker `STORE_EVICTED {handles}`: evicted by budget (never a handle
  pinned by the last PLAN); the walk marks the zone missing and asks again.

## (b) JavaScript API

```js
// src/store/index.js — main thread; imports tree and wire types only
createBlockStore({budgetBytes = 256 << 20}) → {
  put(handle, zone, rowsBlock), get(handle), has(handle),
  pin(handles), evict() /* → evicted handles, LRU, never pinned */,
  bytes, clear(),
}

// src/walk/index.js — worker; pure, testable in Node
createZoneIndex(space) → { ingest(zone, handles, rowsBlocks) → ZoneSummary,
                           drop(handles), get(zone), metricCount }
walkViewport(index, {zoom, resolution, bounds, strictBounds, limit, children,
  isCovered, parentFallbackDepth, virtualize, nudgeAnchors, statsZoom}) → Plan
planMotion(previousPlan, plan) → {entered, left, previousDepth, currentDepth}
  // sets FLAG_ENTER on plan.entries, FLAG_LEAVE on previousPlan.entries
// src/walk/pack.testkit.mjs — the CPU reference, for tests and checks only
planToInstancesCPU(plan, store, heat, position) → {data, count}  // THE reference
transitionToInstancesCPU(plan, current, previousPlan, previous, motion)
  // reference of a transition pair (writeSnapshotPair with zone markers)

// src/gpu — main thread
createArena(device, {budgetBytes}) → { put(handle, rowsBlock, origin),
  drop(handle), has(handle), info(handle), rebuild(store, device),
  table, buffers: {keys, count, metrics}, generation, bytes, destroy() }
await createPackKernel(device) → { encode(encoder, {arena, tables, plan, heat,
  position, output, transition}) → {currentCount, instanceCount}, destroy() }
createInstanceBuffer(device, instances)     // gpu/pack.js
frameOf(device) → { add(owner, record, stage), after(fn), submit() }  // gpu/frame.js
compose({fields, expression})               // map/heat/compose.js, docs/compose.md
packEntriesF32({blocks, tables, plan, heat, position, transition})
  // gpu/pack.testkit.mjs: the kernel run in JS, float32
```

`ZoneSummary`: count, metric sums, and per first-character child
`{count, metricSums, row range, itemCount}` — the old `consolidate`, without a
per-row object.

The walk reproduces the former CPU pipeline's `Cube.retrieve` (frozen in `walk/testdata/v1-reference.json`) on its **binary**
tree: inside one character the Space refines every coordinate `step` times
(3 for a 2-coordinate Space), and each of those levels is a tier of the
heatmap. It stops at the target resolution; when covered (`isCovered`) and
`count <= limit` or fewer than `children` children; when children are
incomplete (sum of child counts ≠ zone count) — that is the parent fallback,
drawn at the zone's own resolution in the finer slot.

### Plan

`walkViewport` returns, and `PLAN` carries:

| Field | Type | Meaning |
|-------|------|---------|
| `entries` | `Uint32Array`, 8 words each | see (c) |
| `capacity` | number | outputs = instances of the current target |
| `parents` | `Int32Array(capacity)` | per output: its row in `anchors`, or -1 (the cell is its own anchor; virtual bins anchor on their enclosing bin) |
| `anchors`, `anchorStride` | `Float64Array` | per anchor: count, metric length, metric sums of the parent cell, from the zone summaries |
| `metricCount`, `step` | numbers | metrics of the index; binary levels per character |
| `strictView` | `Float64Array(4)` or null | [south, north, west, east] for the anchor nudge |
| `centerDepth`, `cameraDepth` | numbers | tiers drawn: `centerDepth - 1 .. + 1` |
| `zones`, `entryZone` | `string[]`, `Uint32Array` | owner zone per entry (motion) |
| `pinned`, `missing`, `stats`, `signature` | | store pins, zones to fetch, viewport summary, plan identity |

Resolutions (`targetResolution`, `slot`, `centerDepth`) count binary levels
per coordinate — the former Cube's resolution — not characters: a zone of depth `d`
is at resolution `d · step`.

Entries are emitted grouped by output: the entries that share an `outBase`
are contiguous. The kernel checks it and refuses a plan that is not.

## (c) GPU layouts

- **Arena**: three STORAGE buffers (`keys` u32, `count` u32, `metrics` f32),
  sub-allocated per block (bump pointer; GPU→GPU compaction or growth when a
  put does not fit). 8-byte metrics are rounded to f32 on put.
- **blockTable** (STORAGE), 48 bytes per handle: `keysOff, countOff,
  metricsOff, n, keyWords, suffixChars, metricCount, depth` (8 × u32, offsets
  in elements), then `origin: vec4f` (`parentBounds` rounded to f32: south,
  north, west, east). Handles index it directly: allocate them densely.
- **entries**, 32 bytes: `handle, firstRow, rowCount, slot (i32),
  targetResolution, flags, outBase, binCapacity`. Flags: bit 0 enter, bit 1
  leave, bit 2 anchor nudge, bit 3 virtual.
  - A **plain** entry (`binCapacity = 1`) is one run of rows of one cell,
    output `outBase`. A cell whose rows are not contiguous, or sit in several
    blocks, has several entries with the same `outBase`: they add up.
  - A **virtual** entry (bit 3) holds the rows of one first character and
    owns `binCapacity = 2^(bits - 6)` outputs, where `bits = (targetResolution
    - depth · step) · size` are the geometric bits of a cell below the block's
    parent. Bin `b` is output `outBase + b`: the geometric bits [6, bits) of
    the row's key. Bins no row reaches stay all zero (the renderer drops a
    zero denominator). The anchor of bin `b` is the enclosing bin `b >> size`.
- **Why no prefix scan**: rows are sorted by *routing* digit, and the cell of
  a digit `r` at level `l` is `(r - offset[l]) mod 64`. Below a character,
  tiers cut the *geometric* bits, so "same prefix as the previous row" only
  groups whole characters. But the offset is a rotation: a range of geometric
  digits is one or two ranges of routing digits. The rows of a bin are
  therefore at most two runs, found by binary search on the sorted keys, and
  the rows of a plain cell are the runs the walk lists.
- **Kernel** (`gpu/pack.js`): one workgroup of 64 lanes per output. Each lane
  sums count and the metrics the rules read over its share of every run, the
  lanes fold as a tree (no float atomics), lane 0 writes the instance. A
  first pass (`reduceParents`, metric positions with virtual entries only)
  reduces each enclosing bin once, in the workgroup of its first child.
- **Plan buffer** (STORAGE, written once per pack): Space tables (mask,
  offset), entries, per output `(first entry, entry count)`, `parents`,
  anchors as 4 × f32 `(count, has lat/lng, lat sum, lng sum)`, then the
  previous plan's entries for the leave markers.
- **Uniform `Params`** (176 bytes): 3 rules × `{num: i32 (-1 = count), den:
  i32, minDen: f32, transform: u32}` and their 3 shifts; strict view `vec4f`; `positionMode,
  latIndex, lngIndex, metricScale`, lat/lng offsets; `step`, `size`,
  `capacity`; offsets into the plan buffer; transition depths and counts;
  `fieldRows`, `zoneCellsAt` (the field of the plan, see `docs/compose.md`).
- **Heat rules** (generic, decision 7): the first rule with `num > 0` and
  `den > minDen` gives `(num, den)`, or `(log1p(num), 1)` with `transform` 1;
  no rule gives `(0, 0)`. A metric no block of the cell has reads 0. DVF is
  `[{num: 0, den: 1, minDen: 1e-6}, {num: 2, den: -1}, {num: -1, den: -1,
  transform: 1}]`. A rule's `shift` (transform 0) gives `(num − shift·den,
  den)`: the value minus a constant, for a positive sum such as kelvin·km²
  drawn in °C. A weather variable is one collection, metric 0 the area and
  metric 1 + h the value × area of hour h: the hour is the rule's column
  (`[{num: 1 + h, den: 0, shift: 273.15}]`).
- **Two snapshots of the same cells** (`previousHeat`, `setHeat(next,
  previous)`): the plan is packed twice in one frame, the previous rules as
  the previous half of a transition with no motion, and outside a fade the
  renderer shows `mix(previous, current, setBlend(t))`. An animation between
  hours is a repaint, not a pack.
- **Region sums** (`stats({zoom, bounds})`, worker `STATS`): count and
  metric sums of a region from the zones the worker holds, as the viewport
  stats, without a read. `sums({bounds, columns, maxZones})` (worker `SUMS`)
  reads the zones that cover a region (at most `maxZones`) with their own
  columns and weights their rows by the fraction inside: every hour of a
  weather variable for a whole view, the drawn blocks untouched.
- **Columns** (`controller.setColumns([0, 13, 14])`, worker `SET_COLUMNS`,
  INIT `columns`): the worker reads `/sets?columns=` (core wire-block.md,
  section kind 3); the blocks hold those metrics only and the heat rules
  name positions in the list. A change re-reads the zones held, replaces
  their blocks, and plans only once every zone has the new columns. The
  network carries them in its `metrics` read option: `"f32;0,13,14"`.
  `setColumns(columns, {heat, previousHeat})` hands the rules of the new
  columns with them: they replace the rules with the first plan of the new
  blocks (the plan carries the `columnsVersion` of its SET_COLUMNS), never
  before, so no pack mixes two column sets; `controller.rulesPending()`
  says whether they still wait.
- **Plans without fades** (`createHeatmapPipeline({fades: false})`, INIT
  `completePlans: true`): for a field drawn as the pre-E weather was. A new
  plan replaces the one on screen at once (no 400 ms cross-fade; a pair is
  always drawn, so an hour blend never stops), the renderer's three tiers
  around the camera keep the image continuous, and the worker sends no plan
  of a view half read: while reads are in flight the plan on screen stays
  (at most 2.5 s, then it is sent as it is).
- **Coverage weights** (layer effect `coverage: true`): n and d of a cell
  are sums over its zone's area (d in km², a weather field): the
  accumulation divides both by the zone's own area, so each level weighs as
  a cell of weight 1 does in the tier blend, a coastal zone by its land
  share, and the sums stay small in `rgba16float`.
- **Field raster** (`gpu/raster.js`, `createFieldRaster(device, {size})`):
  for passes that sample a field at a pixel rather than draw cells (a
  weather effect). `encode(encoder, {packed, rect})` draws a pipeline's
  instance buffer, cell by cell, into an `rgba16float` texture over a
  Mercator rectangle: R the current mean `n/d`, G the previous one (the
  other half of a pair or a fade), B and A their coverage. All on the GPU;
  checked texel by texel in `scripts/gpu-check/raster-check.html`.
- **Position**: `{mode: "bounds" | "metrics", latIndex, lngIndex,
  metricScale, latOffset, lngOffset}`; a mean above 10 000 is scaled by
  metricScale, and the cell centre is the fallback.
- **Output**: `instances` `VERTEX|STORAGE|COPY_SRC|COPY_DST`, 14 floats per
  instance, layout unchanged (`gpu/draw.js`, `wgsl/draw.js`);
  `[10]` is the cell's resolution, `[11]` the entry's `slot`. A steady target
  has `[4..7] = [0..3]` and `[12..13] = [8..9]`.
- **Transition** (`encode(..., {transition: {previous: {buffer, count},
  previousEntries, previousDepth, currentDepth}})`, after `planMotion`): the
  output is `writeSnapshotPair`'s. Current half `[0, capacity)`: `[12..13] =
  0`, or `(resolution, -1)` for the outputs of `FLAG_ENTER` entries. Previous
  half `[capacity, capacity + count)`: the last target, copied with
  `copyBufferToBuffer` before the pack overwrites it, then shifted: `[4..7] =
  [0..3]`, `[12..13] =` its `[8..9]`, `[8..9] = 0`, or `(-previousDepth,
  -currentDepth)` for the outputs of the previous plan's `FLAG_LEAVE` entries.
  Markers are per zone (decision 4): a superset of v1's per-cell markers,
  identical where a zone is one cell. The shift only reads `[0..3]` and
  `[8..11]`, so the current half of any output is a valid previous target.
- One `encode` per `submit` (the uniform and the plan buffer are written with
  `queue.writeBuffer`). The pipeline adds its pack to the device's frame
  (`gpu/frame.js`), which encodes one recorder per owner and submits once per
  turn. `mapAsync` only in `readBackInstancesForCheck`.
- **Field** (optional, `encode(..., {field: {buffer, cellOf}})`): `writeOutputs`
  also writes one row per output — its Cell and `(num, den)` — and
  `indexField` hashes the rows; `docs/compose.md` has the layout. With it
  `writeOutputs` binds 8 storage buffers, the default limit of a stage.
- **Indirect** (reserved): 16 bytes `{6, instanceCount, 0, 0}`.
- The suffix decode WGSL (`gpu/wgsl/suffix.js`, by bits) is shared with
  `gpu/cells.js` as one fragment.
- **References and checks**: `walk/pack.testkit.mjs` matches the frozen v1 output
  (`walk/reference.test.mjs`); the same scenarios compare it with
  `packEntriesF32` (`gpu/pack.testkit.mjs`) output by output.
  `scripts/gpu-check/dist/pack-check.html` compares a real GPU with both, on
  walk plans. Pages are built by `scripts/gpu-check/build-*.mjs` and not
  committed.

## (d) Public map API

- `getPackedData()` returns either `{count, data: Float32Array, ...}` (instances
  packed on the CPU) or `{count, gpuBuffer, version, centerDepth, previousCenterDepth,
  snapshotVersion}`. With `gpuBuffer` the layer does not `writeBuffer`.
- `useHeatmap(...)` (`js-indexus-sdk/react`; `useGridWorker` is a deprecated
  alias of it): same signature and controller, plus options `heat` and
  `summarize(totalCount, metricSums)` → `stats.summary`.
- `createHeatmapPipeline({worker, device, heat, summarize, ...})` from
  `js-indexus-sdk/map`: the common base of `useHeatmap` and of
  experiences' real estate page.
- Without WebGPU: the layer reports `unsupported`; apps show a message.
- Device loss: the layer releases its resources and rebuilds from the store
  on the next `getGPUContext()`.
