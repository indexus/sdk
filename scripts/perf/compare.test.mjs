import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareResults, summarize, noiseBand } from "./compare.mjs";
import { metric, perfResult, median, dispersion } from "./result.mjs";

const run = (metrics) => perfResult({ suite: "test", env: { machine: "m" }, metrics });
const verdicts = (baseline, current, options) =>
  Object.fromEntries(
    compareResults(run(baseline), run(current), options).rows.map((row) => [row.name, row.verdict]),
  );

test("metric keeps the samples and summarises them by median and dispersion", () => {
  const entry = metric("decode", "ms", [10, 11, 9, 10, 30]);
  assert.equal(entry.value, 10);
  assert.deepEqual(entry.samples, [10, 11, 9, 10, 30]);
  // One outlier out of five does not widen a MAD-based spread.
  assert.ok(Math.abs(entry.noise - 14.826) < 1e-3, String(entry.noise));
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(dispersion([5, 6]), 0, "two samples: spread unknown");
  // Samples that jump between levels: the MAD alone would call them exact.
  const levels = [10250, 9040, 8250, 10250, 10250, 8650, 10250, 10250, 9050];
  assert.ok(dispersion(levels) > 5, String(dispersion(levels)));
  assert.deepEqual(metric("bytes", "B", 42), {
    name: "bytes",
    unit: "B",
    value: 42,
    better: "lower",
  });
});

test("a clear slowdown beyond threshold and noise is worse, a speed-up better", () => {
  const base = [metric("a", "ms", [100, 101, 99, 100, 100, 102])];
  assert.deepEqual(verdicts(base, [metric("a", "ms", [130, 131, 129, 130, 132, 130])]), {
    a: "pire",
  });
  assert.deepEqual(verdicts(base, [metric("a", "ms", [70, 71, 69, 70, 70, 72])]), { a: "mieux" });
  assert.deepEqual(verdicts(base, [metric("a", "ms", [105, 104, 106, 105, 105, 103])]), {
    a: "pareil",
  });
});

test("a change above the threshold but inside the measured noise stays the same", () => {
  const noisy = [60, 100, 140, 80, 120, 100];
  const base = [metric("a", "ms", noisy)];
  const current = [
    metric(
      "a",
      "ms",
      noisy.map((value) => value * 1.2),
    ),
  ];
  const [row] = compareResults(run(base), run(current), { threshold: 10 }).rows;
  assert.ok(row.delta > 10 && row.delta < row.band, JSON.stringify(row));
  assert.equal(row.verdict, "pareil");
});

test("the direction follows better, and the threshold is configurable", () => {
  const base = [metric("rate", "ops/s", [1000, 1001, 999], "higher")];
  assert.deepEqual(verdicts(base, [metric("rate", "ops/s", [800, 801, 799], "higher")]), {
    rate: "pire",
  });
  assert.deepEqual(verdicts(base, [metric("rate", "ops/s", [1200, 1201, 1199], "higher")]), {
    rate: "mieux",
  });
  const single = [metric("bytes", "B", 1000)];
  assert.deepEqual(verdicts(single, [metric("bytes", "B", 1080)]), { bytes: "pareil" });
  assert.deepEqual(verdicts(single, [metric("bytes", "B", 1080)], { threshold: 5 }), {
    bytes: "pire",
  });
});

test("one unit between two integers is rounding", () => {
  assert.deepEqual(
    verdicts(
      [metric("allocs", "allocs/op", [5, 5, 5])],
      [metric("allocs", "allocs/op", [6, 6, 6])],
    ),
    { allocs: "pareil" },
  );
  assert.deepEqual(
    verdicts(
      [metric("allocs", "allocs/op", [5, 5, 5])],
      [metric("allocs", "allocs/op", [7, 7, 7])],
    ),
    { allocs: "pire" },
  );
});

test("zero baselines, missing and new metrics", () => {
  const rows = compareResults(
    run([
      metric("allocs", "allocs/op", 0),
      metric("gone", "ms", 1),
      metric("still", "allocs/op", 0),
    ]),
    run([
      metric("allocs", "allocs/op", 3),
      metric("still", "allocs/op", 0),
      metric("added", "ms", 2),
    ]),
  ).rows;
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.name, row.verdict])), {
    allocs: "pire",
    gone: "absente",
    still: "pareil",
    added: "nouvelle",
  });
});

test("samples win over a stale value; noise without samples still widens the band", () => {
  assert.deepEqual(summarize({ value: 999, samples: [1, 2, 3] }).value, 2);
  const withNoise = summarize({ value: 10, noise: 20 });
  assert.deepEqual(withNoise, { value: 10, noise: 20, n: 1 });
  assert.ok(noiseBand(withNoise, withNoise) > 100);
  assert.throws(() => compareResults({ schema: "other", metrics: [] }, run([])), /baseline/);
});

test("the command exits 1 on a regression, 0 otherwise, 2 on bad input", () => {
  const dir = mkdtempSync(join(tmpdir(), "indexus-perf-"));
  const write = (name, metrics) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(run(metrics)));
    return file;
  };
  const script = fileURLToPath(new URL("./compare.mjs", import.meta.url));
  const base = write("base.json", [metric("a", "ms", [100, 100, 101, 99])]);
  const same = write("same.json", [metric("a", "ms", [101, 100, 102, 99])]);
  const slow = write("slow.json", [metric("a", "ms", [150, 150, 151, 149])]);
  const status = (...args) => {
    try {
      execFileSync(process.execPath, [script, ...args], { stdio: "pipe" });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(status(base, same), 0);
  assert.equal(status(base, slow), 1);
  assert.equal(status(base, slow, "--threshold", "60"), 0);
  assert.equal(status(base), 2);
  const output = execFileSync(process.execPath, [script, base, same]).toString();
  assert.match(output, /métrique.*référence.*actuel.*écart.*verdict/);
  assert.match(output, /^a\s+ms\s.*pareil$/m);
});
