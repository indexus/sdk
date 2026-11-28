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

### Select and project direct records at known addresses

After reading addresses with `API.getDirectRecords`, an application can select
IDs and numeric metrics locally. For example:

```js
const tuples = selectDirectRecords(rows, {
  ids: ["building-42", "building-81"],
  where: { metric: 0, in: [2, 5] },
  columns: ["location", "id", 3, { payload: "title" }],
});
```

Each result contains the location, ID, metric 3 and title in that order. Pass
`includePayloads: true` to `API.getDirectRecords` to load the JSON payload.
A payload selector reads one literal top-level key (dots are ordinary characters).
Missing keys, absent payloads and missing metrics project to `null`. JSON values
retain their original type. A missing metric fails a numeric membership
test. Use one value in `in` for equality. Rows retain input order and duplicate
IDs at distinct addresses retain their individual results. Field names are
`collection`, `location`, `id` and `weight`; metric indices address numeric
columns. Reads over the network still transfer all direct record metadata at
each chosen address. The caller supplies candidate addresses and reads all
required rows before interpreting an empty selection as no match.

Use `scalarFacet(rows, row => row.category)` for a string, boolean or numeric
field on the documents already selected by the client. The result contains
the number of matched documents, the number with missing values and the
ordered value/count buckets. Each field has one scalar type. Empty strings,
false and zero have their own buckets.

Use `groupCounts(rows, [r => r.usage, r => r.kind])` to count a fixed selection
by a tuple of scalar attributes. Each result has `{values, count}` and counts
one per input row. Each selector can return strings, booleans or finite numbers
of one type across the input. An absent or null value becomes a null tuple
component. Groups sort by their first differing column in ascending attribute
order, with null last. The client materializes one bucket per distinct tuple.

`documentFilter` builds predicates for rows already loaded by the client.
Use `oneOf(select, values)` on a scalar field and `contains(select, value)`
on an array field. Strings, booleans and finite numbers compare by type and
value. An explicit `null` in a `oneOf` list also selects missing and null fields.
For example, `oneOf(select, [null, "open"])` is equivalent to
`or(missing(select), oneOf(select, ["open"]))`. An empty
array is present and contains no values. `missing(select)` recognizes an
absent or null field. A present field of the wrong shape or an invalid array
element raises a type error when that predicate runs.

`containsAny(select, values)` tests for an intersection with a copied set of
scalar values. An empty set matches no rows. Compose `not(contains(...))` or
`not(containsAny(...))` to include rows without a match, including absent
and null fields. For ordered arrays, use `anyLt`, `anyLte`, `anyGt` or
`anyGte` with a selector and a finite number or string threshold. Each element
must have the threshold's type. String order uses Unicode code points.
A missing, null or empty array has no matching element.

```js
import { documentFilter as f } from "js-indexus-sdk";
const eligible = rows.filter(f.and(
  f.oneOf(row => row.category, ["house", "shop"]),
  f.or(f.missing(row => row.tags), f.not(f.contains(row => row.tags, "hidden"))),
));
```

`and` and `or` short-circuit in argument order and accept predicates returning
booleans. With zero arguments they return predicates that always yield true
and false respectively. `not` negates a predicate over the supplied rows.

### Match a text pattern on loaded rows

`documentFilter.glob(row => row.path, "reports/*/day-*.json")` matches the
entire string, case sensitively. Each single star matches any sequence,
including empty text, slashes and newlines. Separate literal fragments must
match in order without overlap. An empty pattern matches only the empty
string. On an array of strings, one matching element is sufficient. Missing
and null attributes, and empty arrays, return false. Use
`documentFilter.not(documentFilter.glob(select, pattern))` for the complement.

