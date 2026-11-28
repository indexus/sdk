import { compareIds } from "./compareIds.js";

const defaultAnalyzer = "lowercase-whitespace-v1";
const perField = "per-field-v1";
function analyzer(pattern, normalize) {
  return { pattern, tokenize: text => normalize(text).match(pattern) ?? [] };
}

const analyzers = new Map([
  [defaultAnalyzer, analyzer(/\S+/gu, text => text.toLowerCase())],
  ["latin-folded-words-v1", analyzer(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu, text =>
    text.toLowerCase().normalize("NFD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC"))],
]);

function tokens(text, tokenize) {
  if (typeof text !== "string") throw new TypeError("Expected a text field or query string");
  return tokenize(text);
}

// Compare Unicode code points. Once the first mismatch is found the lengths
// determine which single edit could still make the remaining suffixes equal.
function withinOneEdit(query, word) {
  const term = Array.from(word);
  if (Math.abs(term.length - query.length) > 1) return false;
  let i = 0;
  while (i < query.length && i < term.length && query[i] === term[i]) i++;
  if (i === query.length || i === term.length) return true;
  let j = i;
  if (query.length >= term.length) i++;
  if (term.length >= query.length) j++;
  while (i < query.length && query[i] === term[j]) {
    i++;
    j++;
  }
  return i === query.length && j === term.length;
}

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]);
}

function checkStatistic(field, size) {
  if (!Number.isSafeInteger(field.count) || field.count < 0 ||
      !Number.isSafeInteger(field.length) || field.length < field.count || (field.count === 0 && field.length !== 0) ||
      !Array.isArray(field.df) || field.df.length !== size ||
      field.df.some(df => !Number.isSafeInteger(df) || df < 0 || df > field.count)) {
    throw new RangeError("Invalid BM25 field statistics");
  }
}

function checkSchema(reference, candidate) {
  if (candidate.analyzer !== reference.analyzer || candidate.fields.length !== reference.fields.length ||
      (reference.analyzer !== perField && !sameArray(reference.terms, candidate.terms))) {
    throw new RangeError("Incompatible BM25 analyzer, fields or query");
  }
  reference.fields.forEach((field, i) => {
    const other = candidate.fields[i];
    if (other.name !== field.name || (reference.analyzer === perField &&
        (other.analyzer !== field.analyzer || !sameArray(field.terms, other.terms)))) {
      throw new RangeError("Incompatible BM25 field analyzer or query");
    }
  });
}

// Statistics carry only the dictionary entries needed for this query.
// Sources must cover disjoint documents from the same view.
export function mergeBM25Statistics(parts) {
  if (!parts.length) throw new RangeError("Expected at least one BM25 statistics object");
  const reference = parts[0];
  const { analyzer } = reference;
  const mixed = analyzer === perField;
  if (!Array.isArray(reference.fields) || !reference.fields.length) throw new RangeError("Invalid BM25 fields");
  const fields = reference.fields.map((field, i) => {
    if (!analyzers.has(mixed ? field.analyzer : analyzer)) throw new RangeError("Unknown BM25 analyzer");
    const terms = mixed ? field.terms : reference.terms;
    if (typeof field.name !== "string" || !field.name || (i && field.name <= reference.fields[i-1].name) ||
        !Array.isArray(terms) || terms.some((t, j) => typeof t !== "string" || !t || (j && t <= terms[j-1]))) {
      throw new RangeError("Invalid BM25 field or query terms");
    }
    const schema = mixed ? { analyzer: field.analyzer, terms: [...terms] } : {};
    return { name: field.name, ...schema, count: 0, length: 0, df: terms.map(() => 0) };
  });
  for (const part of parts) {
    checkSchema(reference, part);
    part.fields.forEach((field, i) => {
      const result = fields[i];
      checkStatistic(field, result.df.length);
      result.count += field.count;
      result.length += field.length;
      field.df.forEach((df, j) => { result.df[j] += df; });
    });
  }
  for (const field of fields) checkStatistic(field, field.df.length);
  return mixed ? { analyzer, fields } : { analyzer, terms: [...reference.terms], fields };
}

