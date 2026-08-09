/**
 * FPS-adaptive quality — drops shadow quality and thickens fog when the game
 * is genuinely struggling, restores both once it recovers.
 *
 * Per the tick-profiler findings (docs/performance-optimization-plan.md,
 * src/core/tickProfiler.js): shadows are the dominant per-frame GPU cost on
 * this game, not draw calls or triangle count. So this leads with the
 * shadow-quality toggle that already exists (main.js's applyShadowQuality),
 * and raises fog density alongside it — which both shortens visible draw
 * distance and masks the terrain LOD transition, without needing a third,
 * separate draw-distance system.
 *
 * Runs its own tiny rolling fps average rather than reading perfHud, since
 * perfHud only accumulates samples while its HUD is visible.
 */

const WINDOW_SIZE = 30; // ~0.5-1s at typical fps — enough to smooth a single stutter
const LOW_FPS_THRESHOLD = 25;
const RECOVER_FPS_THRESHOLD = 32; // hysteresis: recover well above the drop point, no flapping at the boundary
const LOW_FOG_MULTIPLIER = 2.2;

export class AutoQuality {
  constructor() {
    this.samples = [];
    this.low = false;
  }

  /** @param {number} dt seconds since the last rendered frame */
  record(dt) {
    this.samples.push(dt * 1000);
    if (this.samples.length > WINDOW_SIZE) this.samples.shift();
  }

  get fps() {
    if (this.samples.length === 0) return 60;
    const avgMs = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    return 1000 / avgMs;
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.userForcedShadowQuality - true once the player has touched the
   *   manual "High-quality shadows" toggle this session; auto-quality then leaves shadows
   *   alone entirely so it never fights an explicit choice.
   * @param {(high: boolean) => void} opts.setShadowQuality
   * @param {(density: number) => void} opts.setFogDensity
   * @param {number} opts.baseFogDensity
   */
  update({ userForcedShadowQuality, setShadowQuality, setFogDensity, baseFogDensity }) {
    const fps = this.fps;
    if (!this.low && fps < LOW_FPS_THRESHOLD) {
      this.low = true;
      if (!userForcedShadowQuality) setShadowQuality(false);
      setFogDensity(baseFogDensity * LOW_FOG_MULTIPLIER);
    } else if (this.low && fps > RECOVER_FPS_THRESHOLD) {
      this.low = false;
      if (!userForcedShadowQuality) setShadowQuality(true);
      setFogDensity(baseFogDensity);
    }
  }
}
