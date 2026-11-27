import test from 'node:test';
import assert from 'node:assert/strict';
import {Local} from './index.js';
import {Collection,Space} from '../tree/index.js';
import {Item} from '../tree/item.js';
import {Set as Zone} from '../tree/set.js';
function fixture({gps=false,projected=false,step=10}={}){
 const definition=gps?[{name:'gps',type:'spherical',args:[-90,90,-180,180]}]:[{name:'value',type:'linear',args:[0,1000]}];
 const name=gps?'AnnularGpsTest01':'AnnularLinear001',collection=new Collection(name,definition);
 const space=new Space(collection.dimensions(),collection.mask(),collection.offset()),dimension=space.dimension(0);
 const origin=gps?[1,1]:[501],centre=gps?[[1.01,1.01]]:[[507]],hash=space.encode(space.newPoint(centre),1);
 const entries=gps?[["inner",[1.01,1.01]],["eligible",[1.06,1.04]],["outer",[1.2,1.2]]]:[["inner",[502]],["eligible",[507]],["next",[509]],["outer",[513]]];
 const rows=(projected?entries.filter(([id])=>id==='eligible'):entries).map(([id,coordinates])=>{
  const item=new Item(name,space.encode(space.newPoint([coordinates]),16),[1],id);item._terminal=true;
  assert.ok(item.hash().startsWith(hash));return item;
 });
 const zone=projected?new Item(name,hash,[1],'projection'):new Zone(name,hash,rows.length,[rows.length]);
 if(projected)zone._terminal=false;
 const emitted=[],reads=[];
 const network={readOptions:()=>({method:'getSet'}),getConcurrency:()=>2,getSet:async(_name,location)=>{
  reads.push(['sets',location]);if(location==='@')return [zone];assert.equal(location,hash);return rows;
 }};
 if(projected)network.getRecords=async(_name,location)=>{reads.push(['records',location]);assert.equal(location,hash);return rows;};
 const local=new Local({[name]:space},{cap:1,step,origins:{[dimension.name()]:dimension.newPoint(origin)},filters:{[dimension.name()]:dimension.newFilter([5,10],gps?[0,0]:[0])}},{send:items=>emitted.push(...items)},{send(){}},network);
 return {local,emitted,reads,hash,dimension,zone,origin,space};
}
test('linear annulus descends a zone inside the minimum bound and filters the final records',async()=>{
 const f=fixture();assert.equal(f.dimension.segmentDistance(f.dimension.newPoint(f.origin),f.space.decode(f.hash)[0]),0);
 await f.local.search();assert.deepEqual(f.emitted.map(item=>item.id()),['eligible','next']);
 assert.deepEqual(f.reads,[['sets','@'],['sets',f.hash]]);
});
test('GPS annulus does not prune an intersecting zone whose lower bound is inside the hole',async()=>{
 const f=fixture({gps:true});await f.local.search();assert.deepEqual(f.emitted.map(item=>item.id()),['eligible']);
 assert.deepEqual(f.reads,[['sets','@'],['sets',f.hash]]);
});
test('projected cells keep annular candidates until their terminal records are read',async()=>{
 const f=fixture({projected:true});await f.local.search();assert.deepEqual(f.emitted.map(item=>item.id()),['eligible']);
 assert.deepEqual(f.reads,[['sets','@'],['records',f.hash]]);
});
test('annular pagination continues the same walk without rereading the coarse zone',async()=>{
 const f=fixture({step:1});await f.local.search();assert.deepEqual(f.emitted.map(item=>item.id()),['eligible']);
 await f.local.search();assert.deepEqual(f.emitted.map(item=>item.id()),['eligible','next']);
 assert.deepEqual(f.reads,[['sets','@'],['sets',f.hash]]);
});
