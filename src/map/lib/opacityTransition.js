// Retarget from the displayed opacity, so reversing a mode switch is continuous.
export class OpacityTransition {
  constructor(duration = 220) {
    this.duration = duration;
    this.from = this.to = 0;
    this.startedAt = 0;
  }
  value(now) {
    const t = Math.max(0, Math.min(1, (now - this.startedAt) / this.duration));
    const eased = t * t * (3 - 2 * t);
    return this.from + (this.to - this.from) * eased;
  }
  active(now) {
    return this.from !== this.to && now - this.startedAt < this.duration;
  }
  set(target, now) {
    if (target === this.to) return;
    this.from = this.value(now);
    this.to = target;
    this.startedAt = now;
  }
}
