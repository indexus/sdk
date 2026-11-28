// Produce the inputs with Go's scripts/research/wirepresence at ccf56d2.
// Run: node scripts/perf/ixb2-presence-schema.mjs /path/to/generated-blocks
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {decodeBlocks,suffixAt} from "../../src/wire/block.js";
import {presenceMasks} from "../../src/walk/presence.js";

const dir = process.argv[2];
const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
let checks = 0;
for (const precision of ["f32","f64"]) {
  for (const variant of ["all","selected","wide","wide-selected","wide-padded","wide-redirect"]) {
    const response = decodeBlocks(Uint8Array.from(readFileSync(join(dir,precision+"-"+variant+".bin"))));
    const wide = variant.startsWith("wide");
    const schema = {revision:"fixture/1",columns:Array.from({length:wide ? 300 : 8},(_,i)=>"category-"+i)};
    const requested = [...schema.columns.keys(),511];
    const source = new Set(response.columns ?? requested.slice(0,-1));
    for (const b of response.blocks) {
      for (let row=0;row<b.n;row++) {
        const key = suffixAt(b,row);
        const mask = alphabet.indexOf(key[0])*64 + alphabet.indexOf(key[1]);
        const witnesses = wide ? (key === "A" ? [0,63,65,257] : [1,64,299]) :
          Array.from({length:8},(_,i)=>i).filter(i=>mask & (1<<i));
        if (wide) assert.ok(key === "A" || key === "B");
        const metrics = Array.from({length:b.metricCount},(_,i)=>b.metrics[i*b.n+row]);
        const part = {complete:true,schema,response:{...response,blocks:[{n:1,metricCount:b.metricCount,metrics}]}};
        for (const columns of [requested,requested.toReversed()]) {
          const {present,absent} = presenceMasks([part],columns,{schema});
          for (const [index,col] of columns.entries()) {
            const bit = 1n << BigInt(index);
            const valid = col < schema.columns.length && source.has(col);
            const seen = valid && witnesses.includes(col);
            assert.equal(Boolean(present & bit),seen);
            assert.equal(Boolean(absent & bit),valid && !seen && !response.redirects.length);
            checks++;
          }
        }
      }
    }
    if (variant==="wide-padded") {
      const part = {complete:true,schema,response};
      assert.deepEqual(presenceMasks([part],[511,2],{schema}),{present:0n,absent:2n});
      assert.deepEqual(presenceMasks([part],[511,2]),{present:0n,absent:0n});
    }
  }
}
console.log(JSON.stringify({goBlocks:12,checkedBitClassifications:checks,padded511:"unknown",validZero2:"absent"}));
