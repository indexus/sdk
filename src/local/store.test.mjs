import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "./store.js";

test("sorting after additions merges the unread suffix with stable distance ties",()=>{
  const entry=(id,d)=>({id,count:()=>1,distance:()=>d});
  const a=entry("a",1),b=entry("b",2),c=entry("c",2),d=entry("d",0);
  const s=new Store();
  s.concat([a,b]);s.sort();s.remove(1,1);
  assert.equal(s.at(0),b);
  s.add(c);s.add(d);s.sort();
  assert.deepEqual(s.list,[d,b,c]);
  assert.equal(s.count,3);
  s.remove(3,3);s.add(a);
  assert.equal(s.length,1);assert.deepEqual(s.list,[a]);
});
