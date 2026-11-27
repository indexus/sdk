// The frame: one command encoder and one queue.submit for everything the
// heat layers do in one turn of the event loop, whatever the number of
// collections and layers on the device (docs/compose.md). Owners add a
// recorder; the frame calls them in stage order (packs, then combines, then
// draws) and submits once.
//
// A recorder runs at submit time, so an owner that adds twice in a turn is
// encoded once, with its last recorder: a kernel may write its uniforms with
// queue.writeBuffer without two encodes sharing them.

/** Stages of a frame, in the order they are encoded. */
export const FRAME_PACK = 0;
export const FRAME_COMBINE = 1;
export const FRAME_DRAW = 2;

const STAGES = 3;
const frames = new WeakMap();

/** The frame of `device`: every heat layer of a device shares it. */
export function frameOf(device) {
  let frame = frames.get(device);
  if (!frame) {
    frame = createFrame(device);
    frames.set(device, frame);
  }
  return frame;
}

/**
 * @param {GPUDevice} device
 * @param {object} [options]
 * @param {(flush: () => void) => void} [options.defer] when a frame nobody
 *   submitted is flushed: by default at the end of the turn (a microtask)
 */
export function createFrame(device, { defer = queueMicrotask } = {}) {
  /** Per stage: owner → recorder, in the order of each owner's last add. */
  const stages = Array.from({ length: STAGES }, () => new Map());
  let after = [];
  let scheduled = false;

  const frame = {
    device,
    /** queue.submit calls made so far. */
    submits: 0,

    /**
     * `record(encoder)` is called once at the next submit. A second add by the
     * same owner in the same stage replaces the first and moves it last.
     */
    add(owner, record, stage = FRAME_PACK) {
      stages[stage].delete(owner);
      stages[stage].set(owner, record);
      schedule();
    },

    /** Whether `owner` has a recorder waiting in `stage`. */
    has(owner, stage = FRAME_PACK) {
      return stages[stage].has(owner);
    },

    /** Runs `callback` after the next submit: the place to destroy a replaced buffer. */
    after(callback) {
      after.push(callback);
      schedule();
    },

    /**
     * Encodes every recorder and submits once. A recorder that throws is
     * reported and skipped: it must not have opened a pass.
     * @returns {boolean} whether something was submitted
     */
    submit() {
      scheduled = false;
      const records = stages.flatMap((stage) => {
        const list = [...stage.values()];
        stage.clear();
        return list;
      });
      const done = after;
      after = [];
      if (records.length > 0) {
        const encoder = device.createCommandEncoder({ label: "frame" });
        for (const record of records) {
          try {
            record(encoder);
          } catch (error) {
            console.error("[indexus] frame: a recorder failed:", error);
          }
        }
        device.queue.submit([encoder.finish()]);
        frame.submits++;
      }
      for (const callback of done) callback();
      return records.length > 0;
    },
  };

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    defer(() => scheduled && frame.submit());
  }

  return frame;
}
