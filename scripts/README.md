# scripts

| Folder | What | Run |
| --- | --- | --- |
| `perf/` | The Node benchmark suite (`indexus-perf/1`), its comparator and the browser page ([docs/perf.md](../docs/perf.md)) | `node scripts/perf/run.mjs`, `node scripts/perf/compare.mjs ref.json new.json` |
| `gpu-check/` | Pages that run the GPU kernels (cells, pack, compose, raster) on a real GPU against their emulation | `node scripts/gpu-check/build-<name>-check.mjs`, then open `scripts/gpu-check/dist/<name>-check.html` (`raster-check.html` is served as is) |
