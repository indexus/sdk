// Network tests describe a node's answer as Items and Sets. The network reads
// IXB2 only, so `withBlocks(api)` wraps a stub API whose getSets returns
// `{elements, redirects, ingress}` and encodes that answer as IXB2: each
// element goes to the asked zone that is its longest prefix (the root holds
// the rest), rows grouped by key length. Elements read back carry the v1
// metric view (wire/block.js blocksToElements), as from a real node.
import { ROOT } from "../tree/alphabet.js";
import { decodeBlocks } from "../wire/block.js";
import { encodeBlocks } from "../store/testkit.mjs";

function parentOf(hash, zones) {
  let best = null;
  for (const zone of zones) {
    if (zone === ROOT) continue;
    if (hash.length > zone.length && hash.startsWith(zone) && zone.length > (best?.length ?? -1))
      best = zone;
  }
  if (best !== null) return best;
  return zones.includes(ROOT) ? "" : null;
}

/** An `{elements, redirects, ingress}` answer to `zones`, as the raw IXB2 answer. */
export function asBlocks(answer, zones) {
  const sections = new Map();
  for (const element of answer.elements ?? []) {
    const hash = element.hash();
    const parent = parentOf(hash, zones);
    if (parent === null) continue;
    const suffix = hash.slice(parent.length);
    const key = `${parent}/${suffix.length}`;
    let section = sections.get(key);
    if (!section) sections.set(key, (section = { parent, suffixes: [], count: [], values: [] }));
    section.suffixes.push(suffix);
    section.count.push(element.count());
    section.values.push(element.metrics?.() ?? []);
  }
  const blocks = [...sections.values()].map(({ parent, suffixes, count, values }) => {
    const m = Math.max(0, ...values.map((row) => row.length));
    const metrics = Array.from({ length: m }, (_, j) => values.map((row) => row[j] ?? 0));
    return { parent, suffixes, count, metrics };
  });
  const redirects = answer.redirects ?? [];
  const buffer = encodeBlocks(blocks, { redirects });
  const decoded = decodeBlocks(buffer);
  const rows = decoded.blocks.reduce((sum, block) => sum + block.n, 0);
  return { format: "block", buffer, ...decoded, ingress: answer.ingress ?? null, rows };
}

/** Makes a stub API's element answers IXB2 answers. Returns the same object. */
export function withBlocks(api) {
  if (!api?.getSets || api.getSets.blocks) return api;
  const getSets = api.getSets.bind(api);
  api.getSets = async (protocol, peer, collection, locations, options) => {
    const answer = await getSets(protocol, peer, collection, locations, options);
    return answer?.blocks ? answer : asBlocks(answer, locations);
  };
  api.getSets.blocks = true;
  return api;
}
