// MapLibre style helpers used during map setup.
//
// Why this exists: the MapTiler "backdrop" style auto-enables terrain on
// MapLibre v5+, which switches the renderer to a 3D draped pipeline that
// silently breaks 2d custom layers using the WebGPU texture-handoff
// pattern. We have to opt out explicitly *and* tear down the dependent
// hillshade layers + raster-DEM sources, otherwise MapLibre keeps loading
// DEM tiles in the background and re-applies terrain on style mutations.

// Disable terrain rendering on `map` and remove every hillshade layer +
// raster-DEM source declared by the active style. Each step is wrapped in
// its own try/catch so a partial style — e.g. a layer that's already been
// removed, or a source another layer still references — never aborts the
// rest of the cleanup.
export function disableTerrain(map) {
  try {
    map.setTerrain(null);
  } catch (_) {}

  let style;
  try {
    style = map.getStyle?.();
  } catch (_) {
    return;
  }
  if (!style) return;

  const layers = style.layers || [];
  for (const layer of layers) {
    if (layer && layer.type === "hillshade") {
      try {
        map.removeLayer(layer.id);
      } catch (_) {}
    }
  }

  const sources = style.sources || {};
  for (const [id, src] of Object.entries(sources)) {
    if (src && (src.type === "raster-dem" || src.type === "dem")) {
      try {
        map.removeSource(id);
      } catch (_) {
        // Some other layer still references this source; harmless.
      }
    }
  }
}

/**
 * Sets `properties` ([name, value] pairs, in order) on each layer of `ids`
 * that `map` has. A layer that throws is left as it is; the others are still
 * set.
 */
function paint(map, ids, properties) {
  if (!map || typeof map.getLayer !== "function") return;
  for (const id of ids) {
    try {
      if (!map.getLayer(id)) continue;
      for (const [name, value] of properties) map.setPaintProperty(id, name, value);
    } catch (_) {}
  }
}

/**
 * Settlement labels (villes): white type, black halo kept low for a thin crisp
 * rim (blur stays 0), for contrast on any land tint.
 */
const WHITE_LABEL = [
  ["text-color", "#ffffff"],
  ["text-halo-color", "#000000"],
  ["text-halo-width", 1],
  ["text-halo-blur", 0],
];

export function brightenDatavizDarkSettlementLabels(map) {
  paint(map, ["City labels", "Town labels", "Village labels", "Place labels"], WHITE_LABEL);
}

/** Couleur du fond carte + masses d'eau : eau en bleu‑gris plus clair et désaturé. */
export function tuneDatavizDarkBackgroundAndWater(map) {
  paint(map, ["Background"], [["background-color", "hsl(222, 14%, 13%)"]]);
  paint(map, ["Water"], [["fill-color", "hsl(218, 10%, 27%)"]]);
  paint(map, ["Water shadow"], [["fill-color", "hsl(219, 10%, 11%)"]]);
  paint(map, ["River"], [["line-color", "hsl(217, 8%, 42%)"]]);
}
