// Checked bytes. The hash is already verified. This file does not touch the GPU.

const hash = /^[a-f0-9]{64}$/;

export function newBlock({ id, sha256, bytes }) {
  if (typeof id !== "string" || !id) throw Error("block id required");
  if (!hash.test(sha256 ?? "")) throw Error("block hash required");
  if (!(bytes instanceof Uint8Array)) throw Error("block bytes required");
  return { id, sha256, bytes, byteLength: bytes.byteLength, dropped: false };
}

export function drop(block) {
  if (!block || block.dropped) return block;
  block.bytes = null;
  block.dropped = true;
  return block;
}
