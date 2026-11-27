// A walk plan on the GPU (docs/heat-pipeline.md §c): the arena of a
// collection's blocks, the pack kernel that turns the plan on screen into the
// renderer's instances (alone, blended from the previous plan, or as a pair of
// snapshots), the field it publishes and the combine of a mix (docs/compose.md).
// map/heat/pipeline.js drives it: plans from the worker, fades and repaints.
//
// Everything is encoded into the device's frame (gpu/frame.js): the pack, then
// with `mix` the combine that joins other collections' fields into the
// instances.
import { ROOT } from "../tree/index.js";
import { createArena } from "./arena.js";
import { createPackKernel, createInstanceBuffer, INSTANCE_BYTES } from "./pack.js";
import { ENTRY_WORDS, FLAG_ENTER, FLAG_LEAVE } from "../walk/pack.js";
import { parentBounds, spaceTables } from "./cells.js";
import { frameOf, FRAME_PACK, FRAME_COMBINE } from "./frame.js";
import { createFieldBuffer, fieldLayout } from "./field.js";
import { createCombineKernel } from "./combine.js";

const EMPTY_PACKED = Object.freeze({ count: 0, gpuBuffer: null, version: 0, snapshotVersion: 0 });
/** Word of an entry's flags (walk/pack.js ENTRY_WORDS). */
const ENTRY_FLAGS = 5;

const pow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/** `current` if it holds `needed` bytes, else a new buffer; the old one goes after the frame. */
function grown(frame, current, needed, create) {
  if (current && current.size >= needed) return current;
  if (current) frame.after(() => current.destroy());
  return create();
}

/**
 * @param {object} options
 * @param {Space} options.space the collection's
 * @param {object} options.store the block store (get, entries) the arena mirrors
 * @param {number} options.budgetBytes the store's budget
 * @param {boolean} options.keyed write the plan's field (published, or read by a mix)
 * @param {object} [options.mix] `{others: [{source, missing}]}` (map/heat/pipeline.js)
 * @param {() => Promise<{device}|null>} options.gpu where a new device comes from after a loss
 * @param {() => void} options.onLost the device was lost (the packer is already reset)
 * @param {() => void} options.onPairReady the pair kernel is compiled: pack again and repaint
 * The rules (`heat`, `previousHeat`), `position` and the mix's `program` are
 * properties of the packer, read at each pack.
 */
