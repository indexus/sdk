# SDK documentation

| Document | What it covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Install, test, read zone sums and records, draw a heat map |
| [layers.md](layers.md) | The layer contract (tree, wire, store, walk, gpu, edges) and its interfaces |
| [heat-pipeline.md](heat-pipeline.md) | The heat map: worker and main-thread messages, store, arena, pack, public map API |
| [compose.md](compose.md) | Fields and the GPU combine of up to four collections |
| [read-cancellation.md](read-cancellation.md) | Deadlines, shared reads and cancellation |
| [perf.md](perf.md) | The `indexus-perf/1` format, the suites (Go, Node, browser, Explore) and the comparator (in French) |

Shared with the node, in [core](https://github.com/indexus/core):
the [glossary](https://github.com/indexus/core/blob/main/docs/glossary.md)
and the wire contract
[wire-block.md](https://github.com/indexus/core/blob/main/docs/protocol/wire-block.md)
(IXB2, IXRB), whose golden files are copied in `src/wire/testdata` and
`src/api/testdata`.
