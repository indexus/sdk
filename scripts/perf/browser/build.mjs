// Builds scripts/perf/browser/dist/perf.html: one self-contained page (all
// JavaScript inlined, no import, no network) that runs the browser suite of
// docs/perf.md on the code of this checkout. Run: node scripts/perf/browser/build.mjs
// The page records the commit it was built from; rebuild before measuring.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "dist", "perf.html");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: here, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const commit = git(["rev-parse", "--short", "HEAD"]);
// Dirty means the measured code (src/) differs from the commit, not the scripts.
const dirty = git(["status", "--porcelain", "--untracked-files=no", "--", ":/src"]);
const build = {
  commit: commit && dirty ? `${commit}-dirty` : commit,
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  built: new Date().toISOString(),
};

const bundle = await rollup({
  input: join(here, "perf.page.mjs"),
  plugins: [resolve({ browser: true, preferBuiltins: false })],
});
const { output: chunks } = await bundle.generate({ format: "iife", name: "indexusPerf" });
await bundle.close();

// "</script" inside the bundle would close the inline script early.
const script = chunks[0].code.replaceAll("</script", "<\\/script");

const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>RUNNING</title>
<style>body{font:14px system-ui,sans-serif;margin:2em}pre{background:#f4f4f4;padding:1em;max-height:70vh;overflow:auto}</style>
</head>
<body>
<h1>Indexus — mesures GPU</h1>
<p>Build ${build.commit ?? "?"} (${build.branch ?? "?"}). Garder l’onglet au premier plan pendant la mesure. <span id="progress">…</span></p>
<p><button id="copy" type="button">Copier</button></p>
<pre id="result">mesure en cours…</pre>
<script>var __PERF_BUILD__ = ${JSON.stringify(build)};</script>
<script>
${script}
</script>
</body>
</html>
`;

await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(`${output} (${html.length} bytes)`);
