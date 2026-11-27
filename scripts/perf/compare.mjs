#!/usr/bin/env node
// Compares two indexus-perf/1 results metric by metric (docs/perf.md).
//
//   node scripts/perf/compare.mjs baseline.json current.json [--threshold 10]
//
// Exit 1 when a metric is worse by more than the threshold AND by more than
// its measured noise; 2 when the files cannot be compared. Node, no dependency.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SCHEMA, median, dispersion } from "./result.mjs";

/** Median, dispersion (%) and sample count of one metric of a result file. */
export function summarize(entry) {
  const samples = Array.isArray(entry.samples) && entry.samples.length ? entry.samples : null;
  if (!samples) return { value: entry.value, noise: entry.noise ?? 0, n: 1 };
  // Recomputed from the samples: they are the measure, value and noise a summary.
  return {
    value: median(samples),
    noise: dispersion(samples) || (entry.noise ?? 0),
    n: samples.length,
  };
}

// Standard error of a median, in % of it: 1.2533·σ/√n for roughly normal samples.
function medianError(side) {
  return (1.2533 * side.noise) / Math.sqrt(side.n);
}

/**
 * Noise band of a difference between two medians, in %: three standard
 * errors of that difference. A change inside the band is not distinguishable
 * from run-to-run variation, whatever its size.
 */
export function noiseBand(base, current) {
  return 3 * Math.hypot(medianError(base), medianError(current));
}

const key = (entry) => `${entry.name} [${entry.unit}]`;

/** Rows of the comparison and whether any metric got worse. */
export function compareResults(baseline, current, { threshold = 10 } = {}) {
  for (const [label, result] of [
    ["baseline", baseline],
    ["current", current],
  ]) {
    if (result?.schema !== SCHEMA || !Array.isArray(result.metrics)) {
      throw new Error(`${label}: not an ${SCHEMA} result`);
    }
  }
  const before = new Map(baseline.metrics.map((entry) => [key(entry), entry]));
  const after = new Map(current.metrics.map((entry) => [key(entry), entry]));
  const rows = [];
  for (const [id, entry] of before) {
    const name = entry.name;
    const next = after.get(id);
    if (!next) {
      rows.push({
        name,
        unit: entry.unit,
        base: summarize(entry),
        current: null,
        delta: null,
        band: null,
        verdict: "absente",
      });
      continue;
    }
    const base = summarize(entry);
    const now = summarize(next);
    const better = next.better ?? entry.better ?? "lower";
    let delta;
    if (base.value === now.value) {
      delta = 0;
    } else if (base.value === 0) {
      delta = Infinity * Math.sign(now.value);
    } else {
      delta = (100 * (now.value - base.value)) / Math.abs(base.value);
    }
    // Positive when the metric moved in its bad direction.
    const worse = better === "higher" ? -delta : delta;
    const band = noiseBand(base, now);
    // Go reports allocs/op as a truncated integer whose amortised part moves
    // with b.N: one unit between two integers is rounding, not a change.
    const rounding =
      Number.isInteger(base.value) &&
      Number.isInteger(now.value) &&
      Math.abs(now.value - base.value) <= 1;
    let verdict = "pareil";
    if (!rounding && worse > threshold && worse > band) verdict = "pire";
    else if (!rounding && -worse > threshold && -worse > band) verdict = "mieux";
    rows.push({ name, unit: entry.unit, base, current: now, delta, band, verdict });
  }
  for (const [id, entry] of after) {
    if (!before.has(id)) {
      rows.push({
        name: entry.name,
        unit: entry.unit,
        base: null,
        current: summarize(entry),
        delta: null,
        band: null,
        verdict: "nouvelle",
      });
    }
  }
  return { rows, regressed: rows.some((row) => row.verdict === "pire") };
}

function formatValue(side) {
  if (!side) return "—";
  const value = side.value;
  const text =
    Math.abs(value) >= 1e5 || (value !== 0 && Math.abs(value) < 1e-2)
      ? value.toExponential(3)
      : String(Number(value.toPrecision(4)));
  return side.noise ? `${text} ±${side.noise.toFixed(1)}%` : text;
}

function formatPercent(value) {
  if (value === null) return "—";
  if (!Number.isFinite(value)) return value > 0 ? "+∞" : "-∞";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function formatTable(rows) {
  const header = ["métrique", "unité", "référence", "actuel", "écart", "bruit", "verdict"];
  const lines = rows.map((row) => [
    row.name,
    row.unit,
    formatValue(row.base),
    formatValue(row.current),
    formatPercent(row.delta),
    row.band === null ? "—" : `±${row.band.toFixed(1)}%`,
    row.verdict,
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...lines.map((line) => line[i].length)),
  );
  const render = (cells) =>
    cells
      .map((cell, i) => (i >= 2 && i <= 5 ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [
    render(header),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...lines.map(render),
  ].join("\n");
}

function describe(result) {
  const env = result.env ?? {};
  const machine = [env.machine, env.os, env.cpu, env.runtime ?? env.browser, env.gpu]
    .filter(Boolean)
    .join(" · ");
  return `${result.suite} @ ${result.commit ?? "?"} (${result.branch ?? "?"}, ${result.date ?? "?"})${machine ? " — " + machine : ""}`;
}

function main(argv) {
  const files = [];
  let threshold = 10;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--threshold") threshold = Number(argv[++i]);
    else if (argv[i].startsWith("--threshold=")) threshold = Number(argv[i].slice(12));
    else files.push(argv[i]);
  }
  if (files.length !== 2 || !(threshold >= 0)) {
    console.error(
      "usage: node scripts/perf/compare.mjs baseline.json current.json [--threshold 10]",
    );
    return 2;
  }
  let baseline, current, comparison;
  try {
    [baseline, current] = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
    comparison = compareResults(baseline, current, { threshold });
  } catch (error) {
    console.error(String(error.message ?? error));
    return 2;
  }
  console.log(`référence : ${describe(baseline)}`);
  console.log(`actuel    : ${describe(current)}`);
  if (baseline.suite !== current.suite) console.log("ATTENTION : suites différentes.");
  const machine = (result) =>
    JSON.stringify([result.env?.machine, result.env?.cpu, result.env?.gpu]);
  if (machine(baseline) !== machine(current)) {
    console.log("ATTENTION : machines différentes, les temps ne sont pas comparables.");
  }
  console.log(
    `seuil ${threshold}% ; « pire » exige aussi un écart supérieur au bruit (3 erreurs types des médianes).\n`,
  );
  console.log(formatTable(comparison.rows));
  const count = (verdict) => comparison.rows.filter((row) => row.verdict === verdict).length;
  console.log(
    `\n${count("pire")} pire, ${count("mieux")} mieux, ${count("pareil")} pareil, ${count("absente")} absente(s), ${count("nouvelle")} nouvelle(s).`,
  );
  return comparison.regressed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
