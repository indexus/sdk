import { checkLocation, checkName, ROOT } from "../tree/alphabet.js";
import { asyncPool } from "../utilities/network.js";
import { checkRead } from "../utilities/sharedRead.js";
import { peerUrl } from "./transport.js";

// Only a token returned by this module can carry a trusted in-process baseline.
const baselines = new WeakMap();

function cutTree(locations) {
  if (!Array.isArray(locations) || !locations.length) throw new TypeError("Expected a nonempty fixed cut");
  const root = { location: ROOT, children: new Map() };
  for (const location of locations) {
    checkLocation(location);
    let node = root;
    for (let i = 1; location !== ROOT && i <= location.length; i++) {
      if (node.leaf) throw new RangeError("Overlapping cut locations");
      const prefix = location.slice(0, i);
      if (!node.children.has(prefix)) node.children.set(prefix, { location: prefix, children: new Map() });
      node = node.children.get(prefix);
    }
    if (node.leaf || node.children.size) throw new RangeError("Overlapping cut locations");
    node.leaf = true;
  }
  let start = root;
  while (start.children.size === 1) start = start.children.values().next().value;
  return start;
}

// Explicit comparison of disjoint subtrees on one peer. Return values from
// load are staged; the caller publishes them only after this promise resolves.
export async function refreshObservedCut(
  protocol,
  peer,
  collection,
  locations,
  {
    baseline = null,
    maxRequests = 256,
    concurrency = 4,
    viewKey = "default",
    load,
    reloadLocations,
    ...options
  } = {}
) {
  checkName(collection);
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  )
    throw new RangeError("Expected positive request and concurrency budgets");
  if (load !== undefined && typeof load !== "function") throw new TypeError("Expected a load function");
  if (typeof viewKey !== "string" || !viewKey) throw new TypeError("Expected a nonempty view key");
  const root = cutTree(locations);
  const cut = Array.from(locations).sort();
  const cutSet = new Set(cut);
  let targets = cutSet;
  if (reloadLocations !== undefined) {
    if (!Array.isArray(reloadLocations) || (!load && reloadLocations.length))
      throw new TypeError("Expected reload locations and a loader");
    targets = new Set(reloadLocations);
    if (targets.size !== reloadLocations.length || reloadLocations.some((location) => !cutSet.has(location)))
      throw new RangeError("Reload locations must be unique members of the cut");
  }
  const refreshData = Boolean(load && targets.size);
  const scope = JSON.stringify([
    peerUrl(protocol, peer.ip(), peer.port(), "/", options.gateway),
    peer.hash?.() ?? null,
    collection,
    viewKey,
    cut
  ]);
  const previous = baseline === null ? null : baselines.get(baseline);
  if (baseline !== null && previous?.scope !== scope)
    throw new TypeError("Baseline belongs to another peer, collection, view or cut");
  const next = new Map(previous?.entries);
  const states = new Map(),
    loads = new Map(),
    changedAncestors = [],
    unknownAncestors = [];
  let requests = 0,
    failed = false;
  function charge() {
    checkRead(options.signal);
    if (failed || requests >= maxRequests) throw new RangeError("Refresh request budget exhausted");
    requests++;
  }
  const probe = (node) => {
    charge();
    return this.getLocalFingerprint(protocol, peer, collection, node.location, options);
  };
  const pool = (nodes, work) =>
    asyncPool(concurrency, nodes, work, {
      signal: options.signal,
      onError: () => {
        failed = true;
      }
    });
  function markUnchanged(node) {
    if (node.leaf) states.set(node.location, "unchanged");
    else for (const child of node.children.values()) markUnchanged(child);
  }

  const visited = [];
  let frontier = [root];
  while (frontier.length) {
    const expanded = await pool(frontier, async (node) => {
      node.before = await probe(node);
      const { fingerprint, guard } = node.before;
      const prior = previous?.entries.get(node.location);
      const known = fingerprint !== null && guard !== null;
      const same = known && prior?.fingerprint === fingerprint;
      if (same && (!refreshData || prior.ready)) {
        node.reused = true;
        markUnchanged(node);
        return [];
      }
      if (node.leaf) {
        node.deferred = refreshData && !targets.has(node.location);
        node.same = same;
        states.set(node.location, !known ? "unknown" : !prior ? "initial" : same ? "unchanged" : "changed");
        return [];
      }
      if (!known) unknownAncestors.push(node.location);
      else if (prior && !same) changedAncestors.push(node.location);
      return [...node.children.values()];
    });
    visited.push(...frontier);
    frontier = expanded.flat();
  }
  let accepted = false;
  // A comparison on an existing baseline never acknowledges dirty data.
  if (refreshData || !previous) {
    if (refreshData) {
      await pool(
        visited.filter((n) => n.leaf && !n.reused && !n.deferred),
        async (node) => {
          charge();
          const value = await load(node.location, { signal: options.signal });
          loads.set(node.location, { location: node.location, value, verified: false });
        }
      );
    }
    const validate = visited.filter(
      (n) => !n.reused && !n.deferred && (!n.leaf || refreshData) && n.before.guard !== null && n.before.fingerprint !== null
    );
    await pool(validate, async (node) => {
      node.after = await probe(node);
    });
    // Certify descendants before their ancestors. A parent shortcut represents
    // one guarded local view of every cut entry it can skip, including loads.
    for (const node of visited.reverse()) {
      if (node.reused) continue;
      if (node.deferred) {
        // Keep the last acknowledged leaf. Its current ancestors may only
        // become shortcuts when the stored leaf still describes this view.
        node.unacknowledged = !node.same;
        continue;
      }
      // A leaf fingerprint is already a single observation. Only loads and
      // compound ancestor baselines need corroboration across multiple reads.
      const stable = node.before.guard !== null && node.before.fingerprint !== null &&
        ((node.leaf && !refreshData) || (node.after?.guard === node.before.guard &&
          node.after.fingerprint === node.before.fingerprint));
      const children = [...node.children.values()];
      node.unacknowledged = children.some(child => child.unacknowledged);
      const uncertain = !stable || children.some(child =>
        child.before.guard !== node.before.guard || (!child.unacknowledged && !next.has(child.location)));
      if (node.unacknowledged || uncertain) {
        next.delete(node.location);
        if (uncertain) {
          if (node.leaf) states.set(node.location, "unknown");
          else if (!unknownAncestors.includes(node.location)) unknownAncestors.push(node.location);
        }
        continue;
      }
      if (node.leaf && refreshData) loads.get(node.location).verified = true;
      const ready = node.leaf ? refreshData : [...node.children.values()].every((c) => next.get(c.location).ready);
      next.set(node.location, { fingerprint: node.before.fingerprint, ready });
    }
    // A caller must be able to keep its previous data and baseline together.
    // If any loaded leaf raced or had no evidence, publish none of the batch.
    if (refreshData && [...loads.values()].some((entry) => !entry.verified)) {
      for (const entry of loads.values()) entry.verified = false;
    } else {
      accepted = true;
      baseline = Object.freeze({});
      baselines.set(baseline, { scope, entries: next });
    }
  }
  checkRead(options.signal);
  const result = {
    baseline,
    accepted,
    total: cut.length,
    requests,
    complete: false,
    changed: [],
    unchanged: [],
    initial: [],
    unknown: [],
    changedAncestors: changedAncestors.sort(),
    unknownAncestors: unknownAncestors.sort(),
    deferred: visited
      .filter((n) => n.deferred)
      .map((n) => n.location)
      .sort(),
    loads: []
  };
  for (const location of cut) {
    result[states.get(location)].push(location);
    if (loads.has(location)) result.loads.push(loads.get(location));
  }
  result.changedFraction = result.changed.length / result.total;
  return result;
}
