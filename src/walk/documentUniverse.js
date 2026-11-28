// Count all 32 bits, including a set sign bit. Each step adds adjacent
// groups of 1, 2, 4, then 8 bits.
function popcount(word) {
  word -= (word >>> 1) & 0x55555555;
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
  word = (word + (word >>> 4)) & 0x0f0f0f0f;
  return Math.imul(word, 0x01010101) >>> 24;
}

// Pins the caller's ordinal map and live rows of one segment snapshot.
// Masks are opaque, in-process tokens accepted only by this instance.
export class DocumentUniverse {
  #ids;
  #masks = new WeakMap();
  #live;

  constructor(segment, revision, ids, deleted = []) {
    if (typeof segment !== "string" || !segment || typeof revision !== "string" || !revision)
      throw new TypeError("expected a segment and revision");
    if (
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length
    )
      throw new TypeError("expected unique document IDs");
    for (const id of ids) {
      if (typeof id !== "string" || !id) throw new TypeError("expected nonempty document IDs");
    }
    this.segment = segment;
    this.revision = revision;
    this.#ids = ids.slice();
    this.#live = new Uint32Array(Math.ceil(ids.length / 32)).fill(0xffffffff);
    if (ids.length % 32)
      this.#live[this.#live.length - 1] = 0xffffffff >>> (32 - (ids.length % 32));
    for (const i of deleted) {
      this.#checkOrdinal(i);
      this.#live[Math.floor(i / 32)] &= ~(1 << i % 32);
    }
    Object.freeze(this);
  }
  #checkOrdinal(i) {
    if (!Number.isSafeInteger(i) || i < 0 || i >= this.#ids.length)
      throw new RangeError("invalid ordinal");
  }
  #mask(words) {
    const token = Object.freeze({});
    this.#masks.set(token, words);
    return token;
  }
  #words(token) {
    const words = this.#masks.get(token);
    if (!words) throw new TypeError("mask outside the segment snapshot universe");
    return words;
  }
  posting(ordinals) {
    const words = new Uint32Array(this.#live.length);
    for (const i of ordinals) {
      this.#checkOrdinal(i);
      const w = Math.floor(i / 32);
      words[w] |= this.#live[w] & (1 << i % 32);
    }
    return this.#mask(words);
  }
  and(a, b) {
    return this.#combine(a, b, (x, y) => x & y);
  }
  or(a, b) {
    return this.#combine(a, b, (x, y) => x | y);
  }
  andNot(a, b) {
    return this.#combine(a, b, (x, y) => x & ~y);
  }
  not(a) {
    const words = this.#words(a);
    return this.#mask(this.#live.map((live, i) => live & ~words[i]));
  }
  #combine(a, b, combine) {
    const left = this.#words(a);
    const right = this.#words(b);
    return this.#mask(left.map((word, i) => combine(word, right[i])));
  }
  count(mask) {
    let n = 0;
    for (const word of this.#words(mask)) n += popcount(word);
    return n;
  }

  intersectionCount(a, b) {
    const left = this.#words(a);
    const right = this.#words(b);
    let n = 0;
    for (let i = 0; i < left.length; i++) n += popcount(left[i] & right[i]);
    return n;
  }

  ids(mask) {
    const out = [];
    for (const [w, word] of this.#words(mask).entries()) {
      let remaining = word;
      while (remaining) {
        const bit = 31 - Math.clz32(remaining & -remaining);
        out.push(this.#ids[32 * w + bit]);
        remaining &= remaining - 1;
      }
    }
    return out;
  }
}
