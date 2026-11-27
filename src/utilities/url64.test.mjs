import assert from "node:assert/strict";
import { it } from "node:test";

import { encodeUrl64, decodeUrl64 } from "./url64.js";

it("url64 does not require a global Buffer in browsers", async () => {
  const prior = globalThis.Buffer;
  try {
    delete globalThis.Buffer;
    const { encodeUrl64, decodeUrl64 } = await import("./url64.js?browser-test");
    assert.equal(encodeUrl64(new Uint8Array([1, 2, 3])), "AQID");
    assert.deepEqual([...decodeUrl64("AQID")], [1, 2, 3]);
  } finally {
    globalThis.Buffer = prior;
  }
});

it("url64 matches Node's base64url on every length and byte", () => {
  for (let n = 0; n < 70; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 255);
    const expected = Buffer.from(bytes).toString("base64url");
    assert.equal(encodeUrl64(bytes), expected);
    assert.deepEqual([...decodeUrl64(expected)], [...bytes]);
  }
  assert.equal(encodeUrl64("héllo"), Buffer.from("héllo").toString("base64url"));
});
