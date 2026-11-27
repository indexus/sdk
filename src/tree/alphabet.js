const ROOT = "@";
// The one alphabet of Indexus addresses: go-indexus-core protocol.Base. Node
// ids, zone keys, wire keys and Space cells all use it, so the 6-bit value a
// location character stands for is the same for routing and for geometry.
const LOCATION_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
export const BITS_PER_CHAR = 6;
// One width for every 96-bit name (go tree.Width): a vnode name and a
// collection are 16 characters, a location 1 to 16, a zone key 12 bytes.
export const WIDTH = 16;
export const KEY_BYTES = (WIDTH * BITS_PER_CHAR) / 8;

function checkChars(s) {
  for (const char of s) {
    if (LOCATION_ALPHABET.indexOf(char) < 0) throw new Error(`${JSON.stringify(s)}: '${char}' is not in the alphabet`);
  }
}

/** A vnode or collection name: exactly WIDTH characters of the alphabet. */
export function checkName(name) {
  if (typeof name !== "string" || name.length !== WIDTH) {
    throw new Error(`name ${JSON.stringify(name)}: ${name?.length} characters, want ${WIDTH}`);
  }
  checkChars(name);
}

/** A location: the root, or 1 to WIDTH characters of the alphabet. */
export function checkLocation(location) {
  if (location === ROOT) return;
  if (typeof location !== "string" || location.length === 0 || location.length > WIDTH) {
    throw new Error(`location ${JSON.stringify(location)}: want 1 to ${WIDTH} characters`);
  }
  checkChars(location);
}

// Per-level Space offset of a collection: the alphabet index of each character
// of its name.
function charsToNumbers(str) {
  const details = new Array(str.length);

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    details[i] = LOCATION_ALPHABET.indexOf(char);
  }

  return details;
}

// Go Base.Encode: encode a fixed number of Indexus characters, padding bits with zero.
function encodeFixed(input, length = Math.ceil((input.length * 8) / BITS_PER_CHAR)) {
  if (!(input instanceof Uint8Array) || !Number.isSafeInteger(length) || length < 0) {
    throw new Error("Invalid Indexus encoding input or length");
  }
  let value = 0,
    bits = 0,
    offset = 0,
    out = "";
  for (let i = 0; i < length; i++) {
    if (bits < BITS_PER_CHAR) {
      value = (value << 8) | (input[offset++] ?? 0);
      bits += 8;
    }
    bits -= BITS_PER_CHAR;
    out += LOCATION_ALPHABET[(value >>> bits) & 63];
  }
  return out;
}

function decodeFixed(encoded) {
  if (encoded === ROOT) {
    return new Uint8Array(0);
  }
  let value = 0;
  let bitsInValue = 0;
  const out = new Uint8Array(Math.ceil((encoded.length * BITS_PER_CHAR) / 8));
  let offset = 0;
  for (const char of encoded) {
    const idx = LOCATION_ALPHABET.indexOf(char);
    if (idx < 0) {
      throw new Error(`invalid character '${char}' in input`);
    }
    value = (value << BITS_PER_CHAR) | idx;
    bitsInValue += BITS_PER_CHAR;
    while (bitsInValue >= 8) {
      bitsInValue -= 8;
      out[offset++] = (value >> bitsInValue) & 0xff;
    }
  }
  if (bitsInValue > 0) {
    out[offset] = (value << (8 - bitsInValue)) & 0xff;
  }
  return out;
}

function combineBytes(byte1, byte2, left) {
  const mask = 0xff << (8 - left);
  const firstPart = (byte1 & mask) >> (8 - left);
  const secondPart = byte2 >> left;
  return (firstPart << (8 - left)) | secondPart;
}

function mergeZoneKey(location, locBytes, collBytes) {
  const length = location.length * BITS_PER_CHAR;
  const byteIndex = Math.floor(length / 8);
  const left = length % 8;

  if (left === 0) {
    const out = Uint8Array.from(collBytes);
    out.set(locBytes.subarray(0, byteIndex));
    return out;
  }
  const out = Uint8Array.from(collBytes);
  out[byteIndex] = combineBytes(locBytes[byteIndex], collBytes[byteIndex], left);
  if (byteIndex > 0) {
    out.set(locBytes.subarray(0, byteIndex));
  }
  return out;
}

function parent(location) {
  if (location === ROOT) {
    return "";
  }
  const l = location.length - 1;
  if (l === 0) {
    return ROOT;
  } else {
    return location.substring(0, l);
  }
}

// domain.IsDirectChild: one encoding step below `location`. Rejects self-keys
// and anything deeper, which is what keeps a traversal from looping. Every
// character of the alphabet is an ordinary location — `-` and `_` included —
// so nothing here may treat one of them as a marker (guarantee P4).
function isDirectChild(location, child) {
  if (!child || child === location) {
    return false;
  }
  return parent(child) === location;
}

// domain.Key: a zone is a (collection, location) pair. Used wherever a zone
// indexes a local map — the Network read cache, the Grid children cache.
function zoneKey(collection, location) {
  return `${collection}/${location}`;
}

// zoneKeyID: maps (collection, location) into the routing space. Location bits
// occupy the high positions; collection fills the rest (same as Go ZoneKeyID).
function zoneKeyID(collection, location) {
  checkName(collection);
  if (!location || location === ROOT) {
    return decodeFixed(collection);
  }
  checkLocation(location);
  const locBytes = decodeFixed(location);
  const collBytes = decodeFixed(collection);
  return mergeZoneKey(location, locBytes, collBytes);
}

export {
  ROOT,
  LOCATION_ALPHABET,
  encodeFixed,
  decodeFixed,
  charsToNumbers,
  parent,
  isDirectChild,
  zoneKey,
  zoneKeyID,
};
