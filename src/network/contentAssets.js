import { encodeFixed } from "../tree/alphabet.js";
import { MAX_CONTENT_BYTES } from "../api/wire.js";
import { newBlock } from "./block.js";
import { SharedRead, checkRead } from "../utilities/sharedRead.js";
import { readVerifiedContent } from "./contentStream.js";
export async function contentAssetLocation(path) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)),
  );
  return encodeFixed(digest.subarray(0, 12));
}
const mime = (path) =>
  path.endsWith(".json")
    ? "application/json"
    : /\.jpe?g$/i.test(path)
      ? "image/jpeg"
      : path.endsWith(".png")
        ? "image/png"
        : "application/octet-stream";
const validPath = (path) => {
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.split("/").some((p) => p === ".." || p === ".") ||
    path.includes("?") ||
    path.includes("#")
  )
    throw Error("Invalid content asset path");
};

// One verified binary stream. Storage encoding is projected by the node, with
// HTTP gzip handled incrementally by fetch. Normal reads share transport/cache.
export class ContentAssets {
  constructor(
    network,
    {
      collection,
      cacheBytes = 8 << 20,
      maxAssetBytes = MAX_CONTENT_BYTES,
      compression = "auto",
    } = {},
  ) {
    if (!network?.readContent || !collection)
      throw Error("ContentAssets requires a Network and collection");
    if (!["auto", "identity", "gzip"].includes(compression))
      throw Error("Invalid content compression");
    Object.assign(this, { network, collection, cacheBytes, maxAssetBytes, compression });
    this.cache = new Map();
    this.pending = new Map();
    this.bytes = 0;
  }
  async _fetch(path, signal, onChunk) {
    const location = await contentAssetLocation(path);
    checkRead(signal);
    return this.network.readContent(this.collection, location, {
      path,
      compression: this.compression,
      signal,
      consume: (response) =>
        readVerifiedContent(response, { signal, onChunk, maxAssetBytes: this.maxAssetBytes }),
    });
  }
  async _load(path, signal) {
    validPath(path);
    checkRead(signal);
    const cached = this.cache.get(path);
    if (cached) {
      this.cache.delete(path);
      this.cache.set(path, cached);
      return cached;
    }
    let shared = this.pending.get(path);
    if (shared?.controller.signal.aborted) {
      this.pending.delete(path);
      shared = null;
    }
    if (!shared) {
      shared = new SharedRead(async (transportSignal) => {
        const result = await this._fetch(path, transportSignal);
        if (result.bytes <= this.cacheBytes) {
          this.cache.set(path, result);
          this.bytes += result.bytes;
          while (this.bytes > this.cacheBytes) {
            const oldest = this.cache.keys().next().value;
            this.bytes -= this.cache.get(oldest).bytes;
            this.cache.delete(oldest);
          }
        }
        return result;
      }, 30000);
      this.pending.set(path, shared);
      const done = () => {
        if (this.pending.get(path) === shared) this.pending.delete(path);
      };
      shared.promise.then(done, done);
    }
    return shared.join(signal);
  }
  async read(path, options = {}) {
    return (await this.readVerified(path, options)).value;
  }
  _owned(result, value) {
    return {
      ...result,
      value,
      block: newBlock({ id: result.sha256, sha256: result.sha256, bytes: value }),
    };
  }
  /**
   * Source receipt after SHA-256 verification, plus consumer-owned bytes.
   * Compare sha256/bytes with an independent manifest without hashing again.
   * Mutating value (including in onChunk) invalidates its source receipt.
   */
  async readVerified(path, { signal, onChunk } = {}) {
    if (!onChunk) {
      const result = await this._load(path, signal);
      return this._owned(result, result.value.slice());
    }
    validPath(path);
    checkRead(signal);
    const cached = this.cache.get(path);
    if (cached) {
      this.cache.delete(path);
      this.cache.set(path, cached);
      const bytes = cached.value.slice();
      const receipt = this._owned(cached, bytes);
      await onChunk({
        bytes,
        received: bytes.length,
        total: bytes.length,
        verified: true,
        block: receipt.block,
      });
      checkRead(signal);
      return receipt;
    }
    // A dedicated streamed read avoids exposing shared cached allocations to a
    // preparer or letting one consumer block another consumer's body processing.
    return new SharedRead((transport) => this._fetch(path, transport, onChunk), 30000).join(signal);
  }
  async response(path, options = {}) {
    const bytes = options.onChunk
      ? await this.read(path, options)
      : (await this._load(path, options.signal)).value;
    return new Response(bytes, {
      headers: { "Content-Type": mime(path), "X-Indexus-Collection": this.collection },
    });
  }
  clear() {
    this.cache.clear();
    this.bytes = 0;
  }
}
