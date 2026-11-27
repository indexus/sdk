// Hand-built IXB2 rows blocks for the cells tests and the browser check.
// Not part of the package (`files` ships src/**/*.js only).
import { ROUTING_ALPHABET, BITS_PER_CHAR } from "../tree/index.js";

/** Deterministic PRNG (mulberry32): same seed, same blocks, in Node and in the page. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function keyWords(suffixChars) {
  return Math.ceil((BITS_PER_CHAR * suffixChars) / 32);
}

/** Writes one suffix as wire key words, MSB-first (wire-block.md, "Keys"). */
export function writeKey(suffix, words, at) {
  for (let c = 0; c < suffix.length; c++) {
    const digit = ROUTING_ALPHABET.indexOf(suffix[c]);
    if (digit < 0) {
      throw new Error(`not a routing character: ${suffix[c]}`);
    }
    for (let bit = 0; bit < BITS_PER_CHAR; bit++) {
      if ((digit >> (BITS_PER_CHAR - 1 - bit)) & 1) {
        const position = c * BITS_PER_CHAR + bit;
        words[at + (position >>> 5)] |= 0x80000000 >>> (position & 31);
      }
    }
  }
}

/** A RowsBlock (docs/layers.md §2) for the given suffixes, all of one length. */
export function rowsBlock(parent, suffixes, { metricCount = 0, random = Math.random } = {}) {
  const n = suffixes.length;
  const suffixChars = suffixes[0].length;
  const words = keyWords(suffixChars);
  const keys = new Uint32Array(n * words);
  const count = new Uint32Array(n);
  const metrics = new Float32Array(metricCount * n);
  suffixes.forEach((suffix, row) => {
    writeKey(suffix, keys, row * words);
    count[row] = 1 + Math.floor(random() * 1000);
  });
  for (let i = 0; i < metrics.length; i++) {
    metrics[i] = random() * 1e6;
  }
  return {
    parent,
    suffixChars,
    keyWords: words,
    metricCount,
    revision: 0,
    n,
    keys,
    count,
    metrics,
  };
}

export function randomSuffix(random, length) {
  let suffix = "";
  for (let c = 0; c < length; c++) {
    suffix += ROUTING_ALPHABET[Math.floor(random() * 64)];
  }
  return suffix;
}

/** n random rows below `parent`, without building a string per row. */
export function randomBlock(random, parent, n, suffixChars, metricCount) {
  const words = keyWords(suffixChars);
  const keys = new Uint32Array(n * words);
  const count = new Uint32Array(n);
  const metrics = new Float32Array(metricCount * n);
  const unused = words * 32 - suffixChars * BITS_PER_CHAR;
  for (let row = 0; row < n; row++) {
    for (let w = 0; w < words; w++) {
      keys[row * words + w] = (random() * 4294967296) >>> 0;
    }
    // Unused low bits of the last word are zero on the wire.
    keys[row * words + words - 1] &= (0xffffffff << unused) >>> 0;
    count[row] = 1 + Math.floor(random() * 1000);
  }
  for (let i = 0; i < metrics.length; i++) {
    metrics[i] = random() * 1e6;
  }
  return {
    parent,
    suffixChars,
    keyWords: words,
    metricCount,
    revision: 0,
    n,
    keys,
    count,
    metrics,
  };
}

/**
 * Up to n random rows below `parent`, sorted by key and unique, as the
 * encoder sends them (wire-block.md, "Rows"). `prefixChars` > 0 draws the
 * first characters from a few values, so rows share prefixes.
 */
export function sortedRandomBlock(
  random,
  parent,
  n,
  suffixChars,
  metricCount,
  { prefixChars = 0, prefixes = 4 } = {},
) {
  const words = keyWords(suffixChars);
  const raw = new Uint32Array(n * words);
  const unused = words * 32 - suffixChars * BITS_PER_CHAR;
  const choices = Array.from({ length: prefixes }, () =>
    Math.floor(random() * 2 ** (BITS_PER_CHAR * prefixChars)),
  );
  for (let row = 0; row < n; row++) {
    for (let w = 0; w < words; w++) {
      raw[row * words + w] = (random() * 4294967296) >>> 0;
    }
    raw[row * words + words - 1] &= (0xffffffff << unused) >>> 0;
    if (prefixChars > 0) {
      const bits = BITS_PER_CHAR * prefixChars;
      const prefix = choices[Math.floor(random() * prefixes)];
      raw[row * words] =
        ((raw[row * words] & (0xffffffff >>> bits)) | (prefix << (32 - bits))) >>> 0;
    }
  }
  const order = Array.from({ length: n }, (_, i) => i);
  if (words === 1) {
    raw.sort();
  } else {
    order.sort((a, b) => {
      for (let w = 0; w < words; w++) {
        const d = raw[a * words + w] - raw[b * words + w];
        if (d !== 0) {
          return d;
        }
      }
      return 0;
    });
  }
  const unique = [];
  for (const row of order) {
    const last = unique.at(-1);
    let same = last !== undefined;
    for (let w = 0; same && w < words; w++) {
      same = raw[last * words + w] === raw[row * words + w];
    }
    if (!same) {
      unique.push(row);
    }
  }
  const rows = unique.length;
  const keys = new Uint32Array(rows * words);
  unique.forEach((row, i) => keys.set(raw.subarray(row * words, row * words + words), i * words));
  const count = new Uint32Array(rows);
  for (let row = 0; row < rows; row++) {
    count[row] = 1 + Math.floor(random() * 1000);
  }
  const metrics = new Float32Array(metricCount * rows);
  for (let i = 0; i < metrics.length; i++) {
    metrics[i] = random() * 1e6;
  }
  return {
    parent,
    suffixChars,
    keyWords: words,
    metricCount,
    revision: 0,
    n: rows,
    keys,
    count,
    metrics,
  };
}
