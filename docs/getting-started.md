# Getting started with the SDK

Start with the [offline Anglet example](../README.md#get-started) to install
the SDK and see how DPIP location prefixes refine a view. The next example
reads from a node through the same gateway used by Explore.

## 1. Choose a gateway

The [core Docker quickstart](https://github.com/indexus/core/tree/main/quickstart)
serves Explore and its API together at `http://127.0.0.1:5174` by default.
The [source-based stack](https://github.com/indexus/core/blob/main/docs/local-experiences.md)
serves the gateway on port 3847. Use the origin for the stack you started.
`GET /api/health` reports its active network.

## 2. Read the Anglet sales

From the SDK checkout, after `npm ci`, run the following with Node 22.
`GatewaySession` uses the gateway to obtain a token, discover peers and
forward reads. The Docker gateway exposes the sample in read-only mode.

```sh
INDEXUS_GATEWAY=http://127.0.0.1:5174 node --input-type=module <<'JS'
import { GatewaySession } from "js-indexus-sdk";

const session = new GatewaySession({
  origin: process.env.INDEXUS_GATEWAY,
  contentRecords: true,
});
const network = await session.network();
const collection = "DvFMV2020idx0001";
const root = await network.getSets(collection, ["@"], { raw: true });
if (root.unresolved.length) throw new Error("Sales summary unavailable");

const records = await network.getContentRecords(collection, "@", 100);
console.log("DVF sale records:", records.length);
JS
```

The 1 km Anglet sample contains 19 sale records. A different collection
or a larger import can give a different result, and reading individual
records is subject to the request's record budget. For the columns of a
regional summary, iterate over `root.responses`, then over each response's
`blocks`. Each block provides `parent`, row count `n`, key words, counts and
metric columns. An answered empty zone belongs to `root.empty`; an
unanswered zone belongs to `root.unresolved`.

In a browser serving Explore from the gateway, use `origin: location.origin`.
The public imports are the same in Node and a browser. See
[read cancellation](read-cancellation.md) for request budgets.

## 3. Draw a heat map

A heat map is one *heat pipeline*: a worker (`js-indexus-sdk/map/heat-worker`)
reads blocks and walks the tree for the view, the main thread keeps the
*store* and the GPU *arena*, the *pack* kernel turns blocks into instances
and `AverageGridLayerWebGPU` draws them. `createHeatmapPipeline` from
`js-indexus-sdk/map` wires it; `heat` rules say which metric columns make
the value (`num / den`). Contract: [heat-pipeline.md](heat-pipeline.md).

Two working examples to start from:

- `dashboard/src/components/AggregateHeatmap.jsx`: React, `useGridWorker`
  (now `useHeatmap`) from `js-indexus-sdk/react`, MapLibre as the host of the layer.
- `experiences/src/experiences/explore/realestate.js`: plain JS,
  `createHeatmapPipeline`, drawn by Explore's own WebGPU renderer.

With Vite, import the worker as `js-indexus-sdk/map/heat-worker?worker`.
Without WebGPU the layer reports `unsupported` and the app shows a message:
there is no fallback renderer.

## 4. Combine collections

Collections of the same Space can be joined cell by cell on the GPU before
drawing (`compose` in `js-indexus-sdk/map`), e.g. a price per m² weighted by
another field: [compose.md](compose.md).

## 5. Measure

`node scripts/perf/run.mjs --out out.json` and
`node scripts/perf/compare.mjs perf/baseline/node.json out.json`:
[perf.md](perf.md).
