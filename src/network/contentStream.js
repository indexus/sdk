import { CONTENT_HEADERS } from "../api/wire.js";
import { newBlock } from "./block.js";
import { checkRead } from "../utilities/sharedRead.js";

const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

// HTTP decoding is incremental in fetch. Preparers may read complete prefixes,
// but only the resolved return value has passed the final integrity check.
export async function readVerifiedContent(response, { signal, onChunk, maxAssetBytes }) {
  const length = Number(response.headers.get(CONTENT_HEADERS.decodedBytes));
  const sha = response.headers.get(CONTENT_HEADERS.sha256);
  if (
    !response.headers.has(CONTENT_HEADERS.decodedBytes) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maxAssetBytes ||
    !/^[a-f0-9]{64}$/i.test(sha ?? "") ||
    !response.body
  ) {
    throw Error("Invalid Indexus asset metadata");
  }

  const value = new Uint8Array(length);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      checkRead(signal);
      const { value: chunk, done } = await reader.read();
      if (done) break;
      if (offset + chunk.byteLength > length) throw Error("Indexus asset length mismatch");
      value.set(chunk, offset);
      offset += chunk.byteLength;
      if (onChunk)
        await onChunk({ bytes: value, received: offset, total: length, verified: false });
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }

  checkRead(signal);
  if (offset !== length) throw Error("Indexus asset checksum mismatch");
  const sha256 = hex(await crypto.subtle.digest("SHA-256", value));
  if (sha256 !== sha.toLowerCase()) {
    throw Error("Indexus asset checksum mismatch");
  }
  checkRead(signal);
  return {
    value,
    sha256,
    bytes: length,
    wireBytes: Number(response.headers.get("Content-Length")) || undefined,
    block: newBlock({ id: sha256, sha256, bytes: value }),
  };
}
