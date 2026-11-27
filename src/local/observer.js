import { checkRead } from "../utilities/sharedRead.js";
import { Monitoring, State } from "../utilities/monitoring.js";
import { Item } from "../tree/item.js";

/**
 * Filter + locate children from a network response, then hand them to `addSet`.
 * Shared by single-parent getSet and multi-parent getSets waves.
 *
 * @param {import("../tree/set.js").Set} parentSet
 * @param {Array<import("../tree/set.js").Set | import("../tree/item.js").Item>} elements
 * @param {(el: any) => void} addSet
 */
export function ingestChildren(parentSet, elements, addSet) {
  const space = this.spaces[parentSet.collection()];
  const list = Array.isArray(elements) ? elements : [];

  for (const element of list) {
    if (!this.addLocation(space, element)) {
      this.monitoring.send(new Monitoring(this.level + 1, State.Filtered, element));
      continue;
    }

    addSet(element);
    this.monitoring.send(new Monitoring(this.level + 1, State.Indexed, element));
  }
}

export async function getSet(set, addSet) {
  checkRead(this.options?.signal);
  if (set._terminal === false && typeof this.network.getRecords !== "function") {
    throw new Error("A projected cell cannot be returned as a final item");
  }
  if (
    typeof this.network.getRecords === "function" &&
    set._terminal !== true &&
    set.count() > 0 &&
    set.count() <= 1000
  ) {
    const records = await this.network.getRecords(set.collection(), set.hash(), 1000, {
      signal: this.options?.signal,
    });
    checkRead(this.options?.signal);
    ingestChildren.call(this, set, records, addSet);
    return;
  }
  if (set instanceof Item) {
    addSet(set);
    this.monitoring.send(new Monitoring(this.level + 1, State.Indexed, set));
    return;
  }

  const elements = await this.network.getSet(set.collection(), set.hash(), {
    signal: this.options?.signal,
  });
  checkRead(this.options?.signal);
  ingestChildren.call(this, set, elements, addSet);
}

export function addLocation(space, element) {
  const location = [];
  const distances = [];
  const directions = [];
  let overall = 0;
  let active = true;
  const lowerBound = !(element instanceof Item) || element._terminal === false;

  const segments = space.decode(element.hash());

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    location.push(segment);
    const dimension = space.dimension(i);
    const origin = this.options.origins[dimension.name()];
    const filter = this.options.filters[dimension.name()];

    const distance = dimension.segmentDistance(origin, segment);
    distances.push(distance);

    const direction = dimension.segmentDirection(origin, segment);
    directions.push(direction);

    overall += distance / dimension.ratio() / segments.length;

    active =
      active &&
      dimension.filterDirection(filter, direction) &&
      dimension.filterDistance(filter, distance, lowerBound);
  }

  element.locate(location, distances, directions, overall);

  return active;
}
