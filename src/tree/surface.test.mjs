// The public names of the SDK root, frozen before the address algebra moved
// into src/tree. The collection description (tree/description.js) added its
// reading functions. A move must not add, drop or rename one; a wave that retires
// or adds a public name updates this list in the same commit.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../index.js";
import * as tree from "./index.js";

const PUBLIC = [
  "API",
  "Collection",
  "ContentAssets",
  "GatewaySession",
  "Item",
  "LOCATION_ALPHABET",
  "Linear",
  "Local",
  "Network",
  "Peer",
  "ROOT",
  "Set",
  "Space",
  "Spherical",
  "abelianCount",
  "abelianCountEqual",
  "abelianEqual",
  "abelianMetrics",
  "abelianSubtract",
  "abelianSum",
  "abelianTotal",
  "buildCollectionAndSpace",
  "cellOrder",
  "combineValues",
  "contentAssetLocation",
  "debugEnabled",
  "debugLog",
  "decodeDescription",
  "decodeUrl64",
  "descriptionName",
  "encodeFixed",
  "encodeUrl64",
  "foldInCellOrder",
  "isDirectChild",
  "isTyped",
  "parent",
  "setDebug",
  "setDebugSink",
  "zoneKey",
  "verifyDescription",
  "zoneKeyID",
];

test("src/index.js exports exactly the names it exported before the tree move", () => {
  assert.deepEqual(Object.keys(sdk).sort(), [...PUBLIC].sort());
});

test("the root re-exports the tree implementations, not copies", () => {
  for (const name of [
    "Space",
    "Spherical",
    "Linear",
    "Item",
    "Set",
    "Collection",
    "ROOT",
    "parent",
    "zoneKeyID",
  ]) {
    assert.equal(sdk[name], tree[name], name);
  }
  assert.equal(sdk.LOCATION_ALPHABET, tree.ROUTING_ALPHABET);
});
