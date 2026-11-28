import { pingPeer } from "./pingPeer.js";
import { getNeighbors } from "./getNeighbors.js";
import { addItem } from "./addItem.js";
import { deleteItem } from "./deleteItem.js";
import { getSets } from "./getSets.js";
import { getZone, getCachedZone } from "./getZone.js";
import { getContent } from "./getContent.js";
import { getLocalFingerprint } from "./getLocalFingerprint.js";
import { refreshObservedCut } from "./refreshObservedCut.js";
import { getLocalChildren } from "./getLocalChildren.js";
import { getDirectRecords } from "./getDirectRecords.js";
import { readObservedCollection } from "./readObservedCollection.js";
import { getContentRecords } from "./getContentRecords.js";
import { getCollection } from "./getCollection.js";

// One transport implementation; single-zone reads delegate to the batch codec.
export class API {}
Object.assign(API.prototype, {
  pingPeer,
  getNeighbors,
  addItem,
  deleteItem,
  getSets,
  getZone,
  getCachedZone,
  getDirectRecords,
  readObservedCollection,
  getLocalChildren,
  getLocalFingerprint,
  refreshObservedCut,
  getContentRecords,
  getContent,
  getCollection,
});
