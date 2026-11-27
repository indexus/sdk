# Compose — the GPU combines collections before display

Status: contract. Collections that share their
dimensions are joined cell by cell on the GPU and drawn as one heat layer.
Nothing is read back to the CPU. Checked in Node on the kernels' float32
emulation; `scripts/gpu-check/dist/compose-check.html` is the check on a real
GPU.

Words: a **Cell** is the geometric key of a cell — one integer per
coordinate and a resolution (binary levels per coordinate), the collection's
offset removed. A **field** is what one collection says of the cells of the
view: per cell, the `(num, den)` of its heat rules. The **value** of a field
at a cell is `num / den`.

## Design

```
per collection (a heat pipeline)                 the first field's pipeline
--------------------------------                 --------------------------
worker → store → arena                           combine: expression over
pack kernel  → instances (14 floats)               up to 4 fields, per output
             → field: Cell + (num, den) per        → instances [8..9] in place
               output, and a hash table of Cells
                         └──── one frame: packs, combines, draws → one submit
```

1. Each collection keeps its own worker, store, arena and pack. Its keys carry
   its offset, so two collections never share a key; the pack already decodes
   every key to draw it, and now also writes the Cell: the parent zone's
   coordinates (`space.xyz`, once per block, on the CPU) refined by the key's
   geometric bits (`decodeCell`, the integer twin of `decodeBits`).
2. A field is one GPU buffer: header, hash table of Cells, one row per output.
   `indexField` fills the table with atomics (one slot per row, any order).
3. The first field gives the cells that are drawn: geometry, tiers, fades and
   anchors are its pack's, untouched.
4. `combine` runs once per output of the first field. It finds each other
   field's row for the same Cell, or else for the nearest cell that encloses
   it, evaluates the expression on the fields' values and writes
   `(value · den, den)` of the first field into the instances: the renderer's
   weighted average is unchanged and it reads the same buffer as before.
5. The pack's own `(num, den)` stay in the field, so a combine can run again
   without a pack: when another field or the expression changes, only the
   combine is encoded.
6. The expression is compiled on the CPU to a postfix program of at most 24
   operations and 8 stack slots, carried in the uniform and interpreted by one
   fixed kernel. A new expression is a `writeBuffer`, not a new shader.
7. Every operation is total (`x / 0 = 0`, `log1p` of a negative is 0), and the
   result is clamped at 0: no NaN reaches the renderer.
8. One frame per device (`frameOf(device)`): pipelines and layers add
   recorders, the frame encodes packs, then combines, then draws into one
   command encoder and submits once. An owner that adds twice in a turn is
   encoded once.
9. A frame is flushed at the end of the turn that touched it (a microtask), or
   by the first heat layer's `render`: MapLibre calls `prerender` on every
   custom layer, where the layers record their passes, then `render`.
10. One collection and no expression is the same pipeline with no field and no
    combine: the plain heatmap.

## Rules for cells that one field lacks

- A cell of the first field that another field lacks (no row for its Cell nor
  for any enclosing cell, or rows whose rules give no value): that field's
  `missing` number stands in; without `missing` the cell is not drawn.
- A cell only another field has: not drawn. The first field decides what
  exists.
- A field coarser than the first one there: its enclosing cell's value.
- A field finer than the first one there (only cells below): missing. Summing
  the cells below is not done yet.
- A field with no plan yet, or on another device (during a device loss):
  missing everywhere.

## API

```js
import { compose } from "js-indexus-sdk/map";

const mix = compose({
  fields: [
    { name: "price",  worker: w1, collection: dvf,    rules: dvfRules },
    { name: "heat",   worker: w2, collection: temp,   rules: tempRules, missing: 20 },
    { name: "canopy", worker: w3, collection: canopy, rules: canopyRules, missing: 0 },
  ],
  expression: "price * ramp(heat, 35, 15) * (1 - canopy)",
  // every other option goes to each pipeline: device, budgetBytes, …
});
mix.init({ network, cubeOpt, … });      // each field's own `init` is merged in
mix.move({ zoom, bounds, strictBounds }); // every field walks the same view
new AverageGridLayerWebGPU(id, mix.controller, device, features);
mix.setExpression("price * (1 - canopy)"); // the combine alone, next frame
mix.fields.canopy.controller.setHeat(rules); // one field; the mix follows
mix.destroy();
```

