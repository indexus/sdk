// compose: several collections on one map layer, combined on the GPU before
// display (docs/compose.md). Each field is a heat pipeline (worker, store,
// arena, pack); the first one gives the cells that are drawn and the
// expression gives their value from every field at that cell.
//
//   compose({
//     fields: [
//       { name: "price", worker, collection, rules },
//       { name: "canopy", worker, collection, rules, missing: 0 },
//     ],
//     expression: "price * (1 - canopy)",
//   })
//
// One field and no expression is the plain heatmap: the same pipeline, with
// no combine stage.
import { MAX_FIELDS } from "../../gpu/combine.js";
import { createHeatmapPipeline } from "./pipeline.js";

const NAME = /^[A-Za-z_]\w*$/;

// Fields join on cell keys: the collections must cut space the same way.
function spaceOf({ collection }) {
  return JSON.stringify(collection.dimensions.map(({ type, args }) => [type, args]));
}

/**
 * @param {object} options
 * @param {Array<object>} options.fields 1 to 4 fields. Each one is
 *   `{name, worker, collection, rules, missing?, init?}` plus any option of
 *   createHeatmapPipeline for that collection alone. `rules` are heat rules
 *   (gpu/pack.js normalizeHeat): a field's value at a cell is their num / den.
 *   `missing` is the value of a field where it has no cell; without it such
 *   cells are not drawn. `init` is merged into that field's INIT payload.
 * @param {string} [options.expression] over the field names (gpu/combine.js
 *   compileExpression); default: the first field
 * Every other option goes to each pipeline (device, budgetBytes, …).
 * @returns the first field's pipeline (controller, search, registerRepaint, …)
 *   whose init, move, deviceLost, restore and destroy reach every field, plus `fields` (pipeline by
 *   name) and `setExpression(text)`
 */
export function compose({ fields, expression = null, ...shared }) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_FIELDS) {
    throw new RangeError(`compose: 1 to ${MAX_FIELDS} fields`);
  }
  const names = fields.map((field) => field.name);
  if (!names.every((name) => NAME.test(name)) || new Set(names).size !== names.length) {
    throw new RangeError(`compose: field names must be distinct words, got ${names.join(", ")}`);
  }
  if (fields.some((field) => spaceOf(field) !== spaceOf(fields[0]))) {
    throw new RangeError("compose: the collections of the fields must share their dimensions");
  }

  const pipelineOf = ({ name, rules, missing, init, ...own }, extra) =>
    createHeatmapPipeline({ ...shared, ...own, heat: rules, ...extra });
  const others = fields.slice(1).map((field) => pipelineOf(field, { field: true }));
  const mixed = expression !== null || others.length > 0;
  const mix = mixed && {
    name: names[0],
    others: others.map((pipeline, i) => ({
      name: names[i + 1],
      source: pipeline.field,
      missing: fields[i + 1].missing,
    })),
    expression: expression ?? names[0],
  };
  const first = pipelineOf(fields[0], { mix: mix || null });
  const pipelines = [first, ...others];

  // The first pipeline, with the calls that concern every field redirected.
  return Object.assign(Object.create(first), {
    fields: Object.fromEntries(pipelines.map((pipeline, i) => [names[i], pipeline])),
    init(payload) {
      pipelines.forEach((pipeline, i) => pipeline.init({ ...payload, ...fields[i].init }));
    },
    move(view) {
      for (const pipeline of pipelines) pipeline.move(view);
    },
    setExpression(text) {
      first.controller.setExpression(text);
    },
    deviceLost() {
      for (const pipeline of pipelines) pipeline.deviceLost();
    },
    restore(device) {
      return Promise.all(pipelines.map((pipeline) => pipeline.restore(device)));
    },
    destroy() {
      for (const pipeline of pipelines) pipeline.destroy();
    },
  });
}
