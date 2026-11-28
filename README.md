# Indexus SDK

<a href="LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-blue" alt="License"/></a> <a href="https://discord.gg/EXuGtcDgaS"><img src="https://img.shields.io/discord/1235219716738519080?logo=discord&logoColor=white" alt="Discord"/></a>

Indexus is the project behind the proposed **Distributed Prefix Index Protocol
(DPIP)**. Its JavaScript SDK turns coordinates into a prefix, reads a zone's
children, and renders compatible collections in the same view. For Anglet,
the reference app combines terrain, archived weather and property sales.

## What it is

An Indexus node serves the sums of the zones of a binary tree (count plus
metric sums per zone; see the
[glossary](https://github.com/indexus/core/blob/main/docs/glossary.md)).
The SDK is the client half of the same layers, top to bottom
([docs/layers.md](docs/layers.md)):

| Layer | Directory | Role |
| --- | --- | --- |
| tree | `src/tree` | Addresses: `Space`, locations, zone keys, abelian sums |
| wire | `src/wire`, `src/api`, `src/network` | `fetch` transport, peers and redirects, IXB2 and IXRB decoders, `Network` |
| store | `src/store` | One cache of blocks by zone, with a byte budget |
| walk | `src/walk` | One descent of the tree for a view: the zones to read and show |
| gpu | `src/gpu` | One WebGPU device per realm: arena, pack, field, combine, raster, frame |
| map | `src/map`, `src/react` | The heat pipeline on a MapLibre map, `compose`, the React hook |

The node is [core](https://github.com/indexus/core);
the apps that use the SDK are in
[experiences](https://github.com/indexus/experiences) and
[dashboard](https://github.com/indexus/dashboard).

## Get started

With Node 22, clone the SDK as `sdk-js` next to the other Indexus repositories.
Its npm package name is `js-indexus-sdk`.

```sh
git clone https://github.com/indexus/sdk.git sdk-js
cd sdk-js
npm ci
npm test
```

Encode a point in Anglet from the SDK checkout. This first example runs
entirely in Node and needs no server or GPU:

```sh
node --input-type=module <<'JS'
import { Collection, Space } from "js-indexus-sdk";

const sales = new Collection("DvFMV2020idx0001", [
  { name: "gps", type: "spherical", args: [-90, 90, -180, 180] },
]);
const space = new Space(sales.dimensions(), sales.mask(), sales.offset());
const point = space.dimension(0).newPoint([43.483, -1.519]);
console.log([2, 4, 6].map(depth => space.encode([point], depth)));
JS
```

The three results are `qu`, `qugC` and `qugCwx`. Each longer prefix identifies
a smaller zone containing the same point. Follow the [first network
read](docs/getting-started.md) to retrieve sales from a running Anglet node.
[Explore](https://github.com/indexus/experiences) uses the same SDK;
[Docker setup](https://github.com/indexus/core/tree/main/quickstart) starts
the data service used by that example.

## Order selected records by an attribute

```js
import { topByAttribute } from "js-indexus-sdk";

const rows = [{ id: "a", height: 4 }, { id: "b", height: 8 }, { id: "c" }];
const tallest = topByAttribute(rows, row => row.height, { order: "desc", limit: 2 });
// tallest contains the original rows b and a.
```

For lexicographic ordering select the fields in priority order. A missing
value sorts last for its criterion. IDs and locations break remaining ties.

```js
import { topByAttributes } from "js-indexus-sdk";

const top = topByAttributes(rows, [
  { select: row => row.category },
  { select: row => row.height, order: "desc" },
], { limit: 10 });
```


Pass an iterable of eligible records. The selector runs once per row and
returns a finite number, string or boolean of one type. Null and missing
values sort last in both directions. Equal values sort by ascending ID and
optional location using Unicode code-point order. Identical keys keep input
order. Each call retains at most twice the requested number of candidates.
A full native array sort is sufficient when the whole ordered list is needed.

## Discover children observed by one peer

`await api.getLocalChildren("http", peer, collection, location, options)`
requests the direct child addresses known to the selected peer. Use `@` for
the root. The result carries `{ children, complete: false }`, including when
the list is empty. Other peers can hold additional descendants. A failed
request propagates to the caller.

## Search client documents by field

Build a reusable BM25 index over string fields of documents with unique IDs.
Field weights multiply their scores. By default, `lowercase-whitespace-v1`
lowercases and splits on whitespace. To match accented and hyphenated Latin
text with unaccented search terms, choose an analyzer when building the index:

```js
const index = buildBM25Index(documents, { title: 2, body: 1 }, {
  fieldAnalyzers: { title: "latin-folded-words-v1" },
});
```

The title analyzer lowercases, strips combining marks attached to Latin letters,
and tokenizes runs of Unicode letters, marks and numbers. For example,
`CAFÉ-Crème` yields `cafe` and `creme`; marks on other scripts are retained.
The body keeps its whitespace analyzer, so searching for `cafe` also finds
`CAFÉ-Crème` in titles and matches whole unaccented tokens in bodies. Set
`analyzer` to change the default across fields. Each field uses its selected
analyzer for both indexing and queries. Homogeneous indexes retain their
original statistics format. Mixed indexes carry versioned analyzer names and
query terms per field. Mismatched statistics raise an error.
Each distinct query term counts once. Missing, null and empty
fields do not contribute to that field's document count or length. Rebuild the
index when its documents change.

```js
import { buildBM25Index, mergeBM25Statistics } from "js-indexus-sdk";

const weights = { title: 2, body: 1 };
const west = buildBM25Index([{ id: "a", title: "tower" }], weights);
const east = buildBM25Index([{ id: "b", body: "park tower" }], weights);
const query = "tower";
const statistics = mergeBM25Statistics([west.statistics(query), east.statistics(query)]);
const westHits = west.search(query, { statistics, limit: 10 });
const eastHits = east.search(query, { statistics, limit: 10 });
```

Pass `{ k1, b }` to `search` to tune the score. The default values are
`k1 = 1.2` and `b = 0.75`. A finite nonnegative `k1` controls term-frequency
saturation. Zero gives each matching term its field-weighted IDF. The length
normalization parameter `b` ranges from 0 (disabled) to 1 (full). Reuse the
same corpus statistics when changing these options, and pass the same scoring
parameters to every partition for each search.

For one index, `index.search(query)` uses its local statistics. For partitions,
use the same field weights, disjoint documents and one collection snapshot.
The JSON-serializable statistics contain corpus counts, total field lengths and
document frequencies for the query terms. With shared statistics, merge each
partition's top-k by descending score then ascending Unicode document ID to
obtain the global top-k, ready for rank fusion.

### Verify an exact phrase in one field

`index.filterPhrase(documents, "title", "café crème")` yields each matching
input document once, in input order. The field's configured analyzer processes
both the phrase and the field text. All tokens must be consecutive and in the
same order, including repeated tokens. An empty analyzed phrase yields no
matches. Verify the full eligible iterable before applying a top-k limit when
all phrase matches matter. Keep the source text available on the candidates.

Verification scans the supplied field text once at query time. It retains the
query tokens, a prefix table and the current field's tokens. Building the
BM25 index stores no additional positions.

### Match a token prefix in one field

`index.filterTokenPrefix(documents, "title", "caf")` yields matching
candidates in input order. At least one analyzed token in the named field
must start with the entire analyzed prefix. A full token also matches. An
empty analyzed prefix yields no results. A prefix that analyzes into several
tokens raises an error during iteration. With the folded analyzer, `cre` finds
`CAFÉ-Crème`. With the whitespace analyzer, this field contains one token
beginning with `café-`. As with phrase verification, pass candidates with
their field text and apply limits after filtering.

## Find nearest vectors among selected records

Pass the query vector and any iterable of eligible, live candidates from one
view. Each candidate supplies an ID, an optional location, and a dense vector
as a number array or numeric typed array. The caller selects the eligible
rows and supplies each document key once.

```js
import { exactKnn } from "js-indexus-sdk";

function* selected(records) {
  for (const r of records) if (r.category === 7) yield r;
}
const nearest = exactKnn(selected([
  { id: "a", category: 7, vector: [3, 4] },
  { id: "b", category: 8, vector: [0, 0] },
]), [0, 0], { limit: 10 }); // [{ id: "a", distance_squared: 25 }]
```

The query returns up to the requested limit in ascending squared Euclidean
distance, then ID and location order. It consumes the iterable once, computes
every eligible distance, and holds at most twice the requested limit in
candidate hits. Short, empty and exhausted iterables yield all available
matches. Set `metric: "cosine"` for ascending cosine distance (1 minus cosine
similarity). Each hit then carries `cosine_distance` in [0, 2]. This option
requires nonzero query and candidate vectors. It reuses two width-sized
buffers during the scan. The default `metric: "l2_squared"` retains
`distance_squared` and accepts zero vectors. Non-finite coordinates and inconsistent vector widths raise errors.

## Fuse document rankings

Combine independently ordered BM25 and vector hits for the same collection,
snapshot and eligible documents. Supply a stable unique document ID per hit. When IDs repeat across locations,
pass `identity: "location-id"` and include a location on each active hit.
The result then carries both fields, with ID and location breaking score ties.

```js
import { fuseRankings } from "js-indexus-sdk";

const view = { collection: "docs", snapshot: "backup-digest" };
const hits = fuseRankings([
  { ...view, weight: 2, hits: [{ id: "a" }, { id: "c" }] },
  { ...view, hits: [{ id: "b" }, { id: "c" }, { id: "a" }] },
], { limit: 3 }); // IDs: a, c, b
```

Each unique document contributes `weight / (constant + rank)` once per list.
Ranks start at one after deduplication. The default weight is 1 and the
default constant is 60. Score ties use document ID order. Ensure each source
reads the snapshot it declares and merges its partitions before fusion.
Input list depth determines which candidates can appear.

## Repository map

| Path | Role |
| --- | --- |
| `src/index.js` | Main entry: tree, `Network`, `API`, `Local`, `GatewaySession`, `ContentAssets` |
| `src/map/index.js` | `js-indexus-sdk/map`: `createHeatmapPipeline`, `compose`, `AverageGridLayerWebGPU`, colour scales |
| `src/map/workers/heat.worker.js` | `js-indexus-sdk/map/heat-worker`: the dedicated worker of one heat pipeline (core: `src/walk/heat`, network, summaries and walk) |
| `src/gpu/index.js` | `js-indexus-sdk/gpu`: device, kernels, frame |
| `src/store/index.js` | `js-indexus-sdk/store`: the block store |
| `src/react/index.js` | `js-indexus-sdk/react`: `useHeatmap` (the heat pipeline as a hook; `useGridWorker` is its deprecated former name) |
| `src/local` | `Local`: nearest records, ring by ring |
| `src/runtime` | Thread-local factories, `GatewaySession` |
| `src/*/testdata` | Golden files shared with the node (`core/indexus/testdata`) |
| `scripts/perf` | Benchmarks in the `indexus-perf/1` format ([docs/perf.md](docs/perf.md)) |
| `scripts/gpu-check` | Pages that run the kernels on a real GPU against their emulation |
| `perf/baseline` | Reference results of the Node suite |

`react` is an optional peer (for `./react` only); the map layer is a MapLibre
custom layer but imports nothing from `maplibre-gl`, the host's map is passed
in. Import only the entry points you use. Importing a module never requests a
GPU device. The one runtime dependency is `earcut` (the mask triangulation).

## Tests

```sh
npm test                                   # every unit test, no GPU needed
node --test scripts/perf/compare.test.mjs  # the perf comparator
node scripts/perf/run.mjs --quick          # the Node benchmarks, smoke run
```

GPU kernels are tested in Node against a float32 emulation; the pages of
`scripts/gpu-check` (`node scripts/gpu-check/build-*.mjs`) run them on a
real GPU in the browser.

## Documentation

- [docs/README.md](docs/README.md): index
- [docs/getting-started.md](docs/getting-started.md): first read, first map
- [docs/layers.md](docs/layers.md): the layer contract and its interfaces
- [docs/heat-pipeline.md](docs/heat-pipeline.md): worker, store, arena, pack, draw
- [docs/compose.md](docs/compose.md): joining collections on the GPU
- [Check a cached view and reload selected subtrees](docs/observed-cut-refresh.md)
- [Run filtered vector search and reproduce the SIFT sessions](docs/filtered-ann.md)
- Wire format: [core/docs/protocol/wire-block.md](https://github.com/indexus/core/blob/main/docs/protocol/wire-block.md)

Maintained by Rémi Henriot. The [project history](https://github.com/indexus/papers/tree/main/60-history-and-authorship) documents the contributions of AI tools.

## License

Copyright © Indexus. The Indexus SDK source in this revision is subject to the
[Mozilla Public License, version 2.0](LICENSE) (SPDX: `MPL-2.0`). See
[component notices](LICENSE-NOTICES.md) for bundled material. Applications may
distribute the SDK alongside proprietary code under the terms of the MPL.

Earlier revisions distributed under MIT retain that grant. Third-party components
retain their respective terms. The [DPIP specification](https://github.com/indexus/papers)
is published separately under CC BY 4.0.


### Peer-local reads

Set `navigation: "direct"` in the last options argument to `Network` when the
client should follow ownership hints itself. Direct `getSet` and `getSets`
ask for local summaries with `deep=false`. A client refresh reads the latest
available summary on that peer. A summary can lag recent writes.

Use `network.getPointRecords(collection, location, limit)` for documents at
one exact address, including at an interior node of the tree. The SDK remembers
which peer answered and follows ownership hints if the data moves. In direct
sessions, `getRecords` visits descendant addresses client-side. A refused or
unavailable point read remains an error. A successful empty reply means the
peer held the address and its snapshot contained no live records there.