- `fields`: 1 to 4. `name` is the word the expression uses; `rules` are heat
  rules (`normalizeHeat`); `collection` is `{name, dimensions}` and all fields
  must have the same dimensions; any other key is a `createHeatmapPipeline`
  option for that field alone.
- `expression`: numbers, field names, `+ - * /`, unary `-`, parentheses,
  `min(x, y)`, `max(x, y)`, `abs(x)`, `log1p(x)`, `clamp(x, lo, hi)`,
  `ramp(x, from, to)` (0 at `from`, 1 at `to`, straight in between). Default:
  the first field.
- The result is the first field's pipeline (`controller`, `search`,
  `registerRepaint`, `state`, …) with `init`, `move`, `deviceLost`, `restore`
  and `destroy` reaching every field, plus `fields` and `setExpression`.
- `createHeatmapPipeline(options)` is the one-field case and is unchanged for
  its callers (`useHeatmap`).

Lower level, `js-indexus-sdk/gpu`: `frameOf(device)`, `createFieldBuffer`,
`createPackKernel(...).encode(encoder, {..., field: {buffer, cellOf}})`,
`compileExpression(text, names)`, `createCombineKernel(device).encode(encoder,
{program, fields: [{buffer, missing}], instances, capacity, steady})`.

## GPU layouts

- **Field** (STORAGE, `gpu/field.js`), in u32 words: header `tableSize,
  capacity, coarsest, 0`; then `tableSize` slots (row + 1, 0 when free; a
  power of two, at least twice the capacity; linear probing); then 6 words per
  output: `c0, c1, c2, resolution + 1, num, den` (f32 bits). A fourth word of
  0 is an output no row reached. `coarsest` is the lowest resolution of the
  rows and bounds the walk up the enclosing cells. Resolutions up to 32.
- **Lookup**: every row of a Cell is in the table (a cell drawn by several
  tiers has several rows, with the same sums); a lookup probes to the first
  free slot and keeps the last row, so its answer does not depend on the
  order in which the GPU filled the table.
- **Combine uniform** (240 bytes): `program: array<vec4u, 12>` (two
  operations per element: code, argument), `missing: vec4f`, `whenMissing:
  vec4u` (1 drop, 2 stand in), `opCount, capacity, steady, fieldCount`.
- **Combine bindings**: uniform, the first field's instances (read-write), 4
  fields (read; an absent one is bound to a 16-byte stand-in). 5 storage
  buffers.
- **`steady`**: outside a fade the previous values `[12..13]` follow `[8..9]`.
  During a fade the combine writes the current half only; the previous half
  already holds the combined values that were on screen (the pack copies it
  from the last target).

## Checks

- `src/gpu/frame.test.mjs`: one encoder and one submit, stage order, one
  recorder per owner, flush at the end of the turn.
- `src/gpu/combine.test.mjs`: the Cell of an output is its square whatever the
  collection's offset; the combine on the fake device equals `combineCPU` (a
  join on cell keys in a Map, float64) on walk plans of two collections;
  missing, enclosing and finer cells; one submit and no `mapAsync`.
- `src/map/heat/compose.test.mjs`: two nodes, two workers, one device, against
  the CPU pack reference (`walk/pack.testkit.mjs`) joined on the CPU; one submit per
  turn; a new expression or a changed field encodes no pack of the first
  field; fades; device loss; the one-field case equals the plain pipeline.
- `scripts/gpu-check/build-compose-check.mjs` builds the page that runs the
  same mix on a real GPU, compares it with the emulation and the reference and
  times the frame. `node scripts/perf/run.mjs` has the `mix.*` cases
  (`docs/perf.md`).

## Not done

- The WGSL of `combine`, `indexField` and the field rows of the pack has run
  in the emulation only: run the check page on a real GPU before shipping.
- Summing a finer field up to a coarser first field.
- A field can be written into a view texture (`gpu/raster.js`, used by the
  weather effects); sampling the mix from a 3D surface and sun exposure in
  the height field are outside the SDK.
