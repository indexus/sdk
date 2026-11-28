// node scripts/perf/anglet-temporal-ranges.mjs /path/to/batiment.geojson
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { documentFilter as f } from "../../src/index.js";

const input = readFileSync(process.argv[2]);
const rows = JSON.parse(input).features.map(x => x.properties);
const ids = rows => rows.map(r=>r.cleabs).sort();
const stats = [];
for (const field of ["date_creation","date_modification"]) {
  const annual = new Map();
  const dates = rows.map(row=>row[field]).filter(v=>v!=null);
  // The independent oracle uses only the calendar year in the UTC source.
  assert.ok(dates.every(v=>typeof v==="string" && v.endsWith("Z")));
  const years = dates.map(v=>Number(v.slice(0,4)));
  for (let year=Math.min(...years);year<=Math.max(...years);year++) {
    const match=f.timeRange(row=>row[field],{gte:year+"-01-01T00:00:00Z",lt:(year+1)+"-01-01T00:00:00Z"});
    const actual=rows.filter(match);
    const expected=rows.filter(row=>row[field]!=null && Number(row[field].slice(0,4))===year);
    assert.deepEqual(ids(actual),ids(expected));
    annual.set(year,actual.length);
  }
  stats.push({field,nonNull:dates.length,missing:rows.length-dates.length,annual:Object.fromEntries(annual)});
}
console.log(JSON.stringify({sha256:createHash("sha256").update(input).digest("hex"),rows:rows.length,stats},null,2));
