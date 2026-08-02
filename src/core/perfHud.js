/**
 * Rolling fps/frame-time readout for performance work — Phase 0 of
 * docs/performance-optimization-plan.md.
 *
 * Kept separate from the existing settings-drawer stats line
 * (Menu.setStats, driven by main.js's own `fps` variable): that one only
 * updates while the drawer is open and averages over a flat 0.5s window.
 * This one stays on screen through an unattended benchmark run and reports
 * the *worst* frames, not just the average — a smooth average can hide the
 * stutters that are what actually feel bad, especially on mobile.
 */

// ~2s at 60fps, ~4s at 30fps — long enough to catch stutters, short enough
// that the numbers stay current as a scene changes.
const WINDOW_SIZE = 120;

export class PerfHud {
  constructor() {
    this.el = document.getElementById('perf-hud');
    this.samples = []; // frame times in ms, oldest first
    this.visible = false;
  }

  setVisible(visible) {
    this.visible = visible;
    this.el.classList.toggle('hidden', !visible);
    if (!visible) this.samples.length = 0;
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  /** @param {number} dt seconds since the last rendered frame */
  record(dt) {
    if (!this.visible) return;
    this.samples.push(dt * 1000);
    if (this.samples.length > WINDOW_SIZE) this.samples.shift();
  }

  /** Call once per rendered frame, after record(). Reads renderer.info for draws/tris. */
  render(renderer) {
    if (!this.visible || this.samples.length === 0) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const avgMs = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const worstMs = sorted[sorted.length - 1];
    // "1% low": the average of the slowest 1% of frames in the window — the
    // standard way to report stutter severity without one outlier frame (a
    // GC pause, say) dominating the number the way a bare worst-frame would.
    const onePercentCount = Math.max(1, Math.round(sorted.length * 0.01));
    const onePercentLowMs =
      sorted.slice(-onePercentCount).reduce((a, b) => a + b, 0) / onePercentCount;

    const info = renderer.info.render;
    this.el.textContent =
      `${(1000 / avgMs).toFixed(0)} fps avg  ${(1000 / onePercentLowMs).toFixed(0)} fps 1% low  ${(1000 / worstMs).toFixed(0)} fps worst\n` +
      `${avgMs.toFixed(1)}ms avg  ${worstMs.toFixed(1)}ms worst\n` +
      `${info.calls} draws  ${(info.triangles / 1000).toFixed(0)}k tris`;
  }
}
