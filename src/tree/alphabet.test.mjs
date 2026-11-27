/**
 * Unit tests for the location algebra shared with go-indexus-core:
 * domain.IsDirectChild and zoneKeyID.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LOCATION_ALPHABET,
  ROOT,
  decodeFixed,
  isDirectChild,
  parent,
  zoneKeyID,
} from "./alphabet.js";

describe("isDirectChild", () => {
  it("accepts one encoding step below the parent", () => {
    assert.equal(isDirectChild(ROOT, "7"), true);
    assert.equal(isDirectChild("q", "qu"), true);
    assert.equal(isDirectChild("7", "7x"), true);
  });

  it("rejects self-keys, which is what stops a traversal looping", () => {
    assert.equal(isDirectChild(ROOT, ROOT), false);
    assert.equal(isDirectChild("q", "q"), false);
  });

  it("rejects anything deeper than one step", () => {
    assert.equal(isDirectChild(ROOT, "7x"), false);
    assert.equal(isDirectChild("7", "7xy"), false);
  });

  it("rejects the `location:reference` rows an item carries", () => {
    assert.equal(isDirectChild("n", "nLKc:item"), false);
    assert.equal(isDirectChild("nLKc", "nLKc:item"), false);
  });

  // P4: the key space belongs to locations. Reserving a character as a marker
  // hides every zone named after it — on the Go side that lost every item
  // stored under `_`, present in the collection and counted by nobody.
  it("treats every character of the alphabet as an ordinary location", () => {
    for (const character of LOCATION_ALPHABET) {
      assert.equal(
        isDirectChild(ROOT, character),
        true,
        `${character} is a letter of the alphabet, so a child of the root`,
      );
      assert.equal(isDirectChild(character, `${character}A`), true);
    }
  });
});

describe("zoneKeyID", () => {
  function sharedPrefixBits(a, b) {
    let shared = 0;
    for (let i = 0; i < a.length && i < b.length; i++) {
      const diff = a[i] ^ b[i];
      if (diff === 0) {
        shared += 8;
        continue;
      }
      for (let bit = 7; bit >= 0; bit--) {
        if ((diff >> bit) & 1) break;
        shared += 1;
      }
      break;
    }
    return shared;
  }

  it("lets the location lead, so sibling zones stay adjacent under XOR", () => {
    const collection = "DvFMV2020idx0001";
    const here = zoneKeyID(collection, "7x");
    const sibling = zoneKeyID(collection, "7y");
    const elsewhere = zoneKeyID(collection, "Ax");

    assert.ok(sharedPrefixBits(here, sibling) >= 9);
    assert.ok(sharedPrefixBits(here, elsewhere) < sharedPrefixBits(here, sibling));
  });

  it("keys the root zone on the collection alone", () => {
    const collection = "DvFMV2020idx0001";
    assert.deepEqual(
      zoneKeyID(collection, ROOT),
      decodeFixed(collection),
      "the root carries no location prefix",
    );
  });

  it("keeps the collection width whatever the location depth", () => {
    const collection = "DvFMV2020idx0001";
    const width = zoneKeyID(collection, ROOT).length;
    assert.equal(zoneKeyID(collection, "7").length, width);
    assert.equal(zoneKeyID(collection, "7xAb").length, width);
  });
});

describe("parent", () => {
  it("walks one step up, and the root has none", () => {
    assert.equal(parent("abc"), "ab");
    assert.equal(parent("a"), ROOT);
    assert.equal(parent(ROOT), "");
  });
});

it("the alphabet does not require a global Buffer in browsers", async () => {
  const prior = globalThis.Buffer;
  try {
    delete globalThis.Buffer;
    const { zoneKeyID } = await import("./alphabet.js?browser-test");
    assert.equal(zoneKeyID("DvFMV2020idx0001", "7x").length, 12);
  } finally {
    globalThis.Buffer = prior;
  }
});

it("fixed-width Indexus names preserve every partial-byte prefix and zero padding", async () => {
  const { encodeFixed, LOCATION_ALPHABET } = await import("./alphabet.js");
  for (let length = 1; length <= 64; length++) {
    const name = Array.from({ length }, (_, i) => LOCATION_ALPHABET[(i * 17 + length) % 64]).join(
      "",
    );
    assert.equal(encodeFixed(decodeFixed(name), length), name);
  }
  assert.equal(encodeFixed(new Uint8Array(), 16), "0".repeat(16));
});

describe("width", () => {
  it("keys every zone on 12 bytes and refuses other widths", async () => {
    const { checkName, checkLocation, WIDTH, KEY_BYTES } = await import("./alphabet.js");
    assert.equal(WIDTH, 16);
    assert.equal(KEY_BYTES, 12);
    for (const location of [ROOT, "5", "5xS4R2qq77xabVnr"]) {
      assert.equal(zoneKeyID("DvFMV2020idx0001", location).length, KEY_BYTES);
    }
    assert.throws(() => checkName("demo"));
    assert.throws(() => checkName("RecoveringPeerAAA"));
    assert.throws(() => checkLocation("5xS4R2qq77xabVnrA"));
    assert.throws(() => checkLocation("5x!"));
    assert.throws(() => zoneKeyID("demo", "5x"));
  });
});
