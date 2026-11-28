import test from "node:test";
import assert from "node:assert/strict";
import { buildBM25Index } from "./bm25.js";

// Independent dynamic-programming oracle. The implementation uses a single
// mismatch and suffix comparison, whereas this enumerates all edit paths.
function distance(left, right) {
  const a = Array.from(left), b = Array.from(right);
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (const char of a) {
    const next = [row[0] + 1];
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(row[j + 1] + 1, next[j] + 1, row[j] + Number(char !== b[j])));
    }
    row = next;
  }
  return row[b.length];
}

test("one edit agrees with exhaustive Unicode Levenshtein for every query and dictionary budget", () => {
  const alphabet = ["a", "b", "🧱"];
  let words = [...alphabet];
  for (let length = 2; length <= 3; length++) {
    words.push(...words.filter(w => Array.from(w).length === length - 1).flatMap(w => alphabet.map(c => w+c)));
  }
  const docs = words.map((word, i) => ({ id: String(i), body: word }));
  const index = buildBM25Index(docs, { body: 1 });
  for (const query of words) {
    for (let budget = 0; budget <= words.length + 1; budget++) {
      const expected = docs.slice(0, budget).filter(d => distance(query, d.body) <= 1).map(d => d.id);
      assert.deepEqual(index.matchFuzzyToken("body", query, { maxDictionaryTerms: budget }), {
        ids: expected, examinedTerms: Math.min(budget, words.length), complete: budget >= words.length,
      });
    }
  }
});

test("field analyzer, source order, duplicate postings and transposition", () => {
  const docs = [
    { id: "z", title: "École école: écoles", tag: "ab" },
    { id: "a", title: "colle; école", tag: "ba" },
    { id: "c", title: "Ecolx" }, { id: "d", title: null },
  ];
  const index = buildBM25Index(docs, { title: 1, tag: 1 }, { fieldAnalyzers: { title: "latin-folded-words-v1" } });
  assert.deepEqual(index.matchFuzzyToken("title", "ÉCOLE!"), { ids: ["z","a","c"], examinedTerms: 4, complete: true });
  assert.deepEqual(index.matchFuzzyToken("tag", "AB").ids, ["z"]);
  assert.deepEqual(index.matchFuzzyToken("title", "!"), { ids: [], examinedTerms: 0, complete: true });
  assert.deepEqual(buildBM25Index([], { tag: 1 }).matchFuzzyToken("tag","x",{ maxDictionaryTerms: 0 }),
    { ids: [], examinedTerms: 0, complete: true });
  assert.throws(() => index.matchFuzzyToken("title","two terms"), RangeError);
  assert.throws(() => index.matchFuzzyToken("absent","x"), RangeError);
  assert.throws(() => index.matchFuzzyToken("tag",null), TypeError);
  for (const n of [-1, 2.5, Infinity, "3"]) {
    assert.throws(() => index.matchFuzzyToken("tag", "x", { maxDictionaryTerms: n }), RangeError);
  }
});

test("default budget reports partial matches; an exact hit beyond it needs more terms", () => {
  const docs = Array.from({ length: 257 }, (_, i) => ({ id: String(i), text: i === 256 ? "house" : String(i) }));
  const index = buildBM25Index(docs, { text: 1 });
  assert.deepEqual(index.matchFuzzyToken("text","house"), { ids: [], examinedTerms: 256, complete: false });
  assert.deepEqual(index.matchFuzzyToken("text","house", { maxDictionaryTerms: 257 }),
    { ids: ["256"], examinedTerms: 257, complete: true });
});
