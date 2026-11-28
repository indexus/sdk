# Search eligible vectors by centroid

Build an in-memory inverted file (IVF) from one immutable set of rows and
representative centroids of the same width. Each row needs a unique document
key (ID and optional location) and a finite dense vector. The SDK assigns a
row to the nearest centroid by squared Euclidean distance. A tie selects the
first centroid in input order. The SDK copies the centroid coordinates and
retains references to the input rows. Rebuild when the data changes.

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
