import { compareIds } from "./compareIds.js";
import { TopK } from "./topK.js";

function checkTokens(tokens, width) {
  if (!Array.isArray(tokens) || !tokens.length) throw new TypeError("Expected a nonempty token list");
  for (const token of tokens) {
    if (!Array.isArray(token) && !(ArrayBuffer.isView(token) && Number.isSafeInteger(token.length)))
      throw new TypeError("Expected a token vector");
    width ??= token.length;
    if (!width || token.length !== width) throw new RangeError("Invalid token vector width");
    for (const x of token) if (!Number.isFinite(x)) throw new TypeError("Expected finite token coordinates");
  }
  return width;
}

function scoreTokens(query, document) {
  let score = 0;
  for (const token of query) {
    let best = -Infinity;
    for (const other of document) {
      let dot = 0;
      for (let i = 0; i < token.length; i++) dot += token[i] * other[i];
      if (!Number.isFinite(dot)) throw new RangeError("Token dot product overflow");
      best = Math.max(best, dot);
    }
    score += best;
    if (!Number.isFinite(score)) throw new RangeError("MaxSim score overflow");
  }
  return score;
}

// For each query token take its largest document-token inner product, then
// sum. Inputs carry the caller's token vectors and any desired normalization.
export function exactMaxSim(candidates, queryTokens, { limit = 10 } = {}) {
  const width = checkTokens(queryTokens);
  const top = new TopK(limit, (a,b) =>
    b.score - a.score || compareIds(a.id,b.id) || compareIds(a.location ?? "",b.location ?? ""));
  for (const {id, location, vectors} of candidates) {
    if (typeof id !== "string" || !id) throw new TypeError("Expected a nonempty document ID");
    if (location !== undefined && (typeof location !== "string" || !location))
      throw new TypeError("Invalid document location");
    checkTokens(vectors, width);
    const hit = {id, score:scoreTokens(queryTokens, vectors)};
    if (location !== undefined) hit.location = location;
    top.add(hit);
  }
  return top.finish();
}
