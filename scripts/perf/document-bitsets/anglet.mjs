// node scripts/perf/document-bitsets/anglet.mjs <BD TOPO batiment.geojson>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DocumentUniverse } from "../../../src/index.js";

const input = readFileSync(process.argv[2]);
const revision = createHash("sha256").update(input).digest("hex");
const rows = JSON.parse(input).features.map(({ properties: p }, i) => ({
  id: p.cleabs,
  usage: p.usage_1,
  height: p.hauteur,
  deleted: i % 53 === 0,
}));
assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
const usages = [...new Set(rows.map((r) => r.usage))].sort();
const thresholds = [5, 10, 20];
const matchesHeight = (r, h) => Number.isFinite(r.height) && r.height >= h;
const segments = [];
const width = 127;
for (let start = 0; start < rows.length; start += width) {
  const part = rows.slice(start, start + width);
  const ords = part.map((_, i) => i);
  const u = new DocumentUniverse(
    "seg" + start,
    revision,
    part.map((r) => r.id),
    ords.filter((i) => part[i].deleted),
  );
  const posting = (select) => u.posting(ords.filter((i) => select(part[i])));
  segments.push({
    u,
    byUsage: new Map(usages.map((x) => [x, posting((r) => r.usage === x)])),
    byHeight: new Map(thresholds.map((h) => [h, posting((r) => matchesHeight(r, h))])),
  });
}
const ops = ["and", "or", "andNot"];
const requests = usages.flatMap((usage) =>
  thresholds.flatMap((height) => ops.map((op) => ({ usage, height, op }))),
);
function indexed({ usage, height, op }) {
  return segments.flatMap(({ u, byUsage, byHeight }) =>
    u.ids(u[op](byUsage.get(usage), byHeight.get(height))),
  );
}
function scanned({ usage, height, op }) {
  const result = new Set();
  for (const row of rows) {
    if (row.deleted) continue;
    const a = row.usage === usage,
      b = matchesHeight(row, height);
    if (op === "and" ? a && b : op === "or" ? a || b : a && !b) result.add(row.id);
  }
  return [...result];
}
let countedIntersections = 0;
for (const q of requests) {
  const expected = scanned(q);
  assert.deepEqual(indexed(q), expected);
  if (q.op === "and") {
    const count = segments.reduce((n,{u,byUsage,byHeight}) =>
      n + u.intersectionCount(byUsage.get(q.usage),byHeight.get(q.height)), 0);
    assert.equal(count, expected.length);
    countedIntersections++;
  }
}
const andQueries = requests.filter(q => q.op === "and");
const countMethods = {
  materialized: (u,a,b) => u.ids(u.and(a,b)).length,
  popcount: (u,a,b) => u.intersectionCount(a,b),
};
function countTrial(fn) {
  let total = 0;
  const start = performance.now();
  for (let repeat = 0; repeat < 12; repeat++) {
    for (const { usage, height } of andQueries) {
      for (const { u, byUsage, byHeight } of segments)
        total += fn(u, byUsage.get(usage), byHeight.get(height));
    }
  }
  return { ms: performance.now() - start, total };
}
const countTimes = { materialized: [], popcount: [] };
for (let i=0;i<5;i++) {
  const order = i%2 ? ["popcount","materialized"] : ["materialized","popcount"];
  const totals = order.map(name => {
    const {ms,total} = countTrial(countMethods[name]);
    countTimes[name].push(ms);
    return total;
  });
  assert.equal(totals[0],totals[1]);
}
function trial(fn) {
  const start = performance.now();
  let count = 0;
  for (const q of requests) count += fn(q).length;
  return { ms: performance.now() - start, count };
}
const timings = { scan: [], bitsets: [] };
for (let i = 0; i < 5; i++) {
  const order = i % 2 ? ["bitsets", "scan"] : ["scan", "bitsets"];
  for (const name of order) timings[name].push(trial(name === "scan" ? scanned : indexed));
}
assert.equal(
  new Set(
    Object.values(timings)
      .flat()
      .map((r) => r.count),
  ).size,
  1,
);
console.log(
  JSON.stringify(
    {
      revision,
      documents: rows.length,
      segments: segments.length,
      syntheticDeletes: rows.filter((r) => r.deleted).length,
      exactQueries: requests.length,
      countedIntersections,
      countBatchQueries: andQueries.length * 12,
      countMedianMilliseconds: Object.fromEntries(Object.entries(countTimes)
        .map(([k,times]) => [k,times.toSorted((x,y)=>x-y)[2]])),
      medianMilliseconds: Object.fromEntries(
        Object.entries(timings).map(([key, vals]) => [
          key,
          vals.map((v) => v.ms).sort((a, b) => a - b)[2],
        ]),
      ),
      matchedIdsPerBatch: timings.scan[0].count,
    },
    null,
    2,
  ),
);