The SDK accepts literals and single stars. It rejects question marks, braces,
brackets, backslashes and adjacent stars at construction. Matching searches
the supplied payloads locally. [Turbopuffer glob filters](https://turbopuffer.com/docs/query#filtering-parameters)

Pass `{ syntax: "codepoint" }` as the third argument to enable `?` and
backslash escapes. Each question mark consumes one Unicode code point:
`"?"` matches `"😀"`, while `"e\u0301"` takes two. Matching is case
sensitive and preserves normalization. A backslash quotes any of
`* ? [ ] { }` or another backslash; a trailing backslash or other escape
raises an error. Character classes, brace alternatives and adjacent stars
are unsupported. For example, the JavaScript pattern `"file-?\\*.txt"` matches
`"file-😀*.txt"`. The matcher uses space proportional to the pattern length
and at most one pass over its tokens per input code point.

### Resume a best-effort walk across explicit peers

`walkLocalChildren` observes the caller's pending peer/address pairs in
breadth-first order. A transport call is supplied by the application.
For example, with an `API` instance and a local map of peer IDs:

```js
const initial = { collection, pending: [{peer: "P", location: "@"}, {peer: "Q", location: "@"}] };
const result = await walkLocalChildren(initial, {
  maxRequests: 4,
  observe: (id, c, l) => api.getLocalChildren("http", peers.get(id), c, l),
});
const checkpoint = JSON.stringify(result.state);
// Pass JSON.parse(checkpoint) to the next invocation.
```

Each observed child is queued on its reporting peer by default. Set
`peersForChild(peer, parent, child)` to return an explicit array of peer IDs
when another routing policy is needed. A pair is visited once per pass across
resumptions. Each attempt counts against this invocation's budget, including a
failed request. On failure, inspect `result.error`; the failing pair stays at
the front of the checkpoint. The observations returned in each batch belong
to that batch. Save them alongside the checkpoint to retain the evidence.

An empty pending queue is the end of this pass. Empty observations can miss
remote children and positive observations can be stale. The walk always
returns `complete: false`. To revisit earlier observations after the cluster
changes, start another pass from the desired seeds with an empty visited list.
The checkpoint contains addresses and peer IDs; each observation reads the
peer's current local view.

`exactSparseDot(candidates, query, {limit: 10})` ranks the supplied rows by
descending inner product, then by ID and location. Supply one row per live
document with `{id, location?, vector}`. Each vector, including the query,
is an array of `[index, weight]` pairs with strictly increasing, nonnegative
safe integer indices and finite weights. Missing indices have weight zero.
An empty vector scores zero. Negative scores are retained. Non-finite score
arithmetic raises a range error. As with `exactKnn`, overlapping input batches
must be reconciled by the caller before ranking. The operator uses a bounded
top-k and reads all candidates with no dense allocation. Its coordinate-pair
representation and inner product follow the conventions described in the
[Milvus sparse vector documentation](https://milvus.io/docs/sparse_vector.md).

### Histograms and quantile bounds

```js
const bounds = [2, 4, 6, 8, 10, 15, 20];
const parts = partitions.map(rows => numericHistogram(rows, row => row.height, bounds));
const histogram = mergeNumericHistograms(parts);
const medianBucket = histogramQuantile(histogram, 0.5);
```

Supply one or more finite, strictly increasing bounds. The summary is
`{bounds, counts, missing}`. The first count is the number below the first
bound. Each interior bucket includes its lower bound and excludes its upper
bound. The last count includes everything at or above the last bound. Each
row contributes once; only finite numeric values populate buckets. Other
values increment `missing`.

Addition of disjoint partitions with identical bounds is exact. Pass at least
one histogram to merge, including an empty histogram with known bounds as
the identity. Overlapping partitions count shared rows more than once.
Malformed counts and totals exceeding JavaScript's safe-integer range fail.

Quantiles ignore missing values. The nearest rank is one-based,
`max(1, Math.ceil(q * present))`, using JavaScript binary64 multiplication.
For an empty finite population the result is `null`. Otherwise it reports
`rank`, the bucket's inclusive `firstRank` and `lastRank`, and the bucket's
`lowerInclusive` and `upperExclusive`. A `null` endpoint denotes an
unbounded side. Any value in the returned interval is consistent with the
summary at that rank; the actual distribution inside the bucket is unknown.

### Cap ranked results per group

`limitPerGroup(ranked, [row => row.brand, row => row.region], { perGroup: 2, limit: 10 })`
takes up to ten results in the supplied ranking order, with at most two per
brand and region pair. Each selector reads one scalar type. Missing and null
values share a group. Supply the full ranking when lower-ranked groups should
fill the remaining places. The client stops reading when it fills the result.

### Read from the roots of a known peer set

`api.readObservedCollection("http", peers, collection, { maxRequests: 128, includePayloads: true })`
discovers local children on each supplied peer, then reads each observed address
once successfully, including interior nodes. Discovery requests uncertain children
as well, because a tombstone can hide live siblings in the same storage range.
This mode requires peers supporting `include_uncertain`. Only an ownership refusal (HTTP
409) tries another supplied peer. The same request budget covers discovery,
record reads and these retries. Discovery and record errors reject the call.
The SDK schedules independent discovery calls and direct reads on the client,
with up to four active calls per pass by default. Set `concurrency` to tune
this limit, or to 1 for serial reads. Ownership retries for one location stay
sequential. Responses are assembled in discovery order. Pass an `AbortSignal`
as `signal` to cancel and use `limitPerLocation` to bound each direct response.

The returned `records` can feed filters, projections and aggregates together.
The returned `requests` counts calls to the two read methods. `complete` is
always false because local child observations can lag writes or transfers.
For incremental discovery with a serializable checkpoint use `walkLocalChildren`.

For a page of grouped counts, call `groupCounts(rows, selectors, { offset, limit })`.
Offsets count whole groups in tuple-key order. A page may be short or empty.
Omit both options for all groups. When displaying several pages of a fixed
selection, keep the full array and slice it locally to reuse the grouping work.
Recomputing pages from changing inputs can shift offsets.

Pass `{estimate: "midpoint"}` as the third argument to `histogramQuantile`
to add a scalar to the rank and value interval. For finite edges, this is
the center of the selected bucket. With only those edges known, its midpoint
minimizes worst-case absolute error in real arithmetic. The result is rounded
to a representable number inside the half-open bucket. The actual quantile
can lie anywhere in that bucket, even when all its values coincide.
Without observed extrema, an underflow or overflow bucket returns `estimate: null`. An all-missing
population still returns `null`. Existing summaries with `bounds`, `counts`
and `missing` work directly. Omitting the option keeps the earlier output.

For estimates in every populated class, pass `{trackExtrema: true}` as the
fourth argument to `numericHistogram`. It also stores the minimum and maximum
finite values, or null for both when empty. A midpoint request then includes
`estimateRange: {lower, upper, upperInclusive}` (lower always inclusive),
the intersection of the class with the observed range. The first and last
rank have exact singleton ranges. Merge preserves extrema when every
nonempty partition tracks them. A legacy nonempty partition drops the
combined extrema, and a legacy empty partition is neutral.

`exactMaxSim(candidates, queryTokens, {limit})` ranks documents represented by
multiple token vectors. Supply one `{id, location?, vectors}` per eligible
document. For each query token the score takes its largest inner product with
a document token, then sums across query tokens. Multiple query tokens may use
the same document token. All vectors must share a positive width and finite
coordinates. Both token lists must be nonempty. The caller supplies embeddings
and any normalization needed by the model. The SDK scans the provided
documents and returns `{id, location?, score}` in descending score order.

For pruning by IXB2 indicator sums, pass an expected ingestion dictionary to
`presenceMasks(parts, sourceColumns, {schema})`. A schema has a nonempty
`revision` string and an ordered `columns` array containing unique indicator
names or `null` for ordinary metrics. Attach the dictionary used by the
producer to each part as `part.schema`; obtain it from trusted ingestion
metadata associated with that part. Equal revisions, lengths and names at
each ordinal are required. A missing or mismatched dictionary leaves the
part unknown. A source index outside the dictionary stays unknown even if Go
zero-filled that index in a projection. The bit position in the result follows
the caller's requested source-column order. Coverage and freshness still
require `part.complete === true` from the caller.

Without an explicit schema, projected zeros and empty responses yield no
absence bits. A positive projected counter remains a witness under the
historical caller-verified interpretation. The on-wire IXB2 format is unchanged.

### Find misspelled tokens and highlight matches

`buildBM25Index` creates an index over the rows the client has loaded. Use the
same index across interactions on that selection.

```js
const index = buildBM25Index(rows, {title: 1}, {analyzer: "latin-folded-words-v1"});
const {ids, examinedTerms, complete} = index.matchFuzzyToken("title", "cafes", {
  maxDictionaryTerms: 256
});
const spans = index.highlightTokens("title", "😀 CAFÉ et café", "cafe");
const fragments = spans.map(({start, end}) => "😀 CAFÉ et café".slice(start, end));
```

Fuzzy lookup allows one insertion, deletion or substitution of a Unicode code
point after field analysis. The budget limits distinct dictionary terms visited
in first-seen order. A partial lookup can omit matches. Each matched posting
list is read in full. Highlighting finds exact analyzed query terms in the
supplied original text and returns half-open UTF-16 offsets.