/** Build a field-weighted BM25 index over immutable client-side documents. */
export function buildBM25Index(documents, weights, { analyzer = defaultAnalyzer, fieldAnalyzers = {} } = {}) {
  if (!analyzers.has(analyzer)) throw new RangeError("Unknown BM25 analyzer");
  const names = Object.keys(weights).sort();
  if (!names.length) throw new RangeError("Expected at least one searchable field");
  if (!fieldAnalyzers || typeof fieldAnalyzers !== "object" || Array.isArray(fieldAnalyzers) ||
      Object.keys(fieldAnalyzers).some(name => !names.includes(name))) {
    throw new TypeError("Expected analyzer overrides for configured fields");
  }
  const fields = names.map(name => {
    const weight = weights[name];
    if (!name || !Number.isFinite(weight) || weight <= 0) throw new RangeError("Invalid BM25 field weight");
    const selected = Object.hasOwn(fieldAnalyzers, name) ? fieldAnalyzers[name] : analyzer;
    const profile = analyzers.get(selected);
    if (!profile) throw new RangeError("Unknown BM25 analyzer");
    return { name, weight, analyzer: selected, ...profile, count: 0, length: 0, lengths: [], postings: new Map() };
  });
  const mixed = fields.some(field => field.analyzer !== fields[0].analyzer);
  const ids = [];
  const seen = new Set();
  for (const doc of documents) {
    if (typeof doc.id !== "string" || !doc.id || seen.has(doc.id)) throw new TypeError("Expected distinct nonempty document IDs");
    const ordinal = ids.length;
    ids.push(doc.id);
    seen.add(doc.id);
    for (const field of fields) {
      const value = Object.hasOwn(doc, field.name) ? doc[field.name] : null;
      const words = value == null ? [] : tokens(value, field.tokenize);
      field.lengths.push(words.length);
      if (!words.length) continue;
      field.count++;
      field.length += words.length;
      for (const word of words) {
        let postings = field.postings.get(word);
        if (!postings) {
          postings = [];
          field.postings.set(word, postings);
        }
        const last = postings.at(-1);
        if (last?.ordinal === ordinal) last.tf++;
        else postings.push({ ordinal, tf: 1 });
      }
    }
  }

  function statistics(query) {
    const termsByAnalyzer = new Map();
    const statisticsFields = fields.map(({ name, analyzer, tokenize, count, length, postings }) => {
      if (!termsByAnalyzer.has(analyzer)) termsByAnalyzer.set(analyzer, [...new Set(tokens(query, tokenize))].sort());
      const terms = termsByAnalyzer.get(analyzer);
      const schema = mixed ? { analyzer, terms: [...terms] } : {};
      return { name, ...schema, count, length, df: terms.map(term => postings.get(term)?.length ?? 0) };
    });
    return mixed ? { analyzer: perField, fields: statisticsFields } :
      { analyzer: fields[0].analyzer, terms: termsByAnalyzer.get(fields[0].analyzer), fields: statisticsFields };
  }

  function search(query, { statistics: global = null, limit = 10, k1 = 1.2, b = 0.75 } = {}) {
    if (!Number.isFinite(k1) || k1 < 0) throw new RangeError("BM25 k1 must be finite and nonnegative");
    if (!Number.isFinite(b) || b < 0 || b > 1) throw new RangeError("BM25 b must be between 0 and 1");
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid BM25 limit");
    const local = statistics(query);
    const stats = global ?? local;
    if (global) checkSchema(local, global);
    const scores = new Map();
    fields.forEach((field, i) => {
      const corpus = stats.fields[i];
      const terms = mixed ? corpus.terms : stats.terms;
      if (global) {
        checkStatistic(corpus, terms.length);
        if (corpus.count < field.count || corpus.length < field.length ||
            corpus.df.some((df, j) => df < local.fields[i].df[j])) throw new RangeError("BM25 statistics do not cover the partition");
      }
      terms.forEach((term, j) => {
        const postings = field.postings.get(term);
        if (!postings) return;
        const df = corpus.df[j];
        const idf = Math.log1p((corpus.count - df + 0.5) / (df + 0.5));
        const avg = corpus.length / corpus.count;
        const weightedIdf = field.weight * idf;
        for (const { ordinal, tf } of postings) {
          const length = field.lengths[ordinal];
          const lengthFactor = 1 - b + b * length / avg;
          let score = weightedIdf;
          if (k1 > Number.MAX_SAFE_INTEGER) {
            // Divide by k1 before multiplying to avoid overflow near Number.MAX_VALUE.
            score *= tf * (1 + 1 / k1) / (tf / k1 + lengthFactor);
          } else if (k1 > 0) {
            score = weightedIdf * ((1 + k1) * tf) / (tf + k1 * lengthFactor);
          }
          const total = (scores.get(ordinal) ?? 0) + score;
          if (!Number.isFinite(total)) throw new RangeError("BM25 score overflow");
          scores.set(ordinal, total);
        }
      });
    });
    const hits = Array.from(scores, ([ordinal, score]) => ({ id: ids[ordinal], score }));
    hits.sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
    return hits.slice(0, limit);
  }
  // Verify only supplied candidates. Keep search postings and their build cost unchanged.
  function* filterPhrase(candidates, name, phrase) {
    const field = fields.find(field => field.name === name);
    if (!field) throw new RangeError("Unknown BM25 phrase field");
    const pattern = tokens(phrase, field.tokenize);
    if (!pattern.length) return;
    // Prefix lengths let overlapping repetitions resume without rescanning tokens.
    const prefix = new Array(pattern.length).fill(0);
    for (let i = 1, j = 0; i < pattern.length; i++) {
      while (j && pattern[i] !== pattern[j]) j = prefix[j - 1];
      if (pattern[i] === pattern[j]) j++;
      prefix[i] = j;
    }
    for (const doc of candidates) {
      if (!Object.hasOwn(doc, name) || doc[name] == null) continue;
      let j = 0;
      for (const word of tokens(doc[name], field.tokenize)) {
        while (j && word !== pattern[j]) j = prefix[j - 1];
        if (word === pattern[j]) j++;
        if (j === pattern.length) {
          yield doc;
          break;
        }
      }
    }
  }
  function* filterTokenPrefix(candidates, name, prefix) {
    const field = fields.find(field => field.name === name);
    if (!field) throw new RangeError("Unknown BM25 prefix field");
    const pattern = tokens(prefix, field.tokenize);
    if (!pattern.length) return;
    if (pattern.length !== 1) throw new RangeError("Expected one analyzed prefix token");
    for (const doc of candidates) {
      if (!Object.hasOwn(doc, name) || doc[name] == null) continue;
      if (tokens(doc[name], field.tokenize).some(word => word.startsWith(pattern[0]))) yield doc;
    }
  }
  /**
   * Return document IDs in input order matching all or any query tokens in one field.
   * lastAsPrefix expands the final analyzed token over the field dictionary.
   * Empty analyzed queries return no IDs. This uses only the existing postings.
   */
  function matchTokens(name, query, { mode = "all", lastAsPrefix = false } = {}) {
    const field = fields.find(field => field.name === name);
    if (!field) throw new RangeError("Unknown BM25 token field");
    if (mode !== "all" && mode !== "any") throw new RangeError("Expected all or any token matching");
    if (typeof lastAsPrefix !== "boolean") throw new TypeError("Expected a boolean lastAsPrefix");
    const terms = tokens(query, field.tokenize);
    if (!terms.length) return [];
    const prefix = lastAsPrefix ? terms.pop() : undefined;
    const exact = new Set(terms);
    const required = exact.size + Number(lastAsPrefix);
    const counts = new Map();
    const countMatch = ordinal => counts.set(ordinal, (counts.get(ordinal) ?? 0) + 1);
    for (const term of exact) {
      const list = field.postings.get(term);
      if (!list) {
        if (mode === "all") return [];
        continue;
      }
      for (const { ordinal } of list) countMatch(ordinal);
    }
    if (prefix !== undefined) {
      const expanded = new Set();
      for (const [term, postings] of field.postings) {
        if (term.startsWith(prefix)) {
          for (const { ordinal } of postings) expanded.add(ordinal);
        }
      }
      if (!expanded.size && mode === "all") return [];
      for (const ordinal of expanded) countMatch(ordinal);
    }
    const matches = [];
    for (const [ordinal, count] of counts) {
      if (mode === "any" || count === required) matches.push(ordinal);
    }
    return matches.sort((a, b) => a - b).map(ordinal => ids[ordinal]);
  }
  /**
   * Exact query-token occurrences in an original field value. Offsets are
   * UTF-16 code units, end exclusive, suitable for text.slice(start, end).
   */
  function highlightTokens(name, text, query) {
    const field = fields.find(field => field.name === name);
    if (!field) throw new RangeError("Unknown BM25 token field");
    const wanted = new Set(tokens(query, field.tokenize));
    const words = tokens(text, field.tokenize);
    const spans = [];
    if (!wanted.size) return spans;
    // Both analyzers preserve token boundaries: lowercase expansions and
    // removal of Latin combining marks stay within the original token.
    // Pair by ordinal so normalization never shifts source offsets, and
    // contextual case mapping (e.g. final sigma) sees the entire field.
    let i = 0;
    for (const match of text.matchAll(field.pattern)) {
      if (wanted.has(words[i])) spans.push({ start: match.index, end: match.index + match[0].length });
      i++;
    }
    return spans;
  }
  /**
   * Match one analyzed token within one insertion, deletion or substitution.
   * Inspect at most maxDictionaryTerms distinct terms in first-seen order.
   * complete describes this field dictionary only. Each matching posting list
   * is read in full; the term budget does not limit returned IDs or bytes.
   */
  function matchFuzzyToken(name, query, { maxDictionaryTerms = 256 } = {}) {
    const field = fields.find(field => field.name === name);
    if (!field) throw new RangeError("Unknown BM25 token field");
    if (!Number.isSafeInteger(maxDictionaryTerms) || maxDictionaryTerms < 0) {
      throw new RangeError("Expected a nonnegative integer dictionary term budget");
    }
    const terms = tokens(query, field.tokenize);
    if (terms.length > 1) throw new RangeError("Expected one analyzed fuzzy token");
    if (!terms.length) return { ids: [], examinedTerms: 0, complete: true };
    const pattern = Array.from(terms[0]);
    const matches = new Set();
    let examinedTerms = 0;
    for (const [term, postings] of field.postings) {
      if (examinedTerms === maxDictionaryTerms) break;
      examinedTerms++;
      if (withinOneEdit(pattern, term)) {
        for (const { ordinal } of postings) matches.add(ordinal);
      }
    }
    return {
      ids: [...matches].sort((a, b) => a - b).map(ordinal => ids[ordinal]),
      examinedTerms,
      complete: examinedTerms === field.postings.size,
    };
  }
  return { statistics, search, filterPhrase, filterTokenPrefix, matchTokens, matchFuzzyToken, highlightTokens };
}
