import assert from "node:assert/strict";
import test from "node:test";
import { buildBM25Index, mergeBM25Statistics } from "js-indexus-sdk";

const weights = { title: 2, body: 1 };
const docs = [
  { id: "a", title: "Tower TOWER" },
  { id: "b", title: "park", body: "tower" },
  { id: "c", title: "TOWER", body: "park" },
  { id: "d", title: null, body: "tower park" },
  { id: "e", title: " " },
];

test("field weights, token frequency, field lengths and nulls match the exhaustive formula", () => {
  const index = buildBM25Index(docs, weights);
  const idf = Math.log1p(1.5 / 2.5); // 2 of 3 nonempty documents, independently for each field.
  const score = (tf, length) => idf * 2.2 * tf / (tf + 1.2 * (0.25 + 0.75 * length / (4 / 3)));
  const expected = [
    ["a", 2 * score(2, 2)], ["c", 2 * score(1, 1)],
    ["b", score(1, 1)], ["d", score(1, 2)],
  ];
  const hits = index.search(" Tower tower ");
  assert.deepEqual(hits.map(h => h.id), expected.map(([id]) => id));
  hits.forEach((h, i) => assert.ok(Math.abs(h.score - expected[i][1]) < 1e-12));
  assert.deepEqual(index.search("absent"), []);
  assert.deepEqual(index.search("  "), []);
  assert.deepEqual(index.search("tower", {limit: 0}), []);
});

test("partition rankings use the same global statistics as one index", () => {
  const parts = [buildBM25Index(docs.slice(0, 2), weights), buildBM25Index(docs.slice(2), weights)];
  const whole = buildBM25Index(docs, weights);
  for (const query of ["tower", "park tower"]) {
    const global = JSON.parse(JSON.stringify(mergeBM25Statistics(parts.map(p => p.statistics(query)))));
    assert.deepEqual(global, whole.statistics(query));
    for (const limit of [1, 3, 5]) {
      const mixed = parts.flatMap(p => p.search(query, {statistics: global, limit}));
      mixed.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      assert.deepEqual(mixed.slice(0, limit), whole.search(query, {limit}));
    }
  }
});

test("rejects ambiguous IDs, inconsistent statistics and malformed text", () => {
  assert.throws(() => buildBM25Index([docs[0], docs[0]], weights));
  assert.throws(() => buildBM25Index([{id: "x", title: 0}], weights));
  const index = buildBM25Index(docs, weights);
  const own = index.statistics("tower");
  const stale = buildBM25Index([], weights).statistics("tower");
  assert.throws(() => index.search("tower", {statistics: stale}));
  assert.throws(() => index.search("park", {statistics: own}));
  assert.throws(() => mergeBM25Statistics([own, index.statistics("park")]));
});

test("the explicit default preserves legacy query statistics and token boundaries", () => {
  const docs = [{id: "a", title: "CAFÉ-Crème"}, {id: "b", title: "café"}];
  const legacy = buildBM25Index(docs, {title:1});
  const explicit = buildBM25Index(docs, {title:1}, {analyzer:"lowercase-whitespace-v1"});
  const saved = {analyzer:"lowercase-whitespace-v1", terms:["café"],
    fields:[{name:"title", count:2, length:2, df:[1]}]};
  assert.deepEqual(legacy.statistics("CAFÉ"), saved);
  assert.deepEqual(explicit.statistics("CAFÉ"), saved);
  assert.deepEqual(explicit.search("CAFÉ", {statistics:saved}), legacy.search("CAFÉ"));
  assert.deepEqual(legacy.search("cafe"), []);
});

test("Latin-folded words use identical query and corpus analysis across partitions", () => {
  const config = {analyzer:"latin-folded-words-v1"};
  const documents = [{id:"a", title:"CAFÉ-Crème!"}, {id:"b", title:"cafe\u0301 cafe"},
    {id:"c",title:"123"}, {id:"d",title:"…"}, {id:"e",title:"שָׁלוֹם"}];
  const whole = buildBM25Index(documents, {title:1}, config);
  const parts = [documents.slice(0,2),documents.slice(2)].map(rows=>buildBM25Index(rows,{title:1},config));
  const query = " CAFÉ/cafe ";
  // Hand-tokenized corpus: [cafe,creme], [cafe,cafe], [123], [], [שָׁלוֹם].
  const expected = {analyzer:config.analyzer, terms:["cafe"],
    fields:[{name:"title", count:4, length:6, df:[2]}]};
  const stats = mergeBM25Statistics(parts.map(idx=>idx.statistics(query)));
  assert.deepEqual(stats, expected);
  assert.deepEqual(whole.statistics(query), expected);
  const score = tf => Math.log(2) * (2.2 * tf) / (tf + 1.2 * (0.25 + 0.75 * 2 / 1.5));
  const hits = whole.search(query);
  assert.deepEqual(hits.map(h=>h.id), ["b","a"]);
  [2,1].forEach((tf,i)=>assert.ok(Math.abs(hits[i].score-score(tf))<1e-12));
  const joined=parts.flatMap(idx=>idx.search("cafe", {statistics:JSON.parse(JSON.stringify(stats))}));
  assert.deepEqual(joined.sort((a,b)=>b.score-a.score), hits);
  assert.deepEqual(whole.search("123").map(h=>h.id), ["c"]);
  assert.deepEqual(whole.search("שלום"), []);
  assert.deepEqual(whole.search("שָׁלוֹם").map(h=>h.id), ["e"]);
});

