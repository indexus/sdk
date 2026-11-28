// node scripts/perf/sift-session.mjs <SIFT fvecs directory> [base rows]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { exactKnn, buildIvfIndex } from "../../src/index.js";

const [, , directory, countArg] = process.argv;
if (!directory) throw new Error("Pass the directory containing the SIFT1M fvecs files");
const hashes = {};
const round = (x) => Number(x.toFixed(3));
function vectors(file, count) {
  const stride = 516;
  const raw = Buffer.alloc(count * stride);
  const fd = openSync(join(directory, file));
  try {
    let offset = 0;
    while (offset < raw.length) {
      const size = readSync(fd, raw, offset, raw.length - offset, offset);
      assert.ok(size > 0);
      offset += size;
    }
  } finally {
    closeSync(fd);
  }
  hashes[file] = createHash("sha256").update(raw).digest("hex");
  return Array.from({ length: count }, (_, i) => {
    assert.equal(raw.readInt32LE(i * stride), 128);
    return new Float32Array(raw.buffer, raw.byteOffset + i * stride + 4, 128);
  });
}
const start = performance.now();
const count = Number(countArg ?? 100000);
assert.ok(Number.isInteger(count) && count >= 160 && count <= 1000000);
const rows = vectors("sift_base.fvecs", count).map((vector, i) => ({
  id: String(i).padStart(6, "0"),
  vector,
  bucket: i % 16,
}));
const centers = vectors("sift_learn.fvecs", 64);
const queries = vectors("sift_query.fvecs", 64);
const ioMs = performance.now() - start;
const buildStart = performance.now();
const index = buildIvfIndex(rows, centers);
const buildMs = performance.now() - buildStart;
const filterStart = performance.now();
const eligible = rows.filter((row) => row.bucket === 3);
const prefilterMs = performance.now() - filterStart;
const subsetStart = performance.now();
const subsetIndex = buildIvfIndex(eligible, centers);
const subsetBuildMs = performance.now() - subsetStart;
const filter = (row) => row.bucket === 3;
function oracle(query) {
  return eligible
    .map(({ id, vector }) => {
      let distance_squared = 0;
      for (let j = 0; j < vector.length; j++) distance_squared += (vector[j] - query[j]) ** 2;
      return { id, distance_squared };
    })
    .sort((a, b) => a.distance_squared - b.distance_squared || a.id.localeCompare(b.id))
    .slice(0, 10);
}
const methods = ["exact", 4, 16, 64, "subset16"];
const samples = new Map(methods.map((m) => [m, []]));
for (const [i, q] of queries.entries()) {
  const expected = oracle(q);
  const equivalent = new Map();
  const ids = new Set(expected.map((hit) => hit.id));
  for (let j = 0; j < methods.length; j++) {
    const method = methods[(i + j) % methods.length];
    const t = performance.now();
    let result;
    if (method === "exact") {
      result = {
        hits: exactKnn(eligible, q, { limit: 10 }),
        candidateDistances: eligible.length,
        visitedRows: eligible.length,
      };
    } else if (method === "subset16") {
      result = subsetIndex.search(q, { probes: 16, limit: 10 });
    } else {
      result = index.search(q, { probes: method, limit: 10, filter });
    }
    const ms = performance.now() - t;
    if (method === 16 || method === "subset16") equivalent.set(method, result.hits);
    if (method === "exact" || method === 64) assert.deepEqual(result.hits, expected);
    samples
      .get(method)
      .push({
        ms,
        correct: result.hits.filter((h) => ids.has(h.id)).length,
        distances: result.candidateDistances,
        visits: result.visitedRows,
      });
  }
  assert.deepEqual(equivalent.get(16), equivalent.get("subset16"));
}
assert.deepEqual(
  samples.get(16).map((r) => [r.correct, r.distances]),
  samples.get("subset16").map((r) => [r.correct, r.distances]),
);
const results = [...samples].map(([method, rows]) => {
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const sum = (key, n = rows.length) => rows.slice(0, n).reduce((a, r) => a + r[key], 0);
  return {
    method,
    recallAt10: sum("correct") / 640,
    meanDistances: sum("distances") / 64,
    meanVisits: sum("visits") / 64,
    p50Ms: round(sorted[31]),
    p95Ms: round(sorted[60]),
    p99Ms: round(sorted[63]),
    queryMsBySession: Object.fromEntries([1, 4, 16, 64].map((n) => [n, round(sum("ms", n))])),
  };
});
console.log(
  JSON.stringify(
    {
      rows: rows.length,
      eligible: eligible.length,
      queries: 64,
      centers: 64,
      dimensions: 128,
      metric: "squared L2",
      node: process.version,
      ioDecodeAndChecksumMs: round(ioMs),
      buildMs: round(buildMs),
      prefilterMs: round(prefilterMs),
      subsetBuildMs: round(subsetBuildMs),
      processPeakRssKiB: process.resourceUsage().maxRSS,
      hashes,
      results,
    },
    null,
    2,
  ),
);
