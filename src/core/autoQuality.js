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
 *
 * ## Why this is damped, and not just hysteresed
 *
 * This is a feedback controller whose own action changes the signal it measures,
 * and that made it oscillate — reported as the whole screen "flashing" at dusk,
 * confirmed by a closed-loop model in tests/auto-quality-damping.test.mjs.
 *
 * The loop: fps falls below LOW_FPS_THRESHOLD → go low → low quality is ~2.7x
 * faster → fps climbs past RECOVER_FPS_THRESHOLD → go high → slow again → …
 * Feeding it an fps that depends on the state it chose (23 high / 40 low) it
 * flipped 29 times in 600 frames — roughly 1.5-3 Hz, each flip jumping fog
 * density 2.2x and DPR between 2 and 1.
 *
 * **The threshold gap alone cannot fix this.** Hysteresis defends against noise
 * jittering across a boundary; here the controller *moves the measurement* by
 * more than any gap, so every threshold between the two states' framerates
 * oscillates by construction. What it needs is damping in *time*:
 *
 * - the sample window is cleared on every change, because it otherwise describes
 *   the quality state we just left and the next verdict is made on stale data;
 * - a minimum dwell in each state, so one change cannot immediately trigger the
 *   next;
 * - and that dwell backs off exponentially per flip, so a machine that genuinely
 *   sits in the unstable band settles down instead of strobing.
 *
 * The backoff is deliberately not a permanent latch. A device that oscillates
 * cannot sustain high quality and should change ever more rarely — but a player
 * whose framerate dipped during one heavy battle should still get their
 * resolution back afterwards. A latch would trade a flashing screen for a
 * permanently blurry one.
 *
 * Fog is ramped rather than stepped for the same reason: it is the most visible
 * half of the change and, unlike pixel ratio, it is a continuous value. A
 * legitimate quality drop should read as haze rolling in, not as a cut. Pixel
 * ratio stays a step because it reallocates the drawing buffer and cannot be
 * interpolated — acceptable once changes are rare, since it was the *repetition*
 * that read as flashing.
 */

const WINDOW_SIZE = 30; // ~0.5-1s at typical fps — enough to smooth a single stutter
const LOW_FPS_THRESHOLD = 25;
const RECOVER_FPS_THRESHOLD = 32; // hysteresis: recover well above the drop point, no flapping at the boundary
const LOW_FOG_MULTIPLIER = 2.2;
const LOW_PIXEL_RATIO = 1;

/**
 * Seconds a quality state must hold before it may change again. Sized to be
 * comfortably longer than the sample window takes to refill, so a decision is
 * always made on samples drawn entirely from the current state.
 */
const BASE_DWELL_SECONDS = 6;
/** Each flip doubles the dwell, up to here. Two minutes is long enough that a
 * pathological device effectively stops changing, without ever being permanent. */
const MAX_DWELL_SECONDS = 120;
/** Seconds for the fog to travel between its two densities. */
const FOG_RAMP_SECONDS = 0.8;

export class AutoQuality {
  constructor() {
    this.samples = [];
    this.low = false;
    /** Seconds accumulated in the current quality state. */
    this.stateAge = 0;
    /** Current minimum dwell, grown by `flips`. */
    this.dwellSeconds = BASE_DWELL_SECONDS;
    /** How many times quality has changed this session — drives the backoff. */
    this.flips = 0;
    /** Fog ramp state. Null until the first `update` learns the base density. */
    this.fogFrom = null;
    this.fogTo = null;
    this.fogRamp = 1; // 0..1, 1 = settled
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

  /** The fog density this state wants, once settled. */
  _targetFog(baseFogDensity) {
    return this.low ? baseFogDensity * LOW_FOG_MULTIPLIER : baseFogDensity;
  }

  /**
   * @param {object} opts
   * @param {number} [opts.dt] seconds since the last frame. Drives the dwell
   *   timer and the fog ramp. Optional so an older call site still behaves
   *   (it simply never ramps and never dwells), but main.js passes it.
   * @param {boolean} opts.userForcedPixelRatio - true once the player has set render
   *   resolution themselves this session; auto-quality then leaves it alone so it never
   *   fights an explicit choice.
   * @param {(ratio: number) => void} opts.setPixelRatio
   * @param {number} opts.basePixelRatio - the ratio to restore on recovery.
   * @param {(density: number) => void} opts.setFogDensity
   * @param {number} opts.baseFogDensity
   */
  update({
    dt = 0,
    userForcedPixelRatio,
    setPixelRatio,
    basePixelRatio,
    setFogDensity,
    baseFogDensity,
  }) {
    this.stateAge += dt;

    // First call: adopt the base density as the settled value so the ramp has
    // somewhere to start from rather than lerping out of null.
    if (this.fogFrom === null) {
      this.fogFrom = this._targetFog(baseFogDensity);
      this.fogTo = this.fogFrom;
    }

    this._stepFogRamp(dt, setFogDensity);

    const fps = this.fps;
    const wantsLow = !this.low && fps < LOW_FPS_THRESHOLD;
    const wantsHigh = this.low && fps > RECOVER_FPS_THRESHOLD;
    if (!wantsLow && !wantsHigh) return;

    // The verdict is right but it is not yet allowed. Holding here — rather
    // than acting and letting the next frame undo it — is the whole fix.
    if (this.stateAge < this.dwellSeconds) return;

    this.low = wantsLow;
    this.flips++;
    this.stateAge = 0;
    // Counting the first flip toward the backoff is deliberate, and was
    // re-examined during the fps second pass (see
    // docs/plans/fps-regression-second-pass.md): "the first change is free"
    // was tried, on the theory that a machine needing one honest drop to low
    // should not then wait 12s to recover. It makes
    // tests/auto-quality-damping.test.mjs's narrow-band case strobe an extra
    // time, which is the exact dusk/dawn symptom the damping was written to
    // fix. A slower recovery is the cheaper of the two, so this stays as-is.
    this.dwellSeconds = Math.min(MAX_DWELL_SECONDS, BASE_DWELL_SECONDS * 2 ** this.flips);
    // The window still holds frames rendered at the quality we just left. Kept,
    // it would make the next verdict from measurements of a state that no
    // longer exists — which is how a single change used to cause the next one.
    this.samples.length = 0;

    if (!userForcedPixelRatio) setPixelRatio(this.low ? LOW_PIXEL_RATIO : basePixelRatio);

    // Ramp from wherever the fog actually is, not from the state's nominal
    // density — a change landing mid-ramp must not jump.
    this.fogFrom = this._currentFog();
    this.fogTo = this._targetFog(baseFogDensity);
    this.fogRamp = 0;
    this._stepFogRamp(0, setFogDensity);
  }

  /** The fog density right now, part-way along the ramp. */
  _currentFog() {
    if (this.fogFrom === null) return null;
    return this.fogFrom + (this.fogTo - this.fogFrom) * this.fogRamp;
  }

  /** Advance the ramp and push the value out. No-op once settled. */
  _stepFogRamp(dt, setFogDensity) {
    if (this.fogRamp >= 1) return;
    this.fogRamp = Math.min(1, this.fogRamp + (dt > 0 ? dt / FOG_RAMP_SECONDS : 0));
    setFogDensity(this._currentFog());
  }
}
