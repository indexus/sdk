import test from "node:test";
import assert from "node:assert/strict";
import { buildBM25Index } from "./bm25.js";

const index = buildBM25Index([], { raw: 1, words: 1 }, {
  fieldAnalyzers: { words: "latin-folded-words-v1" },
});

test("UTF-16 source offsets survive accent folding, surrogate pairs and punctuation", () => {
  const source = "😀 ÉCOLE, e\u0301cole!";
  const result = index.highlightTokens("words", source, "école ECOLE");
  assert.deepEqual(result, [{ start: 3, end: 8 }, { start: 10, end: 16 }]);
  assert.deepEqual(result.map(({ start, end }) => source.slice(start, end)), ["ÉCOLE", "e\u0301cole"]);
  assert.deepEqual(index.highlightTokens("raw", source, "école"), []);
  assert.deepEqual(index.highlightTokens("raw", source, "😀 ÉCOLE,"), [{ start: 0, end: 2 }, { start: 3, end: 9 }]);
  assert.deepEqual(index.highlightTokens("words", "ΑΣ’Α", "ασ"), [{ start: 0, end: 2 }]);
  assert.deepEqual(index.highlightTokens("words", "ΑΣ’Α", "ας"), []);
});

test("independent source-span oracle with mixed scripts and combining marks", () => {
  // Each entry gives its original spelling and expected normalized token.
  const lexicon = [
    ["Cafe\u0301", "cafe"], ["CAFÉ", "cafe"], ["İ", "i"], ["I\u0307", "i"],
    ["한", "한"], ["한", "한"], ["Å\u0327", "a"], ["\u{10400}", "\u{10428}"],
    ["अक्षर", "अक्षर"], ["Ж", "ж"], ["か\u3099", "が"], ["が", "が"],
    ["Ａ", "ａ"], ["１２３", "１２３"], ["AΣ", "aς"],
  ];
  const separators = ["! ", "👩‍🔧 ", ",", "\n", " — ", "\t", ";"];
  const occurrences = [];
  let source = "🧑‍💻\u0308 ";
  for (let i = 0; i < 211; i++) {
    const [word, token] = lexicon[i * 7 % lexicon.length];
    const start = source.length;
    source += word;
    occurrences.push({ token, start, end: source.length });
    source += separators[i % separators.length];
  }
  for (const [query, token] of lexicon) {
    const expected = occurrences.filter(x => x.token === token).map(({ start, end }) => ({ start, end }));
    assert.deepEqual(index.highlightTokens("words", source, query), expected, query);
  }
});

test("empty, repeated and invalid inputs", () => {
  assert.deepEqual(index.highlightTokens("words", "abc abc", "abc abc"), [{ start: 0, end: 3 }, { start: 4, end: 7 }]);
  assert.deepEqual(index.highlightTokens("words", "abc", "!!!"), []);
  assert.deepEqual(index.highlightTokens("raw", "", "x"), []);
  assert.throws(() => index.highlightTokens("no", "x", "x"), RangeError);
  assert.throws(() => index.highlightTokens("raw", undefined, ""), TypeError);
  assert.throws(() => index.highlightTokens("raw", "x", null), TypeError);
});
