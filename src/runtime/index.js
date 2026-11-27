import { Collection } from "../tree/collection.js";
import { Space } from "../tree/space.js";

/**
 * Recreate SDK entities in the thread that uses them. SDK prototypes do not
 * survive structuredClone, so workers receive plain definitions/config.
 */
export function buildCollectionAndSpace(definition) {
  const collection = new Collection(definition.name, definition.dimensions);
  const space = new Space(collection.dimensions(), collection.mask(), collection.offset());
  return { collection, space };
}
