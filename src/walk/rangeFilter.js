// An ISO calendar date/time with an explicit UTC offset and millisecond
// precision. Normalize the civil part in UTC to validate leap days and
// reject rollover (including 24:00). No host time zone or locale is used.
const timestamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?(Z|([+-])(\d\d):(\d\d))$/;

export function epochMillis(value) {
  if (Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000) return value;
  const m = typeof value === "string" && timestamp.exec(value);
  if (!m || m[0] !== value) throw new TypeError("Expected epoch milliseconds or an offset timestamp");
  const canonical = m[1] + "." + (m[2] ?? "").padEnd(3,"0") + "Z";
  const ms = Date.parse(canonical);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== canonical)
    throw new RangeError("Invalid timestamp calendar date or time");
  if (m[3] === "Z") return ms;
  const hours = Number(m[5]), minutes = Number(m[6]);
  if (hours > 23 || minutes > 59 || m[3] === "-00:00")
    throw new RangeError("Expected a known UTC offset");
  const offset = (hours * 60 + minutes) * 60000;
  return m[4] === "+" ? ms - offset : ms + offset;
}

export function finiteNumber(value) {
  if (!Number.isFinite(value)) throw new TypeError("Expected a finite number");
  return value;
}

// Compile once. At most one lower and one upper bound may be specified.
export function rangeFilter(select, bounds, normalize) {
  if (typeof select !== "function") throw new TypeError("Expected a range selector");
  if (bounds == null || typeof bounds !== "object" || Array.isArray(bounds))
    throw new TypeError("Expected a range object");
  const keys = Object.keys(bounds);
  if (!keys.length || keys.some(k => !["gt","gte","lt","lte"].includes(k)))
    throw new TypeError("Expected gt, gte, lt or lte");
  const openLower = keys.includes("gt"), openUpper = keys.includes("lt");
  if (openLower && keys.includes("gte") || openUpper && keys.includes("lte"))
    throw new RangeError("Conflicting bounds on the same end");
  // Every supported concrete value normalizes to a finite number. Reserve
  // -Infinity for null or missing, which sorts before all concrete values.
  const ordered = value => value === null ? -Infinity : normalize(value);
  const low = openLower ? ordered(bounds.gt) : keys.includes("gte") ? ordered(bounds.gte) : -Infinity;
  const high = openUpper ? ordered(bounds.lt) : keys.includes("lte") ? ordered(bounds.lte) : Infinity;
  if (low > high) throw new RangeError("Lower bound exceeds upper bound");
  return row => {
    const raw = select(row);
    const value = raw == null ? -Infinity : normalize(raw);
    return (openLower ? value > low : value >= low) && (openUpper ? value < high : value <= high);
  };
}
