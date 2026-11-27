// Harness of the heat pipeline v2 in Node: a node on a local port serving
// real IXB2 blocks (walk testkit data, store testkit encoder), the heat worker
// behind a MessageChannel (buffers really transferred), the main pipeline on a
// fake device that runs the float32 emulation of the pack and combine kernels.
// Not shipped.
import http from "node:http";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { readFileSync } from "node:fs";

import { getSets as wireGetSets } from "../../api/getSets.js";
import { Peer } from "../../wire/peer.js";
import { BLOCK_CONTENT_TYPE, suffixAt } from "../../wire/block.js";
import { Collection, Space, ROOT } from "../../tree/index.js";
import { encodeBlocks } from "../../store/testkit.mjs";
import { COLLECTION, makeSpace, serve } from "../../walk/walk.testkit.mjs";
import { fakeDevice } from "../../gpu/device.testkit.mjs";
import { emulateStage } from "../../gpu/combine.testkit.mjs";
import { createHeatWorker } from "../workers/heat.worker.js";
import { createHeatmapPipeline } from "./pipeline.js";
import { compose } from "./compose.js";

export const DEFINITION = {
  name: COLLECTION,
  dimensions: [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }],
};
export const NAME = "AAAAAAAAAAAAAAAA";
export const POSITION = {
  mode: "metrics",
  latIndex: 3,
  lngIndex: 4,
  metricScale: 1e6,
  latOffset: 90,
  lngOffset: 180,
};

const v1Wire = JSON.parse(
  readFileSync(new URL("../../api/testdata/peer-wire.json", import.meta.url)),
);

/** The same dimensions under another collection name: other keys for the same cells. */
export function definitionOf(name) {
  return { name, dimensions: DEFINITION.dimensions };
}

export function spaceOf(definition) {
  const collection = new Collection(definition.name, definition.dimensions);
  return new Space(collection.dimensions(), collection.mask(), collection.offset());
}

const INIT = {
  cubeOpt: { limit: 5, children: 4, resolution: 5 },
  pointOverlay: { maxPoints: 1 },
};

function network(node) {
  return {
    protocol: "http",
    peers: [node.host],
    concurrency: 4,
    cacheSize: 100,
    setsPool: { meshDiscovery: false },
  };
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The section of `block` (a walk testkit RowsBlock) as encodeBlocks takes it. */
function section(block) {
  const { n, metricCount, metrics } = block;
  return {
    parent: block.parent,
    suffixes: Array.from({ length: n }, (_, row) => suffixAt(block, row)),
    count: Array.from(block.count),
    metrics: Array.from({ length: metricCount }, (_, j) =>
      Array.from(metrics.subarray(j * n, (j + 1) * n)),
    ),
  };
}

/**
 * A node holding `points` (mutable: `node.points = …`). Every `/sets` is
 * logged as its list of locations. `node.delayMs` slows answers down,
 * `node.v1 = true` makes it an older node.
 */
export async function startNode(points, { itemThreshold = 8 } = {}) {
  const node = { points, delayMs: 0, v1: false, requests: [], aborted: 0, columnsAsked: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://node");
    const locations = url.searchParams.get("location").split(",");
    node.requests.push(locations);
    let closed = false;
    // The answer's socket closed before it was written: the reader went away.
    res.on("close", () => {
      if (!res.writableEnded) {
        closed = true;
        node.aborted++;
      }
    });
    if (node.delayMs) await delay(node.delayMs);
    if (closed) return;
    if (node.v1) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from(v1Wire.envelopeHex, "hex"));
      return;
    }
    const sections = locations.flatMap((location) =>
      serve(node.points, location, { itemThreshold }).map(section),
    );
    const f64 = url.searchParams.get("metrics") === "f64";
    const columns = url.searchParams.get("columns")?.split(",").map(Number) ?? null;
    node.columnsAsked.push(columns);
    res.writeHead(200, { "content-type": BLOCK_CONTENT_TYPE });
    res.end(Buffer.from(encodeBlocks(sections, { f64, columns })));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  node.port = server.address().port;
  node.host = `127.0.0.1|${node.port}`;
  node.zonesRead = () => node.requests.flat();
  node.stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return node;
}

/** The real `/sets` call; the peer is named without a ping. */
export function apiFor(node) {
  return {
    async pingPeer(_protocol, ip, port) {
      return new Peer(NAME, { [ip]: null }, Number(port), ip);
    },
    async getNeighbors() {
      return [];
    },
    getSets: wireGetSets,
  };
}

export function packDevice() {
  const limits = { maxStorageBufferBindingSize: 128 << 20, maxBufferSize: 256 << 20 };
  return fakeDevice({ run: emulateStage, limits });
}

