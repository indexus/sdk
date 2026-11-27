import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { requestPeer } from "./transport.js";
import { transientReadFailure } from "../network/helpers.js";
import { deleteItem } from "./deleteItem.js";

test("RPC transport retains authorization and custom headers while enforcing deadlines", async () => {
  let headers;
  const server = http.createServer((req, res) => {
    headers = req.headers;
    if (req.url === "/wait") return;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const prior = globalThis.__INDEXUS_BEARER__;
  globalThis.__INDEXUS_BEARER__ = "wire-test";
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await requestPeer(url, {}, { headers: { "X-Test": "kept" } });
    assert.equal(headers.authorization, "Bearer wire-test");
    assert.equal(headers["x-test"], "kept");
    await assert.rejects(requestPeer(url + "/wait", { timeoutMs: 50 }), { code: "ECONNABORTED" });
  } finally {
    globalThis.__INDEXUS_BEARER__ = prior;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cancelling write backpressure releases the timer and never sends the retry", async () => {
  let calls = 0,
    first;
  const response = new Promise((resolve) => (first = resolve));
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(503, { "Retry-After": "60" });
    res.end("{}");
    first();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController(),
    peer = { ip: () => "127.0.0.1", port: () => server.address().port };
  try {
    const pending = deleteItem("http", peer, "collection", "@", "a", "id", {
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, { code: "ERR_CANCELED" });
    await response;
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await rejected;
    assert.equal(calls, 1);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A server answering every request with `handle(req, res)`, closed after `run(url)`. */
async function withServer(handle, run) {
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a timeout rejects with ECONNABORTED, a transient read failure", async () => {
  await withServer(
    () => {},
    async (url) => {
      const error = await requestPeer(url, { timeoutMs: 30 }).catch((e) => e);
      assert.equal(error.code, "ECONNABORTED");
      assert.equal(error.response, undefined);
      assert.equal(transientReadFailure(error), true);
    },
  );
});

test("a 5xx rejects with its status, headers and body; 503 is transient, 404 is not", async () => {
  await withServer(
    (req, res) => {
      const status = req.url === "/missing" ? 404 : 503;
      res.writeHead(status, { "Retry-After": "7", "Content-Type": "application/json" });
      res.end('{"error":"busy"}');
    },
    async (url) => {
      const busy = await requestPeer(url).catch((e) => e);
      assert.equal(busy.response.status, 503);
      assert.equal(busy.response.headers["retry-after"], "7");
      assert.deepEqual(busy.response.data, { error: "busy" });
      assert.equal(transientReadFailure(busy), true);
      const missing = await requestPeer(url + "/missing").catch((e) => e);
      assert.equal(missing.response.status, 404);
      assert.equal(transientReadFailure(missing), false);
    },
  );
});

test("a refused connection rejects without a response and is not transient", async () => {
  let port;
  await withServer(
    () => {},
    async (url) => {
      port = new URL(url).port;
    },
  );
  const error = await requestPeer(`http://127.0.0.1:${port}`).catch((e) => e);
  assert.equal(error.code, "ERR_NETWORK");
  assert.equal(error.response?.status ?? null, null);
  assert.equal(transientReadFailure(error), false);
});

test("JSON, query parameters and binary bodies", async () => {
  await withServer(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url.startsWith("/bin")) {
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          return res.end(Buffer.from([1, 2, 3]));
        }
        res.writeHead(200, { "Content-Type": "application/json", "X-Echo": "yes" });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            body,
            type: req.headers["content-type"],
          }),
        );
      });
    },
    async (url) => {
      const post = await requestPeer(
        url + "/p",
        {},
        { method: "post", data: { a: 1 }, params: { origin: "x y" } },
      );
      assert.equal(post.status, 200);
      assert.equal(post.headers["x-echo"], "yes");
      assert.deepEqual(post.data, {
        method: "POST",
        url: "/p?origin=x+y",
        body: '{"a":1}',
        type: "application/json",
      });
      const bin = await requestPeer(url + "/bin", {}, { responseType: "arraybuffer" });
      assert.ok(bin.data instanceof ArrayBuffer);
      assert.deepEqual([...new Uint8Array(bin.data)], [1, 2, 3]);
    },
  );
});
