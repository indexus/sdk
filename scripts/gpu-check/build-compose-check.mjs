// Builds scripts/gpu-check/dist/compose-check.html, the browser check and
// bench of the GPU composition. Run: node scripts/gpu-check/build-compose-check.mjs
import { bundlePage } from "./bundle-page.mjs";

await bundlePage({
  name: "compose-check",
  heading: "Indexus compose check",
  iife: "composeCheck",
});
