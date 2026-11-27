// The v1 CPU pack of a transition, kept as the reference of the GPU pack
// (gpu/pack.js) and of walk/pack.testkit.mjs.
const WIDTH = 14;

// Keep the exact geographic geometry and LOD slots previously sent to the GPU.
// Reconstructing an old image from a newly drilled tree can enlarge parent
// zones during rapid zoom and produce a bright coarse overlay.
export function writeSnapshotPair(output, current, previous = null, motion = null) {
  output.set(current);
  if (previous == null) return current.length / WIDTH;
  for (let i = 0; i < current.length; i += WIDTH) {
    output[i + 12] = 0;
    output[i + 13] = 0;
  }
  output.set(previous, current.length);
  for (let i = current.length; i < current.length + previous.length; i += WIDTH) {
    output[i + 4] = output[i];
    output[i + 5] = output[i + 1];
    output[i + 6] = output[i + 2];
    output[i + 7] = output[i + 3];
    output[i + 12] = output[i + 8];
    output[i + 13] = output[i + 9];
    output[i + 8] = 0;
    output[i + 9] = 0;
  }
  if (motion?.replay) markSubdivisionMotion(output, current, previous, motion);
  return (current.length + previous.length) / WIDTH;
}

const identity = (data, i, parent = false) =>
  `${data[i + 10] - (parent ? 1 : 0)}|${data[i + (parent ? 2 : 0)]}|${data[i + (parent ? 3 : 1)]}`;

function visibleCells(data, depth) {
  const cells = new Set();
  for (let i = 0; i < data.length; i += WIDTH) {
    if (data[i + 9] > 0 && Math.abs(data[i + 11] - depth) < 1) cells.add(identity(data, i));
  }
  return cells;
}

// Only animate a split/shrink when its actual parent was visible at the other
// endpoint. Packed IDs can alias across depths; use geometry + depth instead.
// Markers occupy unused channels of each endpoint, never its active n/d pair.
function markSubdivisionMotion(output, current, previous, { previousDepth, currentDepth }) {
  const oldCells = visibleCells(previous, previousDepth);
  const newCells = visibleCells(current, currentDepth);
  for (let i = 0; i < current.length; i += WIDTH) {
    if (
      currentDepth > current[i + 10] &&
      !oldCells.has(identity(current, i)) &&
      oldCells.has(identity(current, i, true))
    ) {
      output[i + 12] = current[i + 10];
      output[i + 13] = -1; // current endpoint starts at its parent's centroid
    }
  }
  for (let i = 0; i < previous.length; i += WIDTH) {
    if (
      previousDepth > currentDepth &&
      previousDepth > previous[i + 10] &&
      !newCells.has(identity(previous, i)) &&
      newCells.has(identity(previous, i, true))
    ) {
      output[current.length + i + 8] = -previousDepth;
      output[current.length + i + 9] = -currentDepth;
    }
  }
}