test("incompatible analyzers are rejected even when a query produces identical terms", () => {
  const docs = [{id:"a",title:"word"}];
  const standard=buildBM25Index(docs,{title:1});
  const folded=buildBM25Index(docs,{title:1},{analyzer:"latin-folded-words-v1"});
  const old=standard.statistics("word"), newer=folded.statistics("word");
  assert.deepEqual(old.terms,newer.terms);
  assert.throws(()=>mergeBM25Statistics([old,newer]), /analyzer/);
  assert.throws(()=>standard.search("word",{statistics:newer}), /Incompatible/);
  assert.throws(()=>folded.search("word",{statistics:old}), /Incompatible/);
  assert.throws(()=>buildBM25Index(docs,{title:1},{analyzer:"unknown"}), /Unknown/);
  assert.throws(()=>mergeBM25Statistics([{...old,analyzer:"unknown"}]), /Unknown/);
});

test("mixed title and body analysis composes across four partitions against hand-counted BM25", () => {
  const documents = [
    {id:"a", title:"CAFÉ-Crème", body:"café! café!"},
    {id:"b", title:"un café", body:"café"},
    {id:"c", title:"thé", body:"CAFÉ!"},
    {id:"d", body:"cafe"},
  ];
  const weights = {title:2, body:1};
  const folded = "latin-folded-words-v1", literal = "lowercase-whitespace-v1";
  const options = {fieldAnalyzers:{title:folded}};
  const whole = buildBM25Index(documents, weights, options);
  const parts = documents.map(doc => buildBM25Index([doc], weights, options));
  const query = "CAFÉ!";
  const stats = parts.map(part => part.statistics(query));
  const merged = mergeBM25Statistics(stats);
  assert.deepEqual(merged, {
    analyzer:"per-field-v1",
    fields:[
      {name:"body",analyzer:literal,terms:["café!"],count:4,length:5,df:[2]},
      {name:"title",analyzer:folded,terms:["cafe"],count:3,length:5,df:[2]},
    ],
  });
  assert.deepEqual(mergeBM25Statistics([mergeBM25Statistics(stats.slice(0,2)),mergeBM25Statistics(stats.slice(2))]), merged);
  const titleScore = 2 * Math.log(1 + 1.5/2.5) * 2.2 / (1 + 1.2*(0.25+0.75*2/(5/3)));
  const bodyScore = (tf, length) => Math.log(1 + 2.5/2.5)*2.2*tf / (tf + 1.2*(0.25+0.75*length/1.25));
  const expected = [{id:"a",score:titleScore+bodyScore(2,2)},{id:"b",score:titleScore},{id:"c",score:bodyScore(1,1)}]
    .sort((a,b)=>b.score-a.score);
  const partitioned = parts.flatMap(p=>p.search(query,{statistics:JSON.parse(JSON.stringify(merged))})).sort((a,b)=>b.score-a.score);
  assert.deepEqual(whole.search(query), partitioned);
  assert.deepEqual(partitioned.map(hit=>hit.id), expected.map(hit=>hit.id));
  partitioned.forEach((hit,i)=>assert.ok(Math.abs(hit.score-expected[i].score)<1e-12));
  const bad = structuredClone(merged);
  bad.fields[0].terms.push("café!");
  bad.fields[0].df.push(2);
  assert.throws(()=>mergeBM25Statistics([bad]), /Invalid/);
  const reversed = buildBM25Index(documents,weights,{fieldAnalyzers:{body:folded}});
  const wrong = reversed.statistics("test");
  assert.throws(()=>mergeBM25Statistics([whole.statistics("test"),wrong]), /Incompatible/);
  assert.throws(()=>whole.search("test",{statistics:wrong}), /Incompatible/);
  const old = buildBM25Index(documents,weights,{analyzer:folded}).statistics(query);
  assert.deepEqual(buildBM25Index(documents,weights,{fieldAnalyzers:{title:folded,body:folded}}).statistics(query),old);
  assert.throws(()=>mergeBM25Statistics([old,merged]), /Incompatible/);
  assert.throws(()=>buildBM25Index(documents,weights,{fieldAnalyzers:{other:folded}}), /configured/);
  assert.throws(()=>buildBM25Index(documents,weights,{fieldAnalyzers:{title:"bad"}}), /Unknown/);
});

