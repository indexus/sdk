import resolve from "@rollup/plugin-node-resolve";

// Every dependency is ESM and src imports no JSON and no Node builtin: the
// resolver is the only plugin a build needs.
const plugins = () => [resolve({ browser: true, preferBuiltins: false })];

const banner = "/*! Indexus SDK | MPL-2.0 | https://github.com/indexus/sdk | See LICENSE and LICENSE-NOTICES.md */";

export default [
  // ES Module build
  {
    input: "src/index.js",
    output: {
      banner,
      file: "dist/js-indexus-sdk.esm.js",
      format: "esm",
    },
    plugins: plugins(),
  },
  // CommonJS build
  {
    input: "src/index.js",
    output: {
      banner,
      file: "dist/js-indexus-sdk.cjs",
      format: "cjs",
    },
    plugins: plugins(),
  },
  // UMD build for direct browser inclusion
  {
    input: "src/index.js",
    output: {
      banner,
      file: "dist/js-indexus-sdk.umd.js",
      format: "umd",
      name: "IndexusSDK",
      indent: false,
      plugins: [
        { name: "generated-whitespace", renderChunk: (code) => code.replace(/^[\t ]+$/gm, "") },
      ],
    },
    plugins: plugins(),
  },
];
