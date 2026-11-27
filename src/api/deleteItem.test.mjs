import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { deleteItem } from "./deleteItem.js";

test("delete posts the item identity to the engine delete endpoint", async () => {
  let received;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { method: req.method, path: req.url, body: JSON.parse(body) };
    res.writeHead(201);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const peer = { ip: () => "127.0.0.1", port: () => server.address().port };
    await deleteItem("http", peer, "DrawRGB000000001", "@", "abcdefgh", "px_0_0");
    assert.deepEqual(received, {
      method: "POST",
      path: "/item/delete",
      body: {
        item: { collection: "DrawRGB000000001", location: "abcdefgh", id: "px_0_0" },
        root: "@",
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
