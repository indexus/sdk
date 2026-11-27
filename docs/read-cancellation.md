# Read lifetime

`Network.getSet`, `getSets` and `getRecords` accept `{signal, timeoutMs}` options.
The default total deadline is 15 seconds, including queueing and redirects.
The low-level exact-record HTTP request also keeps its 10-second timeout.

A shared read owns its transport controller. Each caller joins independently.
Canceling one caller rejects only that caller; the transport is aborted once
all consumers leave. Coalesced HTTP chunks follow the same rule. An HTTP chunk
already sent cannot discard individual locations while another consumer needs
its response. Queued chunks without consumers never reach the server.

Cancellation preserves cached data and peer knowledge. Late results from an
aborted transport do not populate the cache. A deadline is not evidence that a
peer left. No write operation is covered by these read cancellation scopes.

The heat worker (`src/walk/heat/worker.js`) gives each batch of zones
it asks for its own controller and aborts the batches the view no longer
needs. Blocks already in the store remain intact. Hidden maps and leaving Aggregate
cancel the traversal; returning restarts an incomplete traversal. Point record
reads stay alive across zooms while their geographic prefixes still intersect
the viewport; offscreen prefixes are canceled. Nearby search uses a separate
scope canceled when hidden or leaving Nearby.

Tests: `npm test`, particularly `src/network/cancellation.test.mjs` and
`src/api/cancellation.test.mjs` (real HTTP disconnects).
