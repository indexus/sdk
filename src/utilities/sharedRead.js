export function canceledRead(signal) {
  if (signal?.reason?.code === "ETIMEDOUT") return signal.reason;
  return Object.assign(new Error("Read canceled"), { name: "AbortError", code: "ERR_CANCELED" });
}

export function checkRead(signal) {
  if (signal?.aborted) throw canceledRead(signal);
}

// One operation, independent consumers. Aborting a consumer only closes the
// transport when no remaining consumer needs it. The deadline includes queueing.
export class SharedRead {
  constructor(operation, timeoutMs = 15000) {
    this.controller = new AbortController();
    this.users = 0;
    this.done = false;
    timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
    const timer = setTimeout(
      () =>
        this.controller.abort(
          Object.assign(new Error("Read deadline exceeded"), {
            name: "TimeoutError",
            code: "ETIMEDOUT",
          }),
        ),
      timeoutMs,
    );
    this.promise = Promise.resolve().then(() => {
      checkRead(this.controller.signal);
      return operation(this.controller.signal);
    });
    const finish = () => {
      this.done = true;
      clearTimeout(timer);
    };
    this.promise.then(finish, finish);
    this.controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }

  join(signal) {
    this.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const release = (error, value, failed) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        this.controller.signal.removeEventListener("abort", operationAborted);
        this.users--;
        if (!this.users && !this.done) this.controller.abort();
        if (failed) reject(error);
        else resolve(value);
      };
      const abort = () => release(canceledRead(signal), undefined, true);
      const operationAborted = () => release(canceledRead(this.controller.signal), undefined, true);
      signal?.addEventListener("abort", abort, { once: true });
      this.controller.signal.addEventListener("abort", operationAborted, { once: true });
      this.promise.then(
        (value) => release(null, value, false),
        (error) => release(error, undefined, true),
      );
      if (signal?.aborted) abort();
      else if (this.controller.signal.aborted) operationAborted();
    });
  }
}
