# Recheck local subtree content on demand

`api.getLocalFingerprint(protocol, peer, collection, location, options)` probes
one peer and address. The response includes its opaque subtree fingerprint,
disk observation guard and raw content monoid. An inconclusive local read
returns all three as null. Every response has `complete: false`. A subtree
covers its direct rows and descendants. The same content on a different peer
belongs to a different observation.

`api.refreshObservedCut(protocol, peer, collection, locations, options)` compares
a fixed list of disjoint subtree locations on that peer. The first probe addresses their
nearest common ancestor. For `["aa0", "aa1"]` it starts at `aa`. A single
leaf uses its own address, including when initializing a fingerprint-only
baseline in one request. Disjoint first characters start at the collection
root. When a certified ancestor has identical content, its descendants are
skipped. Changed or uncertain ancestors trigger bounded parallel descent toward
the supplied locations. The cut covers only its listed subtrees. For example,
an insertion under `z` can change the root without affecting a cut containing
only `a` and `b`. A cut rooted at `aa` never probes above that scope. Include an enclosing location in the cut and make its loader
rediscover children when newly created branches must enter that cached view.

```js
const options = {
  maxRequests: 128,
  concurrency: 4,
  viewKey: "direct-payloads-v1",
  load: (location, { signal }) =>
    api.getDirectRecords("http", peer, collection, location, 100, { includePayloads: true, signal }),
};
const cut = ["aa", "bb"];
let baseline = null;
let data = new Map();
async function refresh() {
  const result = await api.refreshObservedCut("http", peer, collection, cut, { ...options, baseline });
  if (result.accepted) {
    const next = new Map(data);
    for (const {location, value} of result.loads) next.set(location, value);
    data = next;
    baseline = result.baseline;
  }
  return result;
}
```

Use the same local data source, authorization and loader semantics throughout
a cache's lifetime. A loader for direct rows, as above, can reread them when
a descendant changes. For cached descendants, load and rediscover the whole
relevant local subtree. The local guard certifies reads from this disk alone.
A multi-peer cache must check each relevant peer and account for topology
changes. `viewKey` distinguishes projections or application views.

Each call returns one comparison. The application chooses when to recheck.
Serialize refreshes of the same cache or publish a result only if its input
baseline is still current. A baseline is an opaque in-process token owned by
the caller and scoped to endpoint, peer identity when supplied, collection,
view key and cut. Checks with the same locations in a different order work.

- `changed`, `unchanged`, `initial` and `unknown` partition the fixed cut.
  `changedFraction` is the number of confirmed changed cut locations divided
  by the total cut size. `unknown` and `initial` are reported separately.
  These counts measure locations and cannot estimate a fraction of documents.
  `changedAncestors` and `unknownAncestors` expose observations above the cut.
- Omit `load` to preview changes. A first comparison establishes a baseline
  of observed fingerprints. Subsequent previews preserve the caller's
  baseline, so a deferred load still sees pending changes. Supplying a loader
  for the first time stages data even for fingerprint-only entries.
- A data refresh re-probes after loading and checks the disk guard as well as
  the content fingerprint. A write followed by a revert can restore content
  while changing the guard. Each cached ancestor also requires a common
  guarded observation of its children. A write elsewhere on the same disk
  can conservatively defeat this certification.
- The loader must stage values privately, without mutating the live cache.
  On an uncertain or raced load the previous baseline is returned, with
  `accepted: false` and all staged `verified` flags false. On an RPC error,
  cancellation or exhausted budget the promise rejects after draining started
  work. In both cases keep the previous data and baseline together.
- `maxRequests` defaults to 256 and charges each SDK probe plus each loader
  invocation once. A loader performing multiple I/O operations must enforce
  its own inner budget. `concurrency` defaults to four concurrent probes or
  loader calls. A loader doing its own fan-out must bound that separately.
  The supplied AbortSignal is forwarded to probe transport and loader.

To refresh just part of one baseline, supply `load` and `reloadLocations`,
an array of distinct leaf locations from the original cut. For example,
`reloadLocations: ["bb"]` reloads only that leaf when required, while
reporting changes across the entire cut. Deferred leaves retain their last
acknowledged fingerprints. An ancestor spanning a deferred change cannot
hide it on the next comparison. The result lists these leaves in `deferred`.
An empty selection performs a preview and preserves any existing baseline.
