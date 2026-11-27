// Generated colorRamp.d3.json, once, from d3 7.9.0 (d3-scale 4.0.3,
// d3-interpolate 3.0.2, d3-color 3.1.1) and the SDK's ramps as they were
// built with it. The SDK no longer depends on d3: rerun only with those
// versions installed beside it, never to make a test pass.
//
//   node src/utilities/testdata/colorRamp.d3.gen.mjs > src/utilities/testdata/colorRamp.d3.json
import { createHash } from "node:crypto";
import * as d3 from "d3";

// generateColorRampWgsl (shaders.js) as it was, on d3.color.
function rampWgsl(colors, colorInterpolation, color) {
  const stops = [];
  for (let i = 0; i < colors; i++) {
    const t = (i + 1) / colors;
    const c = color(colorInterpolation(t));
    stops.push([t, [c.r / 255, c.g / 255, c.b / 255]]);
  }
  const defs = stops
    .map(
      (e, i) =>
        `  let c${i} = vec3<f32>(${e[1][0].toFixed(6)}, ${e[1][1].toFixed(6)}, ${e[1][2].toFixed(6)});`,
    )
    .join("\n");
  const conditions = [];
  for (let i = 0; i < colors - 1; i++)
    conditions.push(`  if (t <= ${stops[i + 1][0].toFixed(6)}) { return c${i}; }`);
  return `fn interpolateColor(t: f32) -> vec3<f32> {\n${defs}\n${conditions.join("\n")}\n  return c${colors - 1};\n}`;
}

const SCALES = {
  white: d3
    .scaleLinear()
    .domain([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.65, 0.9])
    .range([
      "rgb(255,255,224)",
      "rgb(253,227,178)",
      "rgb(248,199,135)",
      "rgb(240,146,94)",
      "rgb(230,81,56)",
      "rgb(204,33,46)",
      "rgb(157,32,68)",
      "rgb(32,23,115)",
      "rgb(33,33,33)",
    ])
    .interpolate(d3.interpolateRgb),
  dark: d3
    .scaleLinear()
    .clamp(true)
    .domain([0.1, 0.125, 0.15, 0.175, 0.2, 0.225, 0.25, 0.3, 0.35, 0.4, 0.52, 0.68, 0.9])
    .range([
      "rgb(10, 14, 26)",
      "rgb(15, 19, 34)",
      "rgb(21, 25, 44)",
      "rgb(27, 29, 54)",
      "rgb(33, 33, 64)",
      "rgb(38, 36, 74)",
      "rgb(76, 44, 66)",
      "rgb(118, 50, 70)",
      "rgb(142, 54, 74)",
      "rgb(156, 62, 76)",
      "rgb(172, 88, 74)",
      "rgb(208, 188, 186)",
      "rgb(246, 245, 248)",
    ])
    .interpolate(d3.interpolateRgb),
};

// Numbers JSON cannot hold, tagged.
const enc = (v) =>
  v === undefined
    ? { $: "undefined" }
    : typeof v === "number" && (!Number.isFinite(v) || Object.is(v, -0))
      ? { $: String(Object.is(v, -0) ? "-0" : v) }
      : v;

// Inputs: a 1/200 grid over [-0.25, 1.25]; the samples the apps take (64
// over the domain for the dashboard's point stops, i / 24 for the realestate
// legend); every stop, its neighbours and midpoints; values that are not numbers.
function inputs(domain) {
  const xs = [];
  for (let i = -50; i <= 250; i++) xs.push(i / 200);
  const [start, end] = [domain[0], domain[domain.length - 1]];
  for (let i = 0; i < 64; i++) xs.push(start + (i / 63) * (end - start));
  for (let i = 0; i <= 24; i++) xs.push(i / 24);
  for (const d of domain) xs.push(d, d - 1e-9, d + 1e-9, d - 1e-15, d + 1e-15);
  for (let i = 0; i + 1 < domain.length; i++) xs.push((domain[i] + domain[i + 1]) / 2);
  return [
    ...xs,
    -1e9,
    1e9,
    0,
    -0,
    Infinity,
    -Infinity,
    NaN,
    null,
    undefined,
    "0.3",
    "",
    " ",
    "x",
    true,
    false,
    [0.5],
    [],
    {},
  ];
}

const COLORS = [
  "red",
  "RED",
  " Blue ",
  "rebeccapurple",
  "transparent",
  "constructor",
  "__proto__",
  "notacolor",
  "",
  "#f00",
  "#F00",
  "#ff0000",
  "#ff000080",
  "#f008",
  "#f000",
  "#ff000000",
  "#12",
  "#12345",
  "#1234567",
  "#ggg",
  "rgb(255,0,0)",
  "rgb( 255 , 0 , 0 )",
  "rgb(255, 0, 0)",
  "rgb(300,-20,0)",
  "rgb(10.5,0,0)",
  "rgb(+1,-0,0)",
  "rgb(100%,0%,50%)",
  "rgb(12.5%, 1e1%, .5%)",
  "rgb(100%,0,0)",
  "rgba(255,0,0,0.5)",
  "rgba(255,0,0,0)",
  "rgba(255,0,0,-1)",
  "rgba(255,0,0,2)",
  "rgba(255,0,0,1e-1)",
  "rgba(100%,0%,0%,0.25)",
  "hsl(120,50%,50%)",
  "hsl(-120,50%,50%)",
  "hsl(120,0%,50%)",
  "hsl(120,50%,0%)",
  "hsla(120,50%,50%,0.5)",
  "hsla(120,50%,50%,0)",
  "rgb(0, 0, 255)",
  "rgb(76,90,164)",
];
const encColor = (c) =>
  c === null ? null : Object.fromEntries(Object.entries({ ...c }).map(([k, v]) => [k, enc(v)]));

const sha = (s) => createHash("sha256").update(s).digest("hex");
const out = { generator: "d3 7.9.0", scales: {}, colors: [], ranges: {} };
for (const [name, scale] of Object.entries(SCALES)) {
  out.scales[name] = {
    domain: scale.domain(),
    range: scale.range(),
    clamp: scale.clamp(),
    samples: inputs(scale.domain()).map((x) => [enc(x), enc(scale(x))]),
  };
  // generateColorRampWgsl as it was (d3.color), every colour count 1..64.
  const wgsl = {};
  for (let n = 1; n <= 64; n++)
    wgsl[n] =
      n === 24 || n === 32 ? rampWgsl(n, scale, d3.color) : sha(rampWgsl(n, scale, d3.color));
  out.ranges[name] = wgsl;
}
out.colors = COLORS.map((s) => [s, encColor(d3.color(s))]);
process.stdout.write(JSON.stringify(out) + "\n");
