// Builds scripts/gpu-check/dist/pack-check.html, the browser check of the
// pack kernel and the arena. Run: node scripts/gpu-check/build-pack-check.mjs
import { bundlePage } from "./bundle-page.mjs";

await bundlePage({ name: "pack-check", heading: "Indexus pack kernel check", iife: "packCheck" });
