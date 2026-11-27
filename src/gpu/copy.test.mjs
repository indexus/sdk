import { test } from "node:test";
import assert from "node:assert/strict";
import { copyTexture } from "./copy.js";

test("copy sends a texture once", () => {
  const calls = [];
  const gl = {
    TEXTURE_2D: 2,
    RGBA: 4,
    UNSIGNED_BYTE: 5,
    bindTexture(t, b) {
      calls.push(["bindTexture", b]);
    },
    texSubImage2D(...args) {
      calls.push(["texSubImage2D", args[3], args[4]]);
    },
    texImage2D(...args) {
      calls.push(["texImage2D", args.length]);
    },
  };
  copyTexture(gl, { id: "tex" }, new Uint8Array(16), {
    replace: true,
    width: 2,
    height: 2,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  });
  assert.equal(calls.filter((call) => call[0] === "texSubImage2D").length, 1);
  assert.throws(() => copyTexture(null, {}, new Uint8Array()), /copy target/);
});
