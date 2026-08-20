/**
 * FPS-adaptive quality — drops render resolution and thickens fog when the game
 * is genuinely struggling, restores both once it recovers.
 *
 * This originally dropped *shadow* quality, on the tick-profiler's finding that
 * shadows dominated the frame. That finding was wrong, and the reason is worth
 * recording: tickProfiler times CPU only, and `renderer.render()` returns before
 * the GPU has done the work, so a GPU-bound frame shows up as a small `render`
 * segment plus an invisible gap. Measured properly (render in a loop, then
 * `gl.readPixels` to force a sync), shadows on vs off is 4.39ms vs 4.12ms — 0.27ms.
 *
 * Pixel ratio is the real lever once the headlight-pool fix removed the spotlight
 * blowup: DPR 2 → 1 measured 4.4ms → 1.65ms, a 2.7x win, and it is exactly the
 * knob a Retina Mac needs. Fog still thickens alongside, which both shortens the
 * visible distance and masks the terrain LOD transition.
 *
 * Runs its own tiny rolling fps average rather than reading perfHud, since
 * perfHud only accumulates samples while its HUD is visible.
 */

const WINDOW_SIZE = 30; // ~0.5-1s at typical fps — enough to smooth a single stutter
const LOW_FPS_THRESHOLD = 25;
const RECOVER_FPS_THRESHOLD = 32; // hysteresis: recover well above the drop point, no flapping at the boundary
const LOW_FOG_MULTIPLIER = 2.2;
const LOW_PIXEL_RATIO = 1;

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
   * @param {boolean} opts.userForcedPixelRatio - true once the player has set render
   *   resolution themselves this session; auto-quality then leaves it alone so it never
   *   fights an explicit choice.
   * @param {(ratio: number) => void} opts.setPixelRatio
   * @param {number} opts.basePixelRatio - the ratio to restore on recovery.
   * @param {(density: number) => void} opts.setFogDensity
   * @param {number} opts.baseFogDensity
   */
  update({
    userForcedPixelRatio,
    setPixelRatio,
    basePixelRatio,
    setFogDensity,
    baseFogDensity,
  }) {
    const fps = this.fps;
    if (!this.low && fps < LOW_FPS_THRESHOLD) {
      this.low = true;
      if (!userForcedPixelRatio) setPixelRatio(LOW_PIXEL_RATIO);
      setFogDensity(baseFogDensity * LOW_FOG_MULTIPLIER);
    } else if (this.low && fps > RECOVER_FPS_THRESHOLD) {
      this.low = false;
      if (!userForcedPixelRatio) setPixelRatio(basePixelRatio);
      setFogDensity(baseFogDensity);
    }
  }
}
