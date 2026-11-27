import { checkRead, canceledRead } from "../utilities/sharedRead.js";

export class Throttler {
  constructor(poolLimit) {
    this.poolLimit = poolLimit;
    this.activeCount = 0;
    this.queue = [];
    this.taskMap = new Map();
  }

  enqueue(key, taskFn, { signal } = {}) {
    try {
      checkRead(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.taskMap.has(key)) return this.taskMap.get(key);

    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.taskMap.set(key, promise);
    const entry = {
      run: async () => {
        signal?.removeEventListener("abort", abort);
        this.activeCount++;
        try {
          checkRead(signal);
          resolve(await taskFn());
        } catch (error) {
          reject(error);
        } finally {
          this.activeCount--;
          this.taskMap.delete(key);
          this.queue.shift()?.run();
        }
      },
      cancel: () => {
        signal?.removeEventListener("abort", abort);
        this.taskMap.delete(key);
        reject(canceledRead());
      },
    };
    const abort = () => {
      const index = this.queue.indexOf(entry);
      if (index < 0) return;
      this.queue.splice(index, 1);
      this.taskMap.delete(key);
      signal.removeEventListener("abort", abort);
      reject(canceledRead(signal));
    };

    if (this.activeCount < this.poolLimit) {
      entry.run();
    } else {
      this.queue.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
    }
    return promise;
  }

  clearQueue() {
    for (const entry of this.queue.splice(0)) entry.cancel();
  }

  getStatus() {
    return { active: this.activeCount, queued: this.queue.length };
  }
}
