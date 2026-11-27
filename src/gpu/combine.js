// Combine kernel: one expression over up to four fields, evaluated per cell
// on the GPU, written into the first field's instances (docs/compose.md).
// Nothing is read back.
//
// The first field gives the cells that are drawn. For each of its outputs the
// kernel finds, in every other field, the row of the same Cell (gpu/field.js)
// or else of the nearest cell that encloses it, and takes num / den as the
// field's value there. A field with no such cell is missing: its `missing`
// number stands in, or without one the cell is not drawn. A cell only another
// field has is not drawn either.
//
// The expression is compiled once on the CPU to a short postfix program that
// the kernel interprets, so a new expression is a new uniform, not a new
// shader. evaluate() runs the same program in JS.
import { bufferUsage, compileShader } from "./device.js";
import { FIELD_HEADER_WORDS, FIELD_ROW_WORDS, cellHashWGSL, indexDispatch } from "./field.js";
import { INSTANCE_FLOATS } from "./pack.js";

export const MAX_FIELDS = 4;
export const MAX_OPS = 24;
const MAX_STACK = 8;
export const COMBINE_UNIFORM_BYTES = MAX_OPS * 8 + 48;

const LANES = 64;
const MAX_GROUPS = 65535;
// What a missing field does to a cell.
const MISSING_DROPS = 1;
const MISSING_STANDS_IN = 2;

const PUSH = 0;
const FIELD = 1;
// name → [code, arguments]
const OPERATORS = { "+": [2, 2], "-": [3, 2], "*": [4, 2], "/": [5, 2] };
const NEGATE = 8;
const FUNCTIONS = {
  min: [6, 2],
  max: [7, 2],
  abs: [9, 1],
  log1p: [10, 1],
  clamp: [11, 3],
  ramp: [12, 3],
};

/**
 * Compiles an expression over named fields to a postfix program.
 *
 * Grammar: numbers, field names, `+ - * /`, unary `-`, parentheses and
 * `min(x, y)`, `max(x, y)`, `abs(x)`, `log1p(x)`, `clamp(x, lo, hi)`,
 * `ramp(x, from, to)` (0 at `from`, 1 at `to`, straight in between; `from`
 * may be above `to`). Every operation is total: x / 0 is 0, log1p of a
 * negative is 0.
 *
 * @param {string} text e.g. "price * ramp(heat, 35, 15) * (1 - canopy)"
 * @param {string[]} names field names, in field order
 * @returns {{ops: Uint32Array, count: number}} 2 words per op: code, argument
 */
export function compileExpression(text, names) {
  const tokens = String(text).match(/\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|[A-Za-z_]\w*|\S)/g) ?? [];
  const program = [];
  let at = 0;
  let depth = 0;

  const peek = () => tokens[at]?.trim();
  const fail = (message) => {
    throw new SyntaxError(`combine: ${message} in "${text}"`);
  };
  const expect = (token) => {
    if (peek() !== token) fail(`"${token}" expected, got "${peek() ?? "the end"}"`);
    at++;
  };
  const emit = (code, argument, pushes) => {
    program.push(code, argument);
    depth += pushes;
    if (program.length / 2 > MAX_OPS) fail(`more than ${MAX_OPS} operations`);
    if (depth > MAX_STACK) fail(`more than ${MAX_STACK} values at once`);
  };
  const number = (value) => emit(PUSH, new Uint32Array(Float32Array.of(value).buffer)[0], 1);

  function sum() {
    product();
    while (peek() === "+" || peek() === "-") {
      const [code] = OPERATORS[tokens[at++].trim()];
      product();
      emit(code, 0, -1);
    }
  }

  function product() {
    unary();
    while (peek() === "*" || peek() === "/") {
      const [code] = OPERATORS[tokens[at++].trim()];
      unary();
      emit(code, 0, -1);
    }
  }

  function unary() {
    if (peek() === "-") {
      at++;
      unary();
      emit(NEGATE, 0, 0);
      return;
    }
    const token = peek();
    if (token === undefined) fail("an operand is missing");
    at++;
    if (token === "(") {
      sum();
      expect(")");
    } else if (/^[\d.]/.test(token)) {
      number(Number(token));
    } else if (peek() === "(") {
      call(token);
    } else if (names.includes(token)) {
      emit(FIELD, names.indexOf(token), 1);
    } else {
      fail(`"${token}" is not a field (${names.join(", ")})`);
    }
  }

  function call(name) {
    if (!Object.hasOwn(FUNCTIONS, name)) fail(`"${name}" is not a function`);
    const [code, count] = FUNCTIONS[name];
    expect("(");
    for (let i = 0; i < count; i++) {
      if (i > 0) expect(",");
      sum();
    }
    expect(")");
    emit(code, 0, 1 - count);
  }

  sum();
  if (at < tokens.length) fail(`"${peek()}" is not expected`);
  return { ops: Uint32Array.from(program), count: program.length / 2 };
}

