// Bundles one check page into dist/<name>.html: one self-contained page (all
// JavaScript inlined, no import, no network) for a browser with WebGPU.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";

const here = dirname(fileURLToPath(import.meta.url));

export async function bundlePage({ name, heading, iife }) {
  const output = join(here, "dist", `${name}.html`);
  const bundle = await rollup({
    input: join(here, `${name}.page.mjs`),
    plugins: [resolve({ browser: true, preferBuiltins: false })],
  });
  const { output: chunks } = await bundle.generate({ format: "iife", name: iife });
  await bundle.close();

  // "</script" inside the bundle would close the inline script early.
  const script = chunks[0].code.replaceAll("</script", "<\\/script");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>RUNNING</title>
</head>
<body>
<h1>${heading}</h1>
<pre id="result">running…</pre>
<script>
${script}
</script>
</body>
</html>
`;

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
  console.log(`${output} (${html.length} bytes)`);
}
