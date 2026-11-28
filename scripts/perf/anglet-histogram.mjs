// node scripts/perf/anglet-histogram.mjs /path/to/anglet-1km/context/batiment.geojson
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { histogramQuantile, mergeNumericHistograms, numericHistogram } from "../../src/index.js";

const data = readFileSync(process.argv[2]);
const rows = JSON.parse(data).features;
const height = feature => feature.properties.hauteur;
const bounds = [2,4,6,8,10,15,20];
const partial = Array.from({length:7},()=>[]);
rows.forEach((feature,i)=>partial[i % partial.length].push(feature));
const merged = mergeNumericHistograms(partial.map(part=>numericHistogram(part,height,bounds)));
assert.deepEqual(merged,numericHistogram(rows,height,bounds));
const sorted = rows.map(height).filter(Number.isFinite).sort((a,b)=>a-b);
const exactCounts = bounds.map((upper,i)=>sorted.filter(v=>v<upper && (i===0 || v>=bounds[i-1])).length);
exactCounts.push(sorted.filter(v=>v>=bounds.at(-1)).length);
assert.deepEqual(merged.counts,exactCounts);
assert.equal(merged.missing,rows.length-sorted.length);
const tracked = mergeNumericHistograms(partial.map(part=>numericHistogram(part,height,bounds,{trackExtrema:true})));
assert.deepEqual(tracked,numericHistogram(rows,height,bounds,{trackExtrema:true}));
function check(q,histogram) {
  const estimate = histogramQuantile(histogram,q,{estimate:"midpoint"});
  const exact = sorted[Math.max(0,Math.ceil(q*sorted.length)-1)];
  const {lowerInclusive:lo, upperExclusive:hi}=estimate;
  assert.ok((lo===null || lo<=exact) && (hi===null || exact<hi));
  if (estimate.estimateRange) {
    const {lower,upper,upperInclusive}=estimate.estimateRange;
    for (const x of [exact,estimate.estimate])
      assert.ok(lower<=x && (upperInclusive ? x<=upper : x<upper));
  } else if (lo===null || hi===null) assert.equal(estimate.estimate,null);
  else assert.ok(estimate.estimate>=lo && estimate.estimate<hi);
  return {q,...estimate,exact};
}
function report(histogram) {
  const checks=Array.from({length:1001},(_,i)=>check(i/1000,histogram));
  const errors=checks.filter(x=>x.estimate!==null).map(x=>Math.abs(x.estimate-x.exact));
  return {histogram, oracleQuantiles:checks.length, scalarEstimates:errors.length,
    withoutEstimate:checks.length-errors.length,
    meanAbsoluteErrorMeters:errors.reduce((a,b)=>a+b,0)/errors.length,
    maximumAbsoluteErrorMeters:Math.max(...errors), quantiles:[0,0.25,0.5,0.9,0.95,0.99,1].map(q=>check(q,histogram))};
}
console.log(JSON.stringify({sha256:createHash("sha256").update(data).digest("hex"),
  rows:rows.length,finite:sorted.length,partitions:partial.length,
  ...report(merged), withExtrema:report(tracked)},null,2));
