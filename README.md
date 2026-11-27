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