const divide = (a, b, round) => (b === 0 ? 0 : round(a / b));

/**
 * Runs a compiled program as the kernel does. `round` is Math.fround for the
 * float32 emulation and identity for a float64 reference.
 * @param {ArrayLike<number>} values one per field
 */
export function evaluate({ ops, count }, values, round = Math.fround) {
  const stack = new Float64Array(MAX_STACK);
  const constant = new Float32Array(1);
  const bits = new Uint32Array(constant.buffer);
  let top = 0;
  for (let i = 0; i < count; i++) {
    const code = ops[2 * i];
    if (code === PUSH) {
      bits[0] = ops[2 * i + 1];
      stack[top++] = constant[0];
      continue;
    }
    if (code === FIELD) {
      stack[top++] = round(values[ops[2 * i + 1]]);
      continue;
    }
    const a = stack[top - 1];
    const b = stack[top - 2];
    const c = stack[top - 3];
    switch (code) {
      case 2:
        stack[--top - 1] = round(b + a);
        break;
      case 3:
        stack[--top - 1] = round(b - a);
        break;
      case 4:
        stack[--top - 1] = round(b * a);
        break;
      case 5:
        stack[--top - 1] = divide(b, a, round);
        break;
      case 6:
        stack[--top - 1] = Math.min(b, a);
        break;
      case 7:
        stack[--top - 1] = Math.max(b, a);
        break;
      case NEGATE:
        stack[top - 1] = -a;
        break;
      case 9:
        stack[top - 1] = Math.abs(a);
        break;
      case 10:
        stack[top - 1] = round(Math.log(round(1 + Math.max(a, 0))));
        break;
      case 11:
        top -= 2;
        stack[top - 1] = Math.min(Math.max(c, b), a);
        break;
      case 12:
        top -= 2;
        stack[top - 1] = Math.min(Math.max(divide(round(c - b), round(a - b), round), 0), 1);
        break;
      default:
        throw new RangeError(`combine: unknown operation ${code}`);
    }
  }
  return stack[0];
}

/**
 * The uniform of one combine.
 * @param job.program   compileExpression(...)
 * @param job.fields    per field, first included: {missing?: number}; a field
 *   without `missing` drops the cells it lacks
 * @param job.capacity  outputs of the first field
 * @param job.steady    the target is not in a transition: the instances'
 *   previous values follow the current ones
 */
export function prepareCombine({ program, fields, capacity, steady }) {
  if (fields.length < 1 || fields.length > MAX_FIELDS) {
    throw new RangeError(`combine: 1 to ${MAX_FIELDS} fields, got ${fields.length}`);
  }
  const uniform = new ArrayBuffer(COMBINE_UNIFORM_BYTES);
  const u32 = new Uint32Array(uniform);
  const f32 = new Float32Array(uniform);
  u32.set(program.ops);
  const at = MAX_OPS * 2;
  fields.forEach((field, k) => {
    const stands = Number.isFinite(field.missing);
    f32[at + k] = stands ? field.missing : 0;
    u32[at + 4 + k] = stands ? MISSING_STANDS_IN : MISSING_DROPS;
  });
  u32.set([program.count, capacity, steady ? 1 : 0, fields.length], at + 8);
  return uniform;
}

