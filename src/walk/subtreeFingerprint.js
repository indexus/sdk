const algorithm = "sha256-add256-v1";
const maxCount = (1n << 64n) - 1n;

// Fold raw content summaries from known disjoint observations. Coverage,
// authority and the read guard remain properties of each individual probe.
export function mergeSubtreeFingerprints(parts) {
  let sum = 0n;
  let count = 0n;
  for (const part of parts) {
    if (part?.algorithm !== algorithm || typeof part.sum !== "string" ||
        part.sum.length !== 64 || /[^a-f0-9]/.test(part.sum) ||
        typeof part.count !== "string" || !part.count.length || part.count.length > 20 ||
        /[^0-9]/.test(part.count) || (part.count.length > 1 && part.count[0] === "0")) {
      throw new TypeError("Expected a sha256-add256-v1 content summary");
    }
    const term = BigInt("0x" + part.sum);
    if (part.count === "0" && term !== 0n) throw new TypeError("Expected the empty subtree sum");
    count += BigInt(part.count);
    if (count > maxCount) throw new RangeError("Subtree record count overflow");
    sum = BigInt.asUintN(256, sum + term);
  }
  return {algorithm, sum: sum.toString(16).padStart(64, "0"), count: count.toString()};
}
