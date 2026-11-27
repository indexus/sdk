import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ContentAssets, contentAssetLocation } from "./contentAssets.js";
function fixture(path = "data/test.json", value = Buffer.from('{"ok":true}')) {
  return {
    path,
    value,
    bytes: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}
const response = (p) =>
  new Response(p.value, {
    headers: { "X-Indexus-Decoded-Bytes": String(p.bytes), "X-Indexus-Sha256": p.sha256 },
  });
const network = (p) => ({
  async readContent(c, l, { consume }) {
    return consume(response(p));
  },
});
test("asset address matches the canonical 96-bit content location", async () => {
  const path = "data/test.json",
    hash = createHash("sha256").update(path).digest().subarray(0, 12),
    standard = hash.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    b = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
  assert.equal(
    await contentAssetLocation(path),
    [...standard].map((c) => b[a.indexOf(c)]).join(""),
  );
});
test("one SDK read serves simultaneous consumers and verified cache", async () => {
  let calls = 0;
  const p = fixture();
  const store = new ContentAssets(
    {
      async readContent(c, l, { signal, path, consume }) {
        calls++;
        assert.equal(c, "Assets");
        assert.equal(l, await contentAssetLocation(p.path));
        assert.equal(path, p.path);
        assert.ok(signal);
        await new Promise((r) => setTimeout(r, 5));
        return consume(response(p));
      },
    },
    { collection: "Assets" },
  );
  const [a, b] = await Promise.all([store.response(p.path), store.response(p.path)]);
  assert.deepEqual(await a.json(), { ok: true });
  assert.deepEqual(await b.json(), { ok: true });
  const bytes = await store.read(p.path);
  bytes[0] = 0;
  assert.deepEqual(await (await store.response(p.path)).json(), { ok: true });
  assert.equal(calls, 1);
});
test("corrupt or inconsistent content never enters cache", async () => {
  const p = fixture();
  p.sha256 = "0".repeat(64);
  const reader = new ContentAssets(network(p), { collection: "Assets" });
  await assert.rejects(reader.read(p.path), /checksum/);
  assert.equal(reader.bytes, 0);
  assert.equal(reader.pending.size, 0);
  p.bytes++;
  await assert.rejects(reader.read(p.path), /checksum/);
});
test("byte budget and path checks fail without static fallback", async () => {
  let calls = 0;
  const p = fixture();
  const reader = new ContentAssets(
    {
      async readContent(c, l, { consume }) {
        calls++;
        return consume(response(p));
      },
    },
    { collection: "Assets", maxAssetBytes: 1 },
  );
  await assert.rejects(reader.read("../private"), /path/);
  assert.equal(calls, 0);
  await assert.rejects(reader.read(p.path), /metadata/);
});
test("one consumer abort does not cancel a surviving consumer", async () => {
  const p = fixture();
  let transport;
  const store = new ContentAssets(
    {
      async readContent(c, l, { signal, consume }) {
        transport = signal;
        await new Promise((r) => setTimeout(r, 20));
        return consume(response(p));
      },
    },
    { collection: "Assets" },
  );
  const abort = new AbortController();
  const cancelled = store.read(p.path, { signal: abort.signal });
  const kept = store.read(p.path);
  abort.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await kept)), { ok: true });
  assert.equal(transport.aborted, false);
});
test("LRU content retention stays within budget", async () => {
  let calls = 0;
  const store = new ContentAssets(
    {
      async readContent(c, l, { path, consume }) {
        calls++;
        return consume(response(fixture(path)));
      },
    },
    { collection: "Assets", cacheBytes: 12 },
  );
  await store.read("a.json");
  await store.read("b.json");
  assert.ok(store.bytes <= 12);
  await store.read("a.json");
  assert.equal(calls, 3);
});
test("last consumer cancellation aborts transport and a new read can retry", async () => {
  const p = fixture();
  let calls = 0,
    signalSeen;
  const store = new ContentAssets(
    {
      async readContent(c, l, { signal, consume }) {
        calls++;
        signalSeen = signal;
        if (calls === 1)
          await new Promise((resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
              { once: true },
            ),
          );
        return consume(response(p));
      },
    },
    { collection: "Assets" },
  );
  const control = new AbortController();
  const first = store.read(p.path, { signal: control.signal });
  while (!signalSeen) await new Promise((r) => setTimeout(r, 1));
  control.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(signalSeen.aborted, true);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await store.read(p.path))), { ok: true });
  assert.equal(calls, 2);
});
test("preparation receives provisional prefixes before the full stream is ready, with no shared mutable cache", async () => {
  const p = fixture("stream.bin", Buffer.from("abcdef"));
  let finish, seen;
  const first = new Promise((r) => {
    seen = r;
  });
  const store = new ContentAssets(
    {
      async readContent(c, l, { consume }) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(p.value.subarray(0, 3));
            finish = () => {
              controller.enqueue(p.value.subarray(3));
              controller.close();
            };
          },
        });
        return consume(
          new Response(stream, {
            headers: { "X-Indexus-Decoded-Bytes": String(p.bytes), "X-Indexus-Sha256": p.sha256 },
          }),
        );
      },
    },
    { collection: "Assets" },
  );
  let done = false;
  const pending = store
    .read(p.path, {
      onChunk: (e) => {
        assert.equal(e.verified, false);
        if (e.received === 3) seen(e.bytes.slice(0, 3));
      },
    })
    .then((v) => {
      done = true;
      return v;
    });
  assert.deepEqual(await first, new Uint8Array([97, 98, 99]));
  assert.equal(done, false);
  finish();
  assert.deepEqual(await pending, new Uint8Array(p.value));
  assert.equal(store.bytes, 0);
});
test("a corrupt stream may prepare provisional bytes but never commits or caches them", async () => {
  const p = fixture();
  p.sha256 = "0".repeat(64);
  let chunks = 0;
  const store = new ContentAssets(network(p), { collection: "Assets" });
  await assert.rejects(
    store.read(p.path, {
      onChunk() {
        chunks++;
      },
    }),
    /checksum/,
  );
  assert.ok(chunks > 0);
  assert.equal(store.bytes, 0);
});
test("stream preparation on a cache hit owns a copy and performs no new transport", async () => {
  const p = fixture();
  let calls = 0;
  const store = new ContentAssets(
    {
      async readContent(c, l, { consume }) {
        calls++;
        return consume(response(p));
      },
    },
    { collection: "Assets" },
  );
  await store.read(p.path);
  await store.read(p.path, {
    onChunk: (e) => {
      assert.equal(e.verified, true);
      e.bytes[0] = 0;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(await store.read(p.path), new Uint8Array(p.value));
});
test("hex checksums accept the same uppercase spelling as the Go content validator", async () => {
  const p = fixture();
  p.sha256 = p.sha256.toUpperCase();
  assert.deepEqual(
    await new ContentAssets(network(p), { collection: "Assets" }).read(p.path),
    new Uint8Array(p.value),
  );
});

test("verified receipts expose the computed digest and preserve consumer ownership on shared/cache reads", async () => {
  const p = fixture("receipt.bin", Buffer.from("verified source"));
  p.sha256 = p.sha256.toUpperCase();
  let calls = 0;
  const store = new ContentAssets(
    {
      async readContent(c, l, { consume }) {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return consume(response(p));
      },
    },
    { collection: "Assets" },
  );
  const [a, b] = await Promise.all([store.readVerified(p.path), store.readVerified(p.path)]);
  assert.equal(a.sha256, p.sha256.toLowerCase());
  assert.equal(a.bytes, p.bytes);
  assert.deepEqual(a.value, new Uint8Array(p.value));
  assert.notEqual(a.value.buffer, b.value.buffer);
  a.value[0] = 0;
  a.sha256 = "0".repeat(64);
  const cached = await store.readVerified(p.path);
  assert.deepEqual(cached.value, new Uint8Array(p.value));
  assert.equal(cached.sha256, p.sha256.toLowerCase());
  assert.equal(calls, 1);
});

test("verified receipt is never returned when a plausible header digest differs from actual bytes", async () => {
  const p = fixture();
  p.sha256 = createHash("sha256").update("different valid data").digest("hex");
  const store = new ContentAssets(network(p), { collection: "Assets" });
  await assert.rejects(store.readVerified(p.path), /checksum/);
  assert.equal(store.cache.size, 0);
});

test("a verified stream owns its original allocation and cache hits expose independent receipts", async () => {
  const p = fixture("receipt-stream.bin", Buffer.from("abcdef"));
  const store = new ContentAssets(network(p), { collection: "Assets" });
  let streamBuffer;
  const streamed = await store.readVerified(p.path, {
    onChunk: (e) => {
      streamBuffer = e.bytes.buffer;
      assert.equal(e.verified, false);
    },
  });
  assert.equal(streamed.value.buffer, streamBuffer);
  assert.equal(streamed.sha256, p.sha256);
  assert.equal(store.bytes, 0);
  await store.read(p.path);
  let cachedBuffer;
  const cached = await store.readVerified(p.path, {
    onChunk: (e) => {
      cachedBuffer = e.bytes.buffer;
      assert.equal(e.verified, true);
    },
  });
  assert.equal(cached.value.buffer, cachedBuffer);
  assert.notEqual(cached.value.buffer, store.cache.get(p.path).value.buffer);
  assert.equal(cached.sha256, p.sha256);
});
