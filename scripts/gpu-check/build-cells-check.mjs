// Builds scripts/gpu-check/dist/cells-check.html, the browser check of the
// cells kernel. Run: node scripts/gpu-check/build-cells-check.mjs
import { bundlePage } from "./bundle-page.mjs";

await bundlePage({
  name: "cells-check",
  heading: "Indexus cells kernel check",
  iife: "cellsCheck",
});
