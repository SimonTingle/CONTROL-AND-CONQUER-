const WINDOW_SIZE = 120;

/**
 * Lightweight per-system timing breakdown for the main tick loop.
 *
 * Same shape as perfHud's own record/render split (a rolling window of raw
 * samples, averaged on read) — this exists because "10fps but only 106 draws
 * and 121k tris" proves the bottleneck is CPU-side JS, not the GPU, and
 * guessing which system is expensive risks fixing the wrong thing again.
 *
 * `time()` degrades to a bare `fn()` call with zero overhead when disabled —
 * this stays off by default and costs nothing in normal play, the same
 * reasoning perfHud.record() already uses for `!this.visible`.
 */
export class TickProfiler {
  constructor() {
    this.enabled = false;
    this.segments = new Map(); // name -> ms[] rolling window, oldest first
  }

  time(name, fn) {
    if (!this.enabled) return fn();
    const t0 = performance.now();
    const result = fn();
    this._record(name, performance.now() - t0);
    return result;
  }

  _record(name, ms) {
    let samples = this.segments.get(name);
    if (!samples) {
      samples = [];
      this.segments.set(name, samples);
    }
    samples.push(ms);
    if (samples.length > WINDOW_SIZE) samples.shift();
  }

  /** [{name, avgMs}], worst first. */
  report() {
    const rows = [];
    for (const [name, samples] of this.segments) {
      if (samples.length === 0) continue;
      const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
      rows.push({ name, avgMs });
    }
    rows.sort((a, b) => b.avgMs - a.avgMs);
    return rows;
  }

  /** Clears accumulated samples — call when toggling on, so stale numbers from before don't linger. */
  reset() {
    this.segments.clear();
  }
}
