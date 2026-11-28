import assert from "node:assert/strict";
import test from "node:test";
import {documentFilter as f} from "../index.js";

test("whole-field glob handles arrays, nulls, literals and nonoverlapping anchors", () => {
  const test=(pattern,value)=>f.glob(x=>x,pattern)(value);
  assert.equal(test("r*é*日",["no","ré/\n😀日"]),true);
  assert.equal(test("a*a","a"),false);
  assert.equal(test("a*aa*a","aaa"),false);
  assert.equal(test("a*aa*a","aaaa"),true);
  assert.equal(test(".*.txt","./file.txt"),true);
  assert.equal(test("a+b","abb"),false);
  assert.equal(test("*",""),true);
  assert.equal(test("",""),true);
  assert.equal(test("","X"),false);
  assert.equal(test("S*","small"),false);
  for(const value of [[],null,undefined]) assert.equal(test("*",value),false);
  assert.equal(f.not(f.glob(x=>x,"*"))(null),true);
  for(const value of [1,{},["match",null],["match",42]]) assert.throws(()=>test("*",value),TypeError);
  for(const pattern of ["?","[ab]","{x,y}","a**b","a\\b"]) assert.throws(()=>f.glob(x=>x,pattern),RangeError);
});

test("agrees with an exhaustive recursive wildcard oracle on short input", () => {
  function words(alphabet,max) {
    const all=[""];
    let start=0;
    for(let size=0;size<max;size++) {
      const end=all.length;
      for(let i=start;i<end;i++) for(const c of alphabet) all.push(all[i]+c);
      start=end;
    }
    return all;
  }
  function oracle(pattern,text) {
    if(!pattern.length) return !text.length;
    if(pattern[0]==="*") {
      for(let n=0;n<=text.length;n++) if(oracle(pattern.slice(1),text.slice(n))) return true;
      return false;
    }
    return text[0]===pattern[0] && oracle(pattern.slice(1),text.slice(1));
  }
  const texts=words("ab",5);
  for(const pattern of words("ab*",5).filter(p=>!p.includes("**"))) {
    const matches=f.glob(x=>x,pattern);
    for(const text of texts) assert.equal(matches(text),oracle(pattern,text),JSON.stringify([pattern,text]));
  }
});

test("codepoint glob matches one Unicode code point and quotes only metacharacters",()=>{
  const match=(pattern,value)=>f.glob(x=>x,pattern,{syntax:"codepoint"})(value);
  assert.equal(match("?", "😀"),true);
  assert.equal(match("?", "é"),true);
  assert.equal(match("?", "e\u0301"),false);
  assert.equal(match("??", "e\u0301"),true);
  assert.equal(match("?", "\n"),true);
  assert.equal(match("?", "👩‍💻"),false);
  assert.equal(match("???", "👩‍💻"),true);
  assert.equal(match("é", "e\u0301"),false);
  assert.equal(match(String.raw`file-?\*.txt`,["","file-😀*.txt"]),true);
  for(const c of "*?[]{}\\") assert.equal(match("\\"+c,c),true);
  for(const p of ["\\","\\a","**","[a]","{a,b}"]) assert.throws(()=>match(p,""),RangeError);
  assert.throws(()=>f.glob(x=>x,"?",{syntax:"other"}),RangeError);
  assert.throws(()=>f.glob(x=>x,"?"),RangeError);
  assert.throws(()=>match("*",["matched",null]),TypeError);
});

test("opt-in matcher agrees with an independent Unicode regex oracle",()=>{
  const atoms=[["a","a"],["😀","😀"],["?","."],["*",".*"],["\\*","\\*"],["\\?","\\?"],["\\\\","\\\\"]];
  const texts=["","a","😀","é","*","?","\\","\n"];
  const cases=[...texts,...texts.flatMap(a=>texts.map(b=>a+b))];
  for(const [a,ra] of atoms) for(const [b,rb] of atoms) for(const [c,rc] of atoms){
    if((a==="*"&&b==="*")||(b==="*"&&c==="*"))continue;
    const sdk=f.glob(x=>x,a+b+c,{syntax:"codepoint"});
    const oracle=new RegExp("^(?:"+ra+rb+rc+")(?![\\s\\S])","su");
    for(const text of cases) assert.equal(sdk(text),oracle.test(text),JSON.stringify([a+b+c,text]));
  }
});
