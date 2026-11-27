import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { getSets } from "./getSets.js";
import { getZone } from "./getZone.js";
import { getNeighbors } from "./getNeighbors.js";
import { getContentRecords } from "./getContentRecords.js";
import { addItem } from "./addItem.js";
import { deleteItem } from "./deleteItem.js";
import { pingPeer } from "./pingPeer.js";
import { Peer } from "../wire/peer.js";

const requests = [
  ["getSets", (peer, options) => getSets("http", peer, "collection", ["a"], options)],
  ["getZone", (peer, options) => getZone("http", peer, "collection", "a", options)],
  ["getNeighbors", (peer, options) => getNeighbors("http", peer, "origin", options)],
  [
    "getContentRecords",
    (peer, options) => getContentRecords("http", peer, "collection", "a", 1, options),
  ],
  ["addItem", (peer, options) => addItem("http", peer, "collection", "@", "a", [1], "id", options)],
  [
    "deleteItem",
    (peer, options) => deleteItem("http", peer, "collection", "@", "a", "id", options),
  ],
  ["pingPeer", (peer, options) => pingPeer("http", peer.ip(), peer.port(), options)],
];
for (const [name, read] of requests)
  test(`${name} abort closes a real HTTP response`, async () => {
    let started, closed;
    const start = new Promise((resolve) => {
        started = resolve;
      }),
      stop = new Promise((resolve) => {
        closed = resolve;
      });
    const server = http.createServer((_req, res) => {
      res.on("close", closed);
      started();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const controller = new AbortController(),
      peer = new Peer(
        "AAAAAAAAAAAAAAAA",
        { "127.0.0.1": null },
        server.address().port,
        "127.0.0.1",
      );
    try {
      const request = read(peer, { signal: controller.signal });
      const rejected = assert.rejects(request, { code: "ERR_CANCELED" });
      await start;
      controller.abort();
      await rejected;
      let timer;
      try {
        await Promise.race([
          stop,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("server work remained alive")), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