function lookupWGSL(k) {
  return /* wgsl */ `
// Row + 1 of the Cell in field ${k}, or 0. A Cell may have several rows (one
// per tier that draws it), with the same sums: the last one is kept, so the
// answer does not depend on where indexField put them.
fn find${k}(cell: vec3u, resolution: u32) -> u32 {
  let size = field${k}[0];
  var slot = cellHash(cell, resolution) & (size - 1u);
  var best = 0u;
  for (var turn = 0u; turn < size; turn++) {
    let owner = field${k}[${FIELD_HEADER_WORDS}u + slot];
    if (owner == 0u) {
      break;
    }
    let row = ${FIELD_HEADER_WORDS}u + size + (owner - 1u) * ${FIELD_ROW_WORDS}u;
    if (field${k}[row] == cell.x && field${k}[row + 1u] == cell.y && field${k}[row + 2u] == cell.z &&
        field${k}[row + 3u] == resolution + 1u) {
      best = max(best, owner);
    }
    slot = (slot + 1u) & (size - 1u);
  }
  return best;
}

// (value, 1) of field ${k} at the cell, or at the nearest cell that encloses
// it and has a value; (0, 0) when there is none.
fn value${k}(first: vec3u, firstResolution: u32) -> vec2f {
  let size = field${k}[0];
  let coarsest = field${k}[2];
  if (size == 0u || firstResolution < coarsest) {
    return vec2f(0.0, 0.0);
  }
  var cell = first;
  for (var resolution = firstResolution; ; resolution--) {
    let owner = find${k}(cell, resolution);
    if (owner != 0u) {
      let row = ${FIELD_HEADER_WORDS}u + size + (owner - 1u) * ${FIELD_ROW_WORDS}u;
      let den = bitcast<f32>(field${k}[row + 5u]);
      if (den > 0.0) {
        return vec2f(bitcast<f32>(field${k}[row + 4u]) / den, 1.0);
      }
    }
    if (resolution == coarsest) {
      break;
    }
    cell = cell >> vec3u(1u);
  }
  return vec2f(0.0, 0.0);
}
`;
}

export const combineShader = /* wgsl */ `
struct Params {
  program: array<vec4u, ${MAX_OPS / 2}>,
  missing: vec4f,
  whenMissing: vec4u,
  opCount: u32,
  capacity: u32,
  steady: u32,
  fieldCount: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> instances: array<f32>;
@group(0) @binding(2) var<storage, read> field0: array<u32>;
@group(0) @binding(3) var<storage, read> field1: array<u32>;
@group(0) @binding(4) var<storage, read> field2: array<u32>;
@group(0) @binding(5) var<storage, read> field3: array<u32>;

${cellHashWGSL}
${lookupWGSL(1)}
${lookupWGSL(2)}
${lookupWGSL(3)}

fn divide(a: f32, b: f32) -> f32 {
  if (b == 0.0) {
    return 0.0;
  }
  return a / b;
}

// The postfix program of compileExpression, which bounds its length and its
// stack.
fn evaluate(values: vec4f) -> f32 {
  var stack: array<f32, ${MAX_STACK}>;
  var top = 0u;
  for (var i = 0u; i < params.opCount; i++) {
    let pair = params.program[i >> 1u];
    var code = pair.x;
    var argument = pair.y;
    if ((i & 1u) == 1u) {
      code = pair.z;
      argument = pair.w;
    }
    if (code == ${PUSH}u) {
      stack[top] = bitcast<f32>(argument);
      top++;
      continue;
    }
    if (code == ${FIELD}u) {
      stack[top] = values[argument];
      top++;
      continue;
    }
    // Up to three operands; the indices stay in the stack for shorter operations.
    let a = stack[top - 1u];
    let b = stack[max(top, 2u) - 2u];
    let c = stack[max(top, 3u) - 3u];
    switch code {
      case 2u: {
        top--;
        stack[top - 1u] = b + a;
      }
      case 3u: {
        top--;
        stack[top - 1u] = b - a;
      }
      case 4u: {
        top--;
        stack[top - 1u] = b * a;
      }
      case 5u: {
        top--;
        stack[top - 1u] = divide(b, a);
      }
      case 6u: {
        top--;
        stack[top - 1u] = min(b, a);
      }
      case 7u: {
        top--;
        stack[top - 1u] = max(b, a);
      }
      case ${NEGATE}u: {
        stack[top - 1u] = -a;
      }
      case 9u: {
        stack[top - 1u] = abs(a);
      }
      case 10u: {
        stack[top - 1u] = log(1.0 + max(a, 0.0));
      }
      case 11u: {
        top -= 2u;
        stack[top - 1u] = min(max(c, b), a);
      }
      case 12u: {
        top -= 2u;
        stack[top - 1u] = min(max(divide(c - b, a - b), 0.0), 1.0);
      }
      default: {
      }
    }
  }
  return stack[0];
}

@compute @workgroup_size(${LANES})
fn combine(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let index = (group.y * ${MAX_GROUPS}u + group.x) * ${LANES}u + lid.x;
  if (index >= params.capacity) {
    return;
  }
  let row = ${FIELD_HEADER_WORDS}u + field0[0] + index * ${FIELD_ROW_WORDS}u;
  if (field0[row + 3u] == 0u) {
    return;
  }
  let cell = vec3u(field0[row], field0[row + 1u], field0[row + 2u]);
  let resolution = field0[row + 3u] - 1u;
  let den = bitcast<f32>(field0[row + 5u]);
  var drawn = den > 0.0;
  var values = vec4f(divide(bitcast<f32>(field0[row + 4u]), den), 0.0, 0.0, 0.0);
  for (var k = 1u; k < params.fieldCount; k++) {
    var found = vec2f(0.0, 0.0);
    if (k == 1u) {
      found = value1(cell, resolution);
    } else if (k == 2u) {
      found = value2(cell, resolution);
    } else {
      found = value3(cell, resolution);
    }
    if (found.y == 0.0) {
      found.x = params.missing[k];
      drawn = drawn && params.whenMissing[k] == ${MISSING_STANDS_IN}u;
    }
    values[k] = found.x;
  }
  var num = 0.0;
  var weight = 0.0;
  if (drawn) {
    // The renderer averages num / den weighted by den: the first field keeps its weight.
    weight = den;
    num = max(evaluate(values), 0.0) * den;
  }
  let o = index * ${INSTANCE_FLOATS}u;
  instances[o + 8u] = num;
  instances[o + 9u] = weight;
  if (params.steady == 1u) {
    instances[o + 12u] = num;
    instances[o + 13u] = weight;
  }
}
`;

