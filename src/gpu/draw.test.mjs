import { test } from "node:test";
import assert from "node:assert/strict";
import { writeMaskUniform, writeAccumUniform, writeNormalizeUniform } from "./draw.js";

function device() {
  const writes = [],
    contents = new Map();
  return {
    writes,
    contents,
    queue: {
      writeBuffer(buffer, offset, data) {
        assert.equal(offset, 0);
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        contents.set(buffer, bytes);
        writes.push({ buffer, bytes });
      },
    },
  };
}
const bytes = (values) => new Uint8Array(new Float32Array(values).buffer);

test("zoom, parent/child depths and fades retain exact uniform bytes on every frame", () => {
  const gpu = device(),
    mask = {},
    accum = {},
    normalize = {};
  const matrix = new Float32Array(16);
  for (let frame = 0; frame < 600; frame++) {
    // Alternate pans, zoom in/out, LOD changes, stable frames and fades.
    matrix[0] = matrix[5] = 1 + Math.floor(frame / 10) / 100;
    matrix[12] = Math.sin(Math.floor(frame / 5));
    const zoom = 8 + Math.sin(frame / 40) * 3,
      depth = Math.floor(zoom + 5);
    const t = (frame % 25) / 24,
      opacity = frame < 300 ? 1 : 0.7;
    const area = frame >= 400,
      normalizer = frame < 500 ? 10000 : 12000;
    writeMaskUniform(gpu, mask, matrix);
    const coverage = frame >= 450 && frame < 550;
    writeAccumUniform(gpu, accum, matrix, 0.8, 2.5, t, zoom, 5, depth - 1, area, depth, coverage);
    writeNormalizeUniform(gpu, normalize, normalizer, 0.2, opacity, true, t);
    assert.deepEqual(gpu.contents.get(mask), bytes([...matrix]));
    assert.deepEqual(
      gpu.contents.get(accum),
      bytes([
        ...matrix,
        0.8,
        2.5,
        t,
        zoom,
        5,
        depth - 1,
        area ? 1 : 0,
        depth,
        coverage ? 1 : 0,
        0,
        0,
        0,
      ]),
    );
    assert.deepEqual(gpu.contents.get(normalize), bytes([normalizer, 0.2, opacity, 1, t, 0, 0, 0]));
  }
  assert.ok(gpu.writes.length < 1800, "only byte-identical uploads are omitted");
});

test("repeated uniforms skip transfers but in-place camera updates and signed zero are uploaded", () => {
  const gpu = device(),
    target = {},
    matrix = new Float32Array(16);
  for (let i = 0; i < 100; i++) writeMaskUniform(gpu, target, matrix);
  assert.equal(gpu.writes.length, 1);
  matrix[12] = 0.5;
  writeMaskUniform(gpu, target, matrix);
  matrix[12] = -0;
  writeMaskUniform(gpu, target, matrix);
  matrix[12] = 0;
  writeMaskUniform(gpu, target, matrix);
  assert.equal(gpu.writes.length, 4);
  assert.deepEqual(gpu.contents.get(target), bytes(matrix));
});

test("uniform state is isolated across buffers, devices and recreated resources", () => {
  const first = device(),
    second = device(),
    a = {},
    b = {},
    c = {};
  writeNormalizeUniform(first, a, 10000, 0.2, 1, true);
  writeNormalizeUniform(first, b, 10000, 0.2, 1, true);
  writeNormalizeUniform(second, c, 10000, 0.2, 1, true);
  writeNormalizeUniform(first, a, 10000, 0.2, 0.5, true);
  writeNormalizeUniform(first, b, 10000, 0.2, 1, true);
  assert.equal(first.writes.length, 3);
  assert.equal(second.writes.length, 1);
  assert.deepEqual(first.contents.get(b), second.contents.get(c));
  const recreated = {};
  writeNormalizeUniform(first, recreated, 10000, 0.2, 1, true);
  assert.equal(first.writes.length, 4, "fresh resources always receive an initial upload");
});

test("a failed upload is retried and Float32-equivalent inputs do not waste transfers", () => {
  const gpu = device(),
    target = {},
    original = gpu.queue.writeBuffer;
  gpu.queue.writeBuffer = () => {
    throw Error("upload failed");
  };
  assert.throws(() => writeNormalizeUniform(gpu, target, 10000, 0.2, 1, true), /upload failed/);
  gpu.queue.writeBuffer = original;
  writeNormalizeUniform(gpu, target, 10000, 0.2, 1, true);
  writeNormalizeUniform(gpu, target, 10000 + 1e-8, 0.2, 1, true);
  assert.equal(gpu.writes.length, 1);
  assert.deepEqual(gpu.contents.get(target), bytes([10000, 0.2, 1, 1, 1, 0, 0, 0]));
});

test("scalar time interpolation is opt-in and resets when returning to DVF rendering", () => {
  const gpu = device(),
    target = {};
  writeNormalizeUniform(gpu, target, 90, 0, 0.8, true, 0.4, true);
  assert.deepEqual(gpu.contents.get(target), bytes([90, 0, 0.8, 1, 0.4, 1, 0, 0]));
  writeNormalizeUniform(gpu, target, 10000, 0, 1, true, 0.4);
  assert.deepEqual(gpu.contents.get(target), bytes([10000, 0, 1, 1, 0.4, 0, 0, 0]));
});