/** A heat worker reading `node`, and the port a pipeline talks to it through. */
function link(node) {
  const channel = new MessageChannel();
  // `delivered` and `received` count what each side has handled: messages
  // still in the channel are work in progress, whatever the clock says.
  // `posts`: the worker's own messages and transfer lists, as posted.
  const l = {
    node,
    messages: [],
    sentToWorker: [],
    plans: [],
    posts: [],
    delivered: 0,
    received: 0,
  };
  l.worker = createHeatWorker({
    api: apiFor(node),
    post: (message, transfer) => {
      l.messages.push(message.type);
      if (message.type === "PLAN") l.posts.push({ message, transfer: transfer ?? [] });
      channel.port2.postMessage(message, transfer ?? []);
    },
  });
  channel.port2.onmessage = (event) => {
    l.delivered++;
    l.worker.handle(event.data);
  };
  l.port = {
    postMessage(message, transfer) {
      l.sentToWorker.push(message.type);
      channel.port1.postMessage(message, transfer ?? []);
    },
    set onmessage(handler) {
      channel.port1.onmessage = (event) => {
        l.received++;
        if (event.data.type === "PLAN") {
          l.beforePlan?.();
          l.plans.push(event.data.payload);
        }
        handler(event);
      };
    },
  };
  l.close = () => {
    channel.port1.close();
    channel.port2.close();
  };
  return l;
}

/**
 * The harness around a pipeline and its links. `clock.t` drives the fades.
 */
function harness(pipeline, links, clock) {
  const h = { pipeline, clock, links };
  h.move = (zoom, segment) => {
    const bounds = [{ dimension: 0, segment }];
    pipeline.move({ zoom, bounds, strictBounds: bounds });
  };
  h.close = () => {
    for (const l of links) l.worker.destroy();
    pipeline.destroy();
    for (const l of links) l.close();
  };
  /**
   * Lets the reads, plans and fades run to rest: every fade is finished as
   * soon as it starts, unless `fades` is false.
   */
  h.settle = async ({ fades = true, quiet = 10 } = {}) => {
    const pipelines = pipeline.fields ? Object.values(pipeline.fields) : [pipeline];
    const traffic = () =>
      links.reduce((sum, l) => sum + l.messages.length + l.sentToWorker.length, 0);
    let calm = 0;
    let seen = -1;
    for (let i = 0; i < 2000 && calm < quiet; i++) {
      await delay(10);
      if (fades) {
        clock.t += 1000;
        for (const each of pipelines) each.controller.getTransitionFactor();
      }
      const reading = links.some((l) => h.busy(l));
      const fading = fades && pipelines.some((each) => each.state.fade.active);
      calm = !reading && !fading && traffic() === seen ? calm + 1 : 0;
      seen = traffic();
    }
  };
  /** A read on the wire, a refresh, or a message one side has not handled yet. */
  h.busy = (l) =>
    l.worker.state.inflight.size > 0 ||
    l.worker.state.refreshing ||
    l.delivered !== l.sentToWorker.length ||
    l.received !== l.messages.length;
  /** Resolves once `predicate()` holds (polled), or fails after `ms`. */
  h.until = async (predicate, ms = 5000) => {
    for (let waited = 0; !predicate(); waited += 5) {
      if (waited > ms) throw new Error("heat testkit: condition not reached");
      await delay(5);
    }
  };
  return h;
}

/**
 * Worker and pipeline joined by a MessageChannel. `messages` logs what the
 * worker sent, by type.
 */
export async function connect(node, options = {}) {
  const { heat, previousHeat, budgetBytes, device = packDevice(), init = {} } = options;
  const { collection = DEFINITION, position = POSITION, fades, requestFrame = () => 0 } = options;
  const l = link(node);
  const clock = { t: 0 };
  const pipeline = createHeatmapPipeline({
    worker: l.port,
    collection,
    device,
    heat,
    previousHeat,
    position,
    budgetBytes,
    fades,
    now: () => clock.t,
    requestFrame,
    summarize: (count, sums) => ({ count, sums }),
  });
  pipeline.init({ network: network(node), ...INIT, ...init });
  const { worker, messages, sentToWorker, plans } = l;
  return Object.assign(harness(pipeline, [l], clock), {
    node,
    worker,
    messages,
    sentToWorker,
    plans,
    space: makeSpace(),
  });
}

/**
 * compose() over `fields` [{name, node, collection, rules, missing}], one
 * worker per field, all on `device`.
 */
export async function connectFields(fields, { expression, device = packDevice() } = {}) {
  const links = fields.map((field) => link(field.node));
  const clock = { t: 0 };
  const pipeline = compose({
    fields: fields.map(({ node, ...field }, i) => ({
      ...field,
      worker: links[i].port,
      init: { network: network(node) },
    })),
    expression,
    device,
    position: POSITION,
    now: () => clock.t,
    requestFrame: () => 0,
  });
  pipeline.init(INIT);
  return Object.assign(harness(pipeline, links, clock), { device });
}

/** Instances in a fake GPU buffer. */
export function readInstances(packed) {
  if (!packed.gpuBuffer) return new Float32Array(0);
  return new Float32Array(packed.gpuBuffer.bytes, 0, packed.count * 14).slice();
}

/** What a node serves for the zones it was asked. */
export function servedZones(node, { itemThreshold = 8 } = {}) {
  const zones = new Map();
  for (const zone of new Set(node.zonesRead())) {
    zones.set(zone, serve(node.points, zone, { itemThreshold }));
  }
  if (!zones.has(ROOT)) zones.set(ROOT, serve(node.points, ROOT, { itemThreshold }));
  return zones;
}
