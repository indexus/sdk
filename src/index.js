// Entities — the vocabulary of go-indexus-core: a Collection holds Sets of
// Items, each addressed by a location in the Space the collection declares.
export { Item } from "./tree/item.js";
export { Set } from "./tree/set.js";
export { Collection } from "./tree/collection.js";
export { Space } from "./tree/space.js";
export {
  abelianCount,
  abelianMetrics,
  abelianEqual,
  abelianCountEqual,
  abelianSum,
  abelianSubtract,
  abelianTotal,
} from "./tree/abelian.js";
export {
  decodeDescription,
  descriptionName,
  verifyDescription,
  isTyped,
  cellOrder,
  combineValues,
  foldInCellOrder,
} from "./tree/description.js";

// Read modes. Both go through Network (same getSets / zone-cache code path).
// Sharing one live Network+cache only holds when both hold the same instance;
// dashboard Nearby (main) and Aggregate (worker) each construct their own.
export { Local } from "./local/index.js"; // Nearby — nearest items, ring by ring

// Networking
export { Peer } from "./wire/peer.js";
export { Network } from "./network/index.js";

// API
export { API } from "./api/index.js";

// Dimensions
export { Spherical } from "./tree/spherical.js";
export { Linear } from "./tree/linear.js";

// Read-path diagnostics — off unless switched on (see utilities/debug.js).
export { setDebug, setDebugSink, debugEnabled, debugLog } from "./utilities/debug.js";

// Location algebra
export {
  ROOT,
  LOCATION_ALPHABET,
  encodeFixed,
  parent,
  isDirectChild,
  zoneKey,
  zoneKeyID,
} from "./tree/alphabet.js";
export { encodeUrl64, decodeUrl64 } from "./utilities/url64.js";

// Thread-local runtime factories (safe to call inside browser workers).
export { buildCollectionAndSpace } from "./runtime/index.js";

export { ContentAssets, contentAssetLocation } from "./network/contentAssets.js";
export { GatewaySession } from "./runtime/gatewaySession.js";
export { numericFacet, scalarFacet } from "./walk/facets.js";
export { groupCounts, limitPerGroup } from "./walk/groupCounts.js";
export { numericStats } from "./walk/numericStats.js";

export { fuseRankings } from "./walk/fuseRankings.js";

// Presence of vocabulary values in covered IXB2 rows.
export { presenceMasks } from "./walk/presence.js";
export { buildBM25Index, mergeBM25Statistics } from "./walk/bm25.js";
export { exactSparseDot } from "./walk/exactSparseDot.js";
export { exactMaxSim } from "./walk/exactMaxSim.js";
export { buildIvfIndex } from "./walk/ivf.js";
export { exactKnn } from "./walk/exactKnn.js";
export { topByAttribute, topByAttributes } from "./walk/topByAttribute.js";
export { documentFilter } from "./walk/documentFilter.js";
export { selectDirectRecords } from "./walk/selectDirectRecords.js";

export { walkLocalChildren } from "./walk/walkLocalChildren.js";
export { numericHistogram, mergeNumericHistograms, histogramQuantile } from "./walk/numericHistogram.js";

export { DocumentUniverse } from "./walk/documentUniverse.js";
export { mergeSubtreeFingerprints } from "./walk/subtreeFingerprint.js";
