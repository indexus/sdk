// Column names identify indicator categories. Null denotes a metric that is
// not an indicator. Revision identifies the dictionary/encoding at ingestion.
function checkSchema(schema) {
  if (typeof schema?.revision !== "string" || !schema.revision ||
      !Array.isArray(schema.columns) || schema.columns.length > 4096)
    throw new TypeError("Expected a presence schema with revision and ordered columns");
  const names = new Set();
  for (const name of schema.columns) {
    if (name === null) continue;
    if (typeof name !== "string" || !name || names.has(name))
      throw new TypeError("Expected distinct indicator names or null in presence schema");
    names.add(name);
  }
}

function matchesSchema(actual, expected) {
  if (actual?.revision !== expected.revision || !Array.isArray(actual.columns) ||
      actual.columns.length !== expected.columns.length) return false;
  for (let i = 0; i < expected.columns.length; i++)
    if (actual.columns[i] !== expected.columns[i]) return false;
  return true;
}

// Fold the nonnegative integral indicator sums for a bounded vocabulary.
// Bit i corresponds to the original metric position sourceColumns[i].
// A bit in neither mask is unknown. Only an absent bit can skip a branch.
//
// Each element is one disjoint part of the requested cut. Pass {response,
// complete: true} only after verifying its coverage, revision, and indicator
// schema at ingestion (including older rows). IXB2 alone proves none of these.
// Represent missing or stale parts by null. Unresolved redirects can add
// witnesses, so a zero cannot prove absence while they remain.
export function presenceMasks(parts, sourceColumns, options) {
  const schema = options?.schema;
  if (options !== undefined) checkSchema(schema);
  if (!Array.isArray(sourceColumns) || Array.from(sourceColumns).some((c) => !Number.isInteger(c) || c < 0 || c >= 4096))
    throw new RangeError("presence columns must be IXB2 metric positions");
  if (new Set(sourceColumns).size !== sourceColumns.length)
    throw new RangeError("duplicate presence column");

  const bits = sourceColumns.map((_, i) => 1n << BigInt(i));
  let present = 0n;
  let absent = parts.length ? (1n << BigInt(bits.length)) - 1n : 0n;
  for (const part of parts) {
    if (part?.complete !== true || !part.response || (schema && !matchesSchema(part.schema, schema))) {
      absent = 0n;
      continue;
    }
    const { blocks, redirects, columns } = part.response;
    if (schema && columns == null && blocks.some(block => block.metricCount > schema.columns.length)) {
      // The unprojected payload contradicts the declared source layout.
      absent = 0n;
      continue;
    }
    // A projection may zero-fill source columns that do not exist. A
    // verified dictionary is needed to distinguish absence from padding.
    if (redirects.length || (!schema && (columns != null || !blocks.length))) absent = 0n;
    const positions = columns == null ? null : new Map(columns.map((source, i) => [source, i]));
    for (let i = 0; i < sourceColumns.length; i++) {
      const bit = bits[i];
      if (present & bit) continue;
      if (schema && schema.columns[sourceColumns[i]] == null) {
        absent &= ~bit;
        continue;
      }
      const column = positions ? positions.get(sourceColumns[i]) : sourceColumns[i];
      if (column === undefined) {
        absent &= ~bit;
        continue;
      }
      for (const block of blocks) {
        if (column >= block.metricCount) {
          absent &= ~bit;
          continue;
        }
        for (let row = 0; row < block.n; row++) {
          const value = block.metrics[column * block.n + row];
          if (value !== 0) absent &= ~bit;
          if (Number.isInteger(value) && value > 0) {
            present |= bit;
            break;
          }
        }
        if (present & bit) break;
      }
    }
  }
  return { present, absent };
}
