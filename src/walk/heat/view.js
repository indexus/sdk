// The camera's window and display zoom, as the heat worker walks them.
//
// Geographic windows are deliberately conservative at the date line: a wrapped
// interval is refreshed rather than mistaken for a contained ordinary interval.
function ordinary(bounds) {
  return (
    Array.isArray(bounds) &&
    bounds.length === 1 &&
    bounds[0]?.segment?.length === 4 &&
    bounds[0].segment.every(Number.isFinite) &&
    bounds[0].segment[0] <= bounds[0].segment[1] &&
    bounds[0].segment[2] <= bounds[0].segment[3]
  );
}

function containsView(outer, inner) {
  if (!ordinary(outer) || !ordinary(inner)) return false;
  const [s, n, w, e] = outer[0].segment,
    [a, b, c, d] = inner[0].segment;
  return s <= a && n >= b && w <= c && e >= d;
}

function expandView(bounds, margin) {
  if (!ordinary(bounds)) return bounds;
  const [s, n, w, e] = bounds[0].segment;
  const lat = (n - s) * margin,
    lng = (e - w) * margin;
  return [{ dimension: bounds[0].dimension, segment: [s - lat, n + lat, w - lng, e + lng] }];
}

export function viewWindow(previous, bounds, depth, margin) {
  if (previous?.depth === depth && containsView(previous.bounds, bounds)) return previous;
  return { depth, bounds: expandView(bounds, margin) };
}

// At most one intermediate bracket. Larger jumps go straight to the camera;
// no queue of historical zoom requests survives a reversal or a fast zoom.
export function nextDisplayZoom(previousDepth, zoom, resolution) {
  const depth = Math.floor(zoom + resolution);
  const gap = depth - previousDepth;
  if (!Number.isFinite(previousDepth) || Math.abs(gap) !== 2) return zoom;
  return previousDepth + Math.sign(gap) - resolution + (zoom + resolution - depth);
}
