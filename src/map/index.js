export { default as AverageGridLayerWebGPU } from "./visualization/AverageGridLayerWebGPU.js";
export { detectWebGPU, webgpuSupport } from "../gpu/device.js";
export * from "./components/mapStyle.js";
export * from "./lib/heatmapConfig.js";
// Colour ramps (a d3 port): an app builds its palette with them.
export { rgbRamp } from "../utilities/colorRamp.js";
export { showWebGPUUnsupported, webgpuUnsupportedText } from "./visualization/unsupported.js";
export { createHeatmapPipeline } from "./heat/pipeline.js";
export { compose } from "./heat/compose.js";
