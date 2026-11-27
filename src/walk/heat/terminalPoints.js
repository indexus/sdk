// Point identity and coordinates come only from verified leaf records. Never
// group by rounded coordinates: distinct records can occupy the same address.
export function terminalPoints(records, viewport, maxPoints, position, value) {
  const unique = new Map();
  for (const record of records) {
    if (record?._terminal !== true || !record._id || !record._hash) {
      throw new Error("A point requires a verified terminal record");
    }
    const key = JSON.stringify([record._collection, record._hash, record._id]);
    unique.set(key, record);
  }
  const data = [],
    keys = [],
    metricSums = [],
    recordMetrics = [];
  const [south, north, west, east] = viewport;
  for (const key of [...unique.keys()].sort()) {
    const record = unique.get(key),
      point = position(record);
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      throw new Error("A terminal point requires its own location");
    }
    const longitudeInside =
      west <= east
        ? point.lng >= west && point.lng <= east
        : point.lng >= west || point.lng <= east;
    if (point.lat < south || point.lat > north || !longitudeInside) continue;
    if (keys.length >= maxPoints) {
      const error = new RangeError("Terminal point budget exceeded");
      error.code = "POINT_BUDGET";
      throw error;
    }
    data.push(point.lng, point.lat, value(record));
    keys.push(key);
    recordMetrics.push(Array.isArray(record._metrics) ? record._metrics.slice() : []);
    const metrics = record._metrics;
    if (Array.isArray(metrics)) {
      while (metricSums.length < metrics.length) metricSums.push(0);
      for (let i = 0; i < metrics.length; i++) {
        if (Number.isFinite(metrics[i])) metricSums[i] += metrics[i];
      }
    }
  }
  return {
    count: keys.length,
    keys,
    metricSums,
    recordMetrics,
    buffer: data.length ? new Float32Array(data).buffer : null,
  };
}