test("query-time k1 and b reuse global statistics across partitions", () => {
  const rows = [
    {id:"a", title:"go go go off off off"}, {id:"b",title:"go"},
    {id:"c", title:"go off off"}, {id:"d",title:"off off"},
  ];
  const all = buildBM25Index(rows,{title:1});
  const parts = rows.map(row=>buildBM25Index([row],{title:1}));
  const stats = mergeBM25Statistics(parts.map(p=>p.statistics("go")));
  const defaults = all.search("go");
  assert.deepEqual(defaults,all.search("go",{k1:1.2,b:0.75}));
  const idf = Math.log(1 + 1.5/3.5);
  const order = (x,y)=>y.score-x.score||x.id.localeCompare(y.id);
  for (const [k1,b] of [[0,1],[0,0],[2,0],[2,1],[0.6,0.9],[Number.MAX_VALUE,1]]) {
    // Census: 4 fields, total length 12, exactly 3 matching documents.
    const expected = [["a",3,6],["b",1,1],["c",1,3]].map(([id,tf,length])=>{
      const adjusted = (1-b) + b*length/3;
      // Reciprocal form remains finite for the largest k1.
      const saturation = k1 === 0 ? 1 : (1+1/k1)/(1/k1+adjusted/tf);
      return {id,score:idf*saturation};
    }).sort(order);
    const partitioned = parts.flatMap(p=>p.search("go",{statistics:stats,k1,b})).sort(order);
    assert.deepEqual(partitioned,all.search("go",{k1,b}));
    assert.deepEqual(partitioned.map(x=>x.id),expected.map(x=>x.id));
    partitioned.forEach((x,i)=>assert.ok(Math.abs(x.score-expected[i].score)<1e-12));
  }
  assert.deepEqual(all.search("go"),defaults);
  for(const options of [{k1:-1},{k1:Infinity},{k1:null},{b:-0.01},{b:1.01},{b:NaN},{b:"0"}]) {
    assert.throws(()=>all.search("missing",options),RangeError);
  }
});

test("phrase filtering uses the chosen field analyzer, order and adjacent repeated tokens", () => {
  const rows = [
    {id:"a",title:"Au CAFÉ-crème",body:"Au CAFÉ-crème"},
    {id:"b",title:"au café",body:"crème"},
    {id:"c",title:"crème café"},
    {id:"d",title:"a a a b c a a b"},
    {id:"e",title:"a b a b"},
    {id:"f",title:"café noir crème"}, {id:"g",title:null},
  ];
  const index=buildBM25Index(rows,{title:1,body:1},{fieldAnalyzers:{title:"latin-folded-words-v1"}});
  const ids=(field,query)=>Array.from(index.filterPhrase(rows.values(),field,query),r=>r.id);
  assert.deepEqual(ids("title","cafe creme"),["a"]);
  assert.deepEqual(ids("body","cafe creme"),[]);
  assert.deepEqual(ids("body","AU CAFÉ-CRÈME"),["a"]);
  assert.deepEqual(ids("title","a a b"),["d"]);
  assert.deepEqual(ids("title","a b"),["d","e"]);
  assert.deepEqual(ids("title",";;;"),[]);
  assert.throws(()=>ids("other","go"),/field/);
});

test("phrase verification agrees with exhaustive substring enumeration on one-pass candidates", () => {
  const rows=Array.from({length:128},(_,i)=>({
    id:String(i),title:i.toString(2).padStart(7,"0").split("").join(" "),
  }));
  const index=buildBM25Index(rows,{title:1});
  for(let len=1;len<=5;len++) {
    for(let n=0;n<2**len;n++) {
      const pattern=n.toString(2).padStart(len,"0");
      const phrase=[...pattern].join(" ");
      const expected=rows.filter(row=>row.title.replaceAll(" ","").includes(pattern));
      assert.deepEqual([...index.filterPhrase(rows.values(),"title",phrase)],expected);
    }
  }
  let consumed=0;
  function* candidates() { for(const row of rows){consumed++;yield row;} }
  const matches=index.filterPhrase(candidates(),"title","0");
  assert.equal(consumed,0);
  assert.equal(matches.next().value,rows[0]);
  assert.equal(consumed,1);
});

