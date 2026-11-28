// node scripts/perf/anglet-presence-facets.mjs /path/to/anglet/context/batiment.geojson
// Offline composition example. Source and counts are generated together from
// one immutable file; a live response would require its own coverage proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { numericFacet, presenceMasks } from "../../src/index.js";

const input = await readFile(process.argv[2]);
const manifestHash = createHash("sha256").update(input).digest("hex");
const { features } = JSON.parse(input);
const rows = features.map(({ geometry, properties: p }) => {
  const rings = geometry.type === "MultiPolygon" ? geometry.coordinates[0] : geometry.coordinates;
  assert.ok(geometry.type === "Polygon" || geometry.type === "MultiPolygon");
  const [x, y] = rings[0][0];
  return { id: p.cleabs, usage: p.usage_1, height: p.hauteur, x, y };
});
assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
const vocab = [...new Set(rows.map((r) => r.usage))].sort();
const xs = rows.map((r) => r.x);
const ys = rows.map((r) => r.y);
const bounds = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
function cell(value, min, max) {
  return max === min ? 0 : Math.min(31, Math.floor(32 * (value - min) / (max - min)));
}
const groups = new Map();
for (const r of rows) {
  const zone = cell(r.x, ...bounds.slice(0, 2)) + 32 * cell(r.y, ...bounds.slice(2));
  if (!groups.has(zone)) groups.set(zone, []);
  groups.get(zone).push(r);
}

function heightBucket(r) {
  return Number.isFinite(r.height) ? 5 * Math.floor(r.height / 5) : null;
}
const sourceDir = await mkdtemp(join(tmpdir(), "indexus-facets-"));
try {
  // Export in the same decoded one-row column-major layout as API.getSets.
  // Keep a separate file for each zone's documents so skips avoid real reads.
  const cells = [];
  for (const [zone, records] of groups) {
    const counts = new Array(vocab.length).fill(0);
    for (const r of records) counts[vocab.indexOf(r.usage)]++;
    const path = join(sourceDir, zone + ".json");
    await writeFile(path, JSON.stringify(records.map(({id,usage,height}) => ({id,usage,height}))));
    const response = { columns: null, redirects: [], blocks: [{ n:1, metricCount:vocab.length, metrics:counts }] };
    cells.push({ path, response, hash:manifestHash });
  }
  // Only the metadata catalog is resident. Each chosen block is fetched from
  // a file and its documents still have to match the requested category.
  console.log("source_sha256=" + manifestHash + " documents=" + rows.length + " cells=" + cells.length);
  console.log("usage,oracle_matches,full_reads,pruned_reads,incomplete_reads");
  for (const [column,usage] of vocab.entries()) {
    const want = rows.filter((r) => r.usage === usage);
    const wantIDs = want.map((r) => r.id).sort();
    const wantFacet = numericFacet(want, heightBucket);
    const tally = [];
    for (const coveredHash of [manifestHash, null]) {
      const matches = [];
      let reads = 0;
      for (const { path, response, hash } of cells) {
        const mask = presenceMasks([{ response, complete: hash === coveredHash }], [column]);
        if ((mask.absent & 1n) !== 0n) continue;
        const records = JSON.parse(await readFile(path, "utf8"));
        reads++;
        for (const r of records) if (r.usage === usage) matches.push(r);
      }
      assert.deepEqual(matches.map((r) => r.id).sort(), wantIDs);
      assert.deepEqual(numericFacet(matches, heightBucket), wantFacet);
      if (coveredHash === null) assert.equal(reads, cells.length);
      tally.push(reads);
    }
    console.log([usage,want.length,cells.length,...tally].join(","));
  }
} finally {
  await rm(sourceDir, {recursive:true,force:true});
}
