# Search eligible vectors by centroid

Build an in-memory inverted file (IVF) from a set of rows and
representative centroids of the same width. Each row needs a unique document
key (ID and optional location) and a finite dense vector. The SDK assigns a
row to the nearest centroid by squared Euclidean distance. A tie selects the
first centroid in input order. The SDK copies the centroid coordinates and
retains references to the input rows. Keep those rows and vectors immutable.

```js
import { buildIvfIndex } from "js-indexus-sdk";

const index = buildIvfIndex(rows, centroids);
const { hits, centroidDistances, visitedRows, candidateDistances } =
  index.search(query, { probes: 4, limit: 10, filter: row => row.category === "shop" });
```

Search scores every centroid and visits the requested number of nearest
lists. It evaluates the boolean predicate before computing each document
distance. With fewer probes than centroids, eligible neighbors in other
lists can be missed, and fewer than the requested number of hits can be
returned. Probing every list reproduces the exact eligible top-k, including
its tie order. The default is one probe and ten hits.

Building performs one full distance calculation per row and centroid and
retains one row reference per assignment. Each query reports centroid and
candidate distance counts separately. The number of rows visited can be
much higher than the number of eligible distances. The caller supplies the
centroids and reads the documents. The index lives in the SDK process.

For a series of queries sharing an eligibility predicate, the client can
materialize the selection once and index only its rows.

```js
const eligible = rows.filter(row => row.category === "shop");
const shopIndex = buildIvfIndex(eligible, centroids);
const page = shopIndex.search(query, {probes: 4, limit: 10});
```

With the same input order, centroids and probe count, this returns the same
hits as applying the predicate during search. It reduces the rows assigned
during construction and the rows visited during each query. The resulting
index covers only that selection. For a single query, `exactKnn(eligible,
query, {limit: 10})` can avoid the construction cost entirely.

## Append new documents

```js
index.add(newRows);
const updated = index.search(query, { probes: 4 });
```

Each added row is assigned to one existing list. The batch becomes visible
to subsequent searches after all its rows have been validated. A search that
already started keeps its original list lengths. Use fresh document keys
for each batch, including within the batch. The SDK treats each row as an
insertion. For replacements, deletions or new centroids, build an index from
the updated selection and switch to it once it is ready.

## Reproduce the local SIFT sessions

From the SDK checkout, supply the extracted SIFT1M fvecs directory. Use
100000 or 1000000 rows. Each run checks 64 top-10 queries against an
independent exhaustive squared-L2 oracle on a fixed 1/16 selection. It
also checks that a filtered global IVF and an IVF built on the selection
return identical hits at 16 probes with the same centroids.

```sh
node scripts/perf/sift-session.mjs /path/to/sift 1000000 > sift-1m.json
```

The JSON includes input-prefix hashes, setup time, recall, candidate visits,
and elapsed search time for 1, 4, 16 and 64 interactions. Add the setup
cost for the strategy being compared. Loading observations over the network
is a separate measurement. With 64 distinct queries, the reported p99
is the sample maximum.