/**
 * Compiles the combine kernel on `device`.
 * @returns {Promise<{encode: Function, destroy: Function}>}
 */
export async function createCombineKernel(device) {
  const module = await compileShader(device, "combine", combineShader);
  const pipeline = await device.createComputePipelineAsync({
    label: "combine",
    layout: "auto",
    compute: { module, entryPoint: "combine" },
  });
  const uniform = device.createBuffer({
    label: "combine-params",
    size: COMBINE_UNIFORM_BYTES,
    usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST,
  });
  // Bound in place of a field that has nothing yet: its table size is 0.
  const none = device.createBuffer({
    label: "combine-no-field",
    size: FIELD_HEADER_WORDS * 4,
    usage: bufferUsage.STORAGE | bufferUsage.COPY_DST,
  });

  /**
   * Encodes one combine into `encoder`; one per submit (the uniform is written
   * with queue.writeBuffer).
   *
   * @param request.program   compileExpression(...)
   * @param request.fields    1 to 4 `{buffer, missing?}`; the first is the field of
   *   `instances`; a null buffer is a field with no cell yet
   * @param request.instances the first field's instance buffer, packed in this
   *   submit or an earlier one
   * @param request.capacity  outputs of the first field
   * @param request.steady    see prepareCombine
   */
  function encode(encoder, { program, fields, instances, capacity, steady }) {
    if (capacity === 0) return;
    device.queue.writeBuffer(uniform, 0, prepareCombine({ program, fields, capacity, steady }));
    const buffers = Array.from({ length: MAX_FIELDS }, (_, k) => fields[k]?.buffer ?? none);
    const pass = encoder.beginComputePass({ label: "combine" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        label: "combine",
        layout: pipeline.getBindGroupLayout(0),
        entries: [uniform, instances, ...buffers].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      }),
    );
    pass.dispatchWorkgroups(...indexDispatch(capacity));
    pass.end();
  }

  function destroy() {
    uniform.destroy();
    none.destroy();
  }

  return { encode, destroy };
}
