// The address algebra of Indexus: one binary tree for nodes, collections,
// zones and items. See docs/layers.md. Pure: no I/O, no globals. Inside the
// SDK, modules import the file they need; this index names the stable surface.
export {
  ROOT,
  LOCATION_ALPHABET as ROUTING_ALPHABET,
  BITS_PER_CHAR,
  encodeFixed,
  decodeFixed,
  parent,
  isDirectChild,
  zoneKey,
  zoneKeyID,
} from "./alphabet.js";
export { Space } from "./space.js";
export { Spherical } from "./spherical.js";
export { Linear } from "./linear.js";
export { Mask } from "./mask.js";
export { Offset } from "./offset.js";
export { Item } from "./item.js";
export { Set } from "./set.js";
export { Collection } from "./collection.js";
export * from "./abelian.js";
export {
  decodeDescription,
  encodeDescription,
  descriptionName,
  verifyDescription,
  isTyped,
  cellOrder,
  compareCellOrder,
  zeroValue,
  liftValue,
  combineValues,
  foldInCellOrder,
} from "./description.js";