export function createPlanPacker({
  space,
  store,
  budgetBytes,
  keyed,
  mix,
  gpu,
  onLost,
  onPairReady,
}) {
  const tables = spaceTables(space);
  const cellOf = (handle) => space.xyz(store.get(handle).parent || ROOT).coordinates;

  /**
   * {device, arena, kernel, combine, pairKernel} once a device is attached; null while there
   * is none. pairKernel packs the previous snapshot of a pair (its own uniform and plan).
   */
  let gpuState = null;
  let arena = null;
  let output = null;
  let pairOutput = null;
  /** The field of the plan on screen: its buffer, and whether the plan has cells. */
  let fieldBuffer = null;
  let fieldLive = false;
  const fieldSubscribers = new Set();
  /** Whether the instances hold a target alone (no fade pair). */
  let steady = true;
  /** Whether the instances hold a pair of snapshots (previousHeat), unmoved. */
  let pairShown = false;
  // The frame encodes one recorder per owner and stage.
  const packer = {};
  const mixer = {};
  /** The plan on screen: {plan, snapshotVersion, centerDepth, previousCenterDepth}. */
  let current = null;
  let waiting = null;
  let packed = EMPTY_PACKED;
  let version = 0;
  let destroyed = false;

  /** Every stored block the arena lacks (blocks that arrived without a device). */
  function syncArena() {
    for (const { handle, block } of store.entries()) {
      if (!arena.has(handle)) arena.put(handle, block, parentBounds(space, block.parent));
    }
  }

  async function attach(nextDevice) {
    if (destroyed || gpuState?.device === nextDevice) return;
    gpuState = null;
    output = null;
    pairOutput = null;
    fieldBuffer = null;
    // The store's budget bounds what the arena holds, but pins can keep the
    // store above it: the arena's own cap is only a safety net.
    if (arena) arena.rebuild(store, nextDevice);
    else arena = createArena(nextDevice, { budgetBytes: Math.max(2 * budgetBytes, 256 << 20) });
    syncArena();
    const [kernel, combine] = await Promise.all([
      createPackKernel(nextDevice),
      mix && createCombineKernel(nextDevice),
    ]);
    if (destroyed || arena.device !== nextDevice) return;
    syncArena(); // blocks that arrived while the kernels compiled
    gpuState = { device: nextDevice, arena, kernel, combine };
    nextDevice.lost?.then(() => {
      if (gpuState?.device !== nextDevice) return;
      onLost();
      gpu().then((context) => context && attach(context.device));
    });
    const plan = waiting ?? current;
    waiting = null;
    if (plan) draw(plan, null);
  }

  /** The device is gone: nothing is drawn until a new one is attached. */
  function lose() {
    gpuState = null;
    output = null;
    pairOutput = null;
    fieldBuffer = null;
    setField(false);
    if (current) waiting = current;
    packed = { ...EMPTY_PACKED, version: ++version };
  }

  function setField(live) {
    fieldLive = live;
    for (const subscriber of fieldSubscribers) subscriber();
  }

  /** An instance buffer of `buffer` or a new one, for `count` instances (powers of two). */
  const instancesFor = (frame, buffer, count) =>
    grown(frame, buffer, count * INSTANCE_BYTES, () =>
      createInstanceBuffer(gpuState.device, pow2(count)),
    );

  /** The field buffer for `capacity` cells, when this pipeline publishes one. */
  function growField(frame, capacity) {
    if (!keyed) return;
    fieldBuffer = grown(frame, fieldBuffer, fieldLayout(capacity).words * 4, () =>
      createFieldBuffer(gpuState.device, pow2(capacity)),
    );
  }

  /** The pack of `target` is recorded: it is the plan on screen, `count` instances. */
  function show(target, count, previousCenterDepth) {
    current = target;
    packed = {
      count,
      gpuBuffer: output,
      version: ++version,
      centerDepth: target.centerDepth,
      previousCenterDepth,
      snapshotVersion: target.snapshotVersion,
    };
    addCombine();
    if (keyed) setField(true);
  }

  /**
   * Packs `target.plan` into the instance buffer, blending from the plan on
   * screen when `blend` holds {previousEntries, motion}. The pack is encoded
   * when the device's frame is submitted: at the end of this turn at the latest.
   */
  function draw(target, blend) {
    const { device, kernel } = gpuState;
    const frame = frameOf(device);
    const { plan } = target;
    pairShown = false;
    if (plan.capacity === 0) {
      current = target;
      packed = { ...EMPTY_PACKED, version: ++version, snapshotVersion: target.snapshotVersion };
      setField(false);
      return;
    }
    if (!blend && self.previousHeat) {
      if (gpuState.pairKernel) return drawPair(target);
      preparePair(device);
    }
    // A pair is packed from the target on screen: that one goes to the GPU first.
    if (blend && frame.has(packer)) frame.submit();
    const previousCount = blend ? current.plan.capacity : 0;
    const instanceCount = plan.capacity + previousCount;
    const transition = blend && {
      previous: { buffer: output, count: previousCount },
      previousEntries: blend.previousEntries,
      previousDepth: blend.motion.previousDepth,
      currentDepth: blend.motion.currentDepth,
    };
    output = instancesFor(frame, output, instanceCount);
    growField(frame, plan.capacity);
    const job = {
      arena,
      tables,
      plan,
      heat: self.heat,
      position: self.position,
      output,
      transition,
      field: keyed ? { buffer: fieldBuffer, cellOf } : null,
    };
    frame.add(
      packer,
      (encoder) => {
        if (gpuState?.device === device) kernel.encode(encoder, job);
      },
      FRAME_PACK,
    );
    steady = !blend;
    show(target, instanceCount, blend ? target.previousCenterDepth : target.centerDepth);
  }

  function preparePair(device) {
    if (gpuState.pairPending) return;
    gpuState.pairPending = createPackKernel(device).then((pairKernel) => {
      if (gpuState?.device !== device) return pairKernel.destroy();
      gpuState.pairKernel = pairKernel;
      onPairReady();
    });
  }

  /**
   * Packs the plan twice in one recorder: `previousHeat` into pairOutput, then
   * `heat` with pairOutput as the previous half of a transition. The entries'
   * motion flags are cleared, so the two halves are the same cells, unmoved.
   */
  function drawPair(target) {
    const { device, kernel, pairKernel } = gpuState;
    const frame = frameOf(device);
    const { plan } = target;
    const capacity = plan.capacity;
    const entries = plan.entries.slice();
    for (let at = ENTRY_FLAGS; at < entries.length; at += ENTRY_WORDS) {
      entries[at] &= ~(FLAG_ENTER | FLAG_LEAVE);
    }
    const still = { ...plan, entries };
    pairOutput = instancesFor(frame, pairOutput, capacity);
    output = instancesFor(frame, output, 2 * capacity);
    growField(frame, capacity);
    const base = { arena, tables, plan: still, position: self.position };
    const previousJob = { ...base, heat: self.previousHeat, output: pairOutput, transition: null };
    const depths = { previousDepth: target.centerDepth, currentDepth: target.centerDepth };
    const job = {
      ...base,
      heat: self.heat,
      output,
      transition: {
        previous: { buffer: pairOutput, count: capacity },
        previousEntries: entries,
        ...depths,
      },
      field: keyed ? { buffer: fieldBuffer, cellOf } : null,
    };
    frame.add(
      packer,
      (encoder) => {
        if (gpuState?.device !== device) return;
        pairKernel.encode(encoder, previousJob);
        kernel.encode(encoder, job);
      },
      FRAME_PACK,
    );
    steady = false;
    pairShown = true;
    show(target, 2 * capacity, target.centerDepth);
  }

  /**
   * Writes the expression over the fields into the instances of the plan on
   * screen, after the packs of the frame. Run again whenever a field changes:
   * the pack's own values stay in this pipeline's field.
   */
  function addCombine() {
    if (!mix || !gpuState || !current?.plan.capacity) return;
    const { device } = gpuState;
    const capacity = current.plan.capacity;
    frameOf(device).add(
      mixer,
      (encoder) => {
        if (gpuState?.device !== device || !fieldBuffer) return;
        const others = mix.others.map(({ source, missing }) => ({
          buffer: source.device === device ? source.buffer : null,
          missing,
        }));
        gpuState.combine.encode(encoder, {
          program: self.program,
          fields: [{ buffer: fieldBuffer }, ...others],
          instances: output,
          capacity,
          steady,
        });
      },
      FRAME_COMBINE,
    );
  }

  const self = {
    heat: null,
    previousHeat: null,
    position: null,
    program: null,
    attach,
    lose,
    draw,
    /** Waits for a device: `target` is packed once one is attached. */
    wait(target) {
      waiting = target;
    },
    /** Packs the plan on screen again, alone. → whether there was one to pack. */
    redraw() {
      if (!gpuState || !current) return false;
      draw({ ...current, previousCenterDepth: current.centerDepth }, null);
      return true;
    },
    /** A field of the mix changed, or the expression: the same cells, new values. */
    recombine() {
      if (!gpuState || !current || current.plan.capacity === 0) return false;
      addCombine();
      packed = { ...packed, version: ++version };
      return true;
    },
    /** Stored blocks the arena takes as soon as it exists, kernels ready or not. */
    put(handles) {
      if (!arena) return;
      for (const handle of handles) {
        const block = store.get(handle);
        arena.put(handle, block, parentBounds(space, block.parent));
      }
    },
    drop(handles) {
      for (const handle of handles) arena?.drop(handle);
    },
    get ready() {
      return gpuState !== null;
    },
    get current() {
      return current;
    },
    get packed() {
      return packed;
    },
    get pairShown() {
      return pairShown;
    },
    get steady() {
      return steady;
    },
    get arena() {
      return arena;
    },
    get gpu() {
      return gpuState;
    },
    /** The field of the plan on screen, for another pipeline's mix. */
    field: {
      get buffer() {
        return fieldLive ? fieldBuffer : null;
      },
      get device() {
        return gpuState?.device ?? null;
      },
      subscribe(handler) {
        fieldSubscribers.add(handler);
        return () => fieldSubscribers.delete(handler);
      },
    },
    destroy() {
      destroyed = true;
      gpuState?.kernel.destroy();
      gpuState?.pairKernel?.destroy();
      gpuState?.combine?.destroy();
      gpuState = null;
      output?.destroy();
      pairOutput?.destroy();
      fieldBuffer?.destroy();
      fieldBuffer = null;
      setField(false);
      try {
        arena?.destroy();
      } catch {
        // A lost device may refuse destroy(); its buffers are gone anyway.
      }
    },
  };
  return self;
}
