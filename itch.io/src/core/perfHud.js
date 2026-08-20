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

// Sun + hemi + the 4 shared headlights = 6 in a healthy scene; a couple of Power
// Spire beacons on top of that is still fine. Past ~8 the per-fragment light loop
// starts climbing steeply (measured: 8 lights 7.2ms, 16 lights 21.5ms).
const LIGHT_BUDGET = 8;

export class PerfHud {
  constructor() {
    this.el = document.getElementById('perf-hud');
    this.samples = []; // frame times in ms, oldest first
    this.visible = false;
    this.deviceLine = ''; // set once via setDeviceLine — mobile-branch readout, Phase 1 verification
    this.lightCount = 0;
    this._warnedLights = false;
  }

  /** One-line summary of the renderer settings IS_MOBILE actually produced, for on-device checks without devtools. */
  setDeviceLine(text) {
    this.deviceLine = text;
  }

  /**
   * Scene light count, polled on the HUD's half-second cadence (never per frame —
   * it costs a scene.traverse).
   *
   * This exists because the worst performance bug this project has had was
   * invisible: vehicles each built 4-5 SpotLights, so a 20-vehicle match ran 80,
   * and Three.js evaluates every *visible* light per fragment no matter its
   * intensity. That was 705ms of a 710ms frame, and nothing on screen reported
   * it — the WebGL uniform warnings it produced were repeatedly written off in
   * this project's notes as "pre-existing, unrelated shader warnings". They were
   * never unrelated. A number on the HUD makes the whole class of regression
   * obvious at a glance.
   */
  setLightCount(n) {
    this.lightCount = n;
    if (n > LIGHT_BUDGET && !this._warnedLights) {
      this._warnedLights = true;
      console.warn(
        `[perf] ${n} lights in the scene (budget ${LIGHT_BUDGET}). Three.js evaluates every ` +
          `visible light per fragment regardless of intensity — this is the shape of the ` +
          `80-spotlight bug that cost 705ms/frame. See headlightPool.js.`
      );
    }
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

  /**
   * Call once per rendered frame, after record(). Reads renderer.info for draws/tris.
   * @param {import('./tickProfiler.js').TickProfiler} [profiler] optional —
   *   when given and enabled, appends its top offenders below the usual
   *   fps/draws/tris line. Answers "which system" once fps alone says "slow."
   */
  render(renderer, profiler) {
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
    let text =
      `${(1000 / avgMs).toFixed(0)} fps avg  ${(1000 / onePercentLowMs).toFixed(0)} fps 1% low  ${(1000 / worstMs).toFixed(0)} fps worst\n` +
      `${avgMs.toFixed(1)}ms avg  ${worstMs.toFixed(1)}ms worst\n` +
      `${info.calls} draws  ${(info.triangles / 1000).toFixed(0)}k tris  ` +
      `${this.lightCount} lights${this.lightCount > LIGHT_BUDGET ? ' ⚠' : ''}` +
      (this.deviceLine ? `\n${this.deviceLine}` : '');

    if (profiler?.enabled) {
      const rows = profiler.report().slice(0, 6);
      if (rows.length > 0) {
        text += '\n--- tick breakdown (o) ---\n' + rows.map((r) => `${r.name}: ${r.avgMs.toFixed(2)}ms`).join('\n');
      }
    }

    this.el.textContent = text;
  }
}