test("token prefixes use the named field's token boundaries and Unicode normalization", () => {
  const rows=[
    {id:"a",title:"CAFÉ-Crème crème",body:"CAFÉ-Crème"},
    {id:"b",title:"PréCafé",body:"crème"},
    {id:"c",title:"𐐀𐐁 Αθήνα"},
    {id:"d",body:null},
  ];
  const index=buildBM25Index(rows,{title:1,body:1},{fieldAnalyzers:{title:"latin-folded-words-v1"}});
  const ids=(field,prefix)=>Array.from(index.filterTokenPrefix(rows.values(),field,prefix),doc=>doc.id);
  assert.deepEqual(ids("title","CAFE\u0301"),["a"]);
  assert.deepEqual(ids("title","CRÈ"),["a"]);
  assert.deepEqual(ids("body","CRÈ"),["b"]);
  assert.deepEqual(ids("title","𐐨"),["c"]);
  assert.deepEqual(ids("title","Αθ"),["c"]);
  assert.deepEqual(ids("title",";"),[]);
  assert.deepEqual(ids("body","   "),[]);
  assert.deepEqual(ids("body","afé"),[]);
  assert.throws(()=>ids("title","café-crème"),/one analyzed/);
  assert.throws(()=>ids("other","x"),/field/);
});

test("prefix filter agrees with enumerated token prefixes and consumes candidates on demand", () => {
  const rows=Array.from({length:128},(_,n)=>({id:String(n),title:`${n.toString(2)} ${(127-n).toString(2)}`}));
  const index=buildBM25Index(rows,{title:1});
  const byPrefix=new Map();
  for (const row of rows) {
    const prefixes=new Set();
    for (const word of row.title.split(" ")) {
      for(let size=1;size<=word.length;size++) prefixes.add(word.slice(0,size));
    }
    for(const prefix of prefixes) {
      if (!byPrefix.has(prefix)) byPrefix.set(prefix,[]);
      byPrefix.get(prefix).push(row.id);
    }
  }
  for(const [prefix,expected] of byPrefix) {
    assert.deepEqual(Array.from(index.filterTokenPrefix(rows.values(),"title",prefix),doc=>doc.id),expected);
  }
  function* unopened() { throw new Error("empty prefixes must not consume candidates"); }
  assert.deepEqual([...index.filterTokenPrefix(unopened(),"title","")],[]);
  let consumed=0;
  function* input() { for(const row of rows){consumed++;yield row;} }
  const matches=index.filterTokenPrefix(input(),"title","0");
  assert.equal(matches.next().value,rows[0]);
  assert.equal(consumed,1);
});

test("field token membership is order-independent and expands only the final token", () => {
  const source=[
    {id:"z",title:"Walnut in the CAFÉ"}, {id:"a",title:"CAFÉ WAL WALRUS walnut"},
    {id:"b",title:"walnut",body:"cafe"}, {id:"d",title:"cafeteria"}, {id:"c",title:null},
  ];
  const index=buildBM25Index(source,{title:1,body:1},{fieldAnalyzers:{title:"latin-folded-words-v1"}});
  const q=(text,opts)=>index.matchTokens("title",text,opts);
  assert.deepEqual(q("cafe walnut"),["z","a"]);
  assert.deepEqual(q("wal cafe"),["a"]);
  assert.deepEqual(q("cafe wal",{lastAsPrefix:true}),["z","a"]);
  assert.deepEqual(q("wal wal",{lastAsPrefix:true}),["a"]);
  assert.deepEqual(q("cafe wal",{mode:"any",lastAsPrefix:true}),["z","a","b"]);
  assert.deepEqual(q("cafe caf",{lastAsPrefix:true}),["z","a"]);
  assert.deepEqual(q("walnut walnut"),["z","a","b"]);
  assert.deepEqual(q("missing walnut",{mode:"any"}),["z","a","b"]);
  assert.deepEqual(q("cafe missing"),[]);
  assert.deepEqual(q("---"),[]);
  assert.deepEqual(index.matchTokens("body","cafe"),["b"]);
  assert.throws(()=>q("go",{mode:"other"})); assert.throws(()=>q("go",{lastAsPrefix:"yes"}));
  assert.throws(()=>index.matchTokens("unknown","go"));
});

test("posting membership matches document scans across all/any and prefix modes", () => {
  const vocab=["a","ab","aba","b","bb","bc"];
  const rows=Array.from({length:64},(_,i)=>({id:String(64-i),title:vocab.filter((_,b)=>i&(1<<b)).join(" ")}));
  const index=buildBM25Index(rows,{title:1});
  for(const first of [...vocab,"x"]) for(const last of [...vocab,"x"])
    for(const mode of ["any","all"]) for(const lastAsPrefix of [true,false]) {
      const expected=rows.filter(row=>{
        const words=row.title.split(" ");
        const left=words.includes(first);
        const right=words.some(word=>lastAsPrefix?word.startsWith(last):word===last);
        return mode==="any"?left||right:left&&right;
      }).map(row=>row.id);
      assert.deepEqual(index.matchTokens("title",first+" "+last,{mode,lastAsPrefix}),expected);
    }
});
