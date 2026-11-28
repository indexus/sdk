# Exact local document masks

The public SDK export `DocumentUniverse` labels each ordinal with one unique
document ID in a single segment and revision. Supply the deleted ordinals when
creating the universe. If IDs repeat at different addresses, supply distinct
application keys for those records (or use separate universes per address).

```js
const u = new DocumentUniverse("segment-A", "revision-17", ["a","b","c"], [1]);
const residential = u.posting([0,1]);
const aboveLimit = u.posting([0,2]);
const count = u.intersectionCount(residential, aboveLimit); // 1
const ids = u.ids(u.and(residential, aboveLimit)); // ["a"]
```

`and`, `or`, `andNot` and `not` preserve the live set. `count` and
`intersectionCount` count bits without an ID array or intermediate mask.
Rebuild after changing ordinal order, liveness or revision. Tokens belong to
one in-process universe; foreign masks are rejected even if their labels
match. The caller supplies postings and verifies segment disjointness when
adding counts. Bloom filters and per-zone presence masks cannot act as document
postings. A mask uses four bytes per 32 ordinals plus runtime object overhead.

`node scripts/perf/document-bitsets/anglet.mjs /path/to/batiment.geojson`
checks the real-corpus set operations and counts against a direct row scan.
