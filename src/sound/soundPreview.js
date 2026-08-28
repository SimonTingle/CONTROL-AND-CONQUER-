/**
 * The sound editor's centre panel: what the sound looks like, and what it will
 * sound like from a distance.
 *
 * Two canvases, no WebGL. `BuilderPreview` owns a renderer because a vehicle
 * is a mesh; a sound is a waveform and a pair of curves, and 2D canvas draws
 * those for a fraction of the cost — which matters, because the user's stated
 * hard requirement is that none of this touches the game's frame rate.
 *
 * The FPS discipline is copied wholesale from `builderPreview.js`, and it is
 * the reason that file's approach is worth copying rather than improvising:
 *
 * - Its own draw loop, guarded so `start()` twice cannot run two of them, and
 *   cancelled on `stop()`. Closed, this costs exactly nothing.
 * - **The loop only runs while something is changing.** A waveform is a still
 *   image between edits, so redrawing it every frame would be pure waste. The
 *   loop is a one-shot `requestAnimationFrame` scheduled by `invalidate()`,
 *   not a permanent 60Hz treadmill — this panel is idle-at-zero, which the
 *   WebGL preview cannot be.
 * - Baking is debounced. A slider drag is hundreds of `input` events, and each
 *   bake is an `OfflineAudioContext` render; without this the editor would
 *   allocate a few hundred contexts per drag.
 * - Nothing here throws into rAF. A transiently-invalid recipe mid-edit must
 *   draw nothing, not break the loop permanently.
 *
 * The curves are drawn from `audio.js`'s own `linearGainAt`, not from a
 * formula restated here, so the graph cannot drift away from what the panner
 * actually does — the usual way a visualisation starts quietly lying.
 */
import { linearGainAt, propagationDelay, auditionRecipe } from '../audio/audio.js';
import { bakeRecipe } from '../audio/synth.js';
import { recipeDuration, validateRecipe } from './soundRecipe.js';

/** Milliseconds of quiet before a bake is worth doing. One frame is 16ms; a
 * slider drag emits far faster than that, and a bake is not free. */
const BAKE_DEBOUNCE_MS = 120;

/** The distance axis, in world units. 400 covers the largest `maxDistance`
 * any shipped sound uses (`destroyed`, 400) with nothing clipped off. */
const MAX_AXIS = 400;

export class SoundPreview {
  constructor(host) {
    this.host = host;
    this.recipe = null;
    this.buffer = null;
    this.distance = 30;
    this._frame = null;
    this._bakeTimer = null;
    this._running = false;
    /** Guards against a slow bake landing after a newer edit — without this a
     * fast drag can settle on whichever render happened to finish last. */
    this._bakeToken = 0;

    this.build();
  }

  build() {
    this.host.replaceChildren();

    this.waveCanvas = document.createElement('canvas');
    this.waveCanvas.className = 'sound-canvas sound-canvas-wave';
    this.host.appendChild(this.waveCanvas);

    this.rigCanvas = document.createElement('canvas');
    this.rigCanvas.className = 'sound-canvas sound-canvas-rig';
    this.host.appendChild(this.rigCanvas);

    const bar = document.createElement('div');
    bar.className = 'sound-rigbar';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '1';
    slider.max = String(MAX_AXIS);
    slider.step = '1';
    slider.value = String(this.distance);
    slider.addEventListener('input', () => {
      this.distance = parseFloat(slider.value);
      this.invalidate();
    });
    this.distanceSlider = slider;

    this.readout = document.createElement('span');
    this.readout.className = 'sound-readout';

    bar.append(slider, this.readout);

    // Fixed audition distances, so "near / mid / far" can be compared without
    // hunting for the same slider position twice.
    for (const d of [10, 60, 200]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'builder-btn';
      b.textContent = `Hear at ${d}m`;
      b.addEventListener('click', () => this.audition(d));
      bar.appendChild(b);
    }
    this.host.appendChild(bar);
  }

  start() {
    this._running = true;
    this.invalidate();
  }

  stop() {
    this._running = false;
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = null;
    clearTimeout(this._bakeTimer);
    this._bakeTimer = null;
  }

  dispose() {
    this.stop();
    this.buffer = null;
  }

  /**
   * Point the preview at a recipe. Called on every edit, so it must be cheap:
   * the redraw is scheduled, and the bake is debounced.
   */
  setRecipe(recipe) {
    this.recipe = recipe;
    this.invalidate();
    clearTimeout(this._bakeTimer);
    this._bakeTimer = setTimeout(() => this.rebake(), BAKE_DEBOUNCE_MS);
  }

  /** Schedule exactly one redraw. Idempotent within a frame. */
  invalidate() {
    if (!this._running || this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      try {
        this.draw();
      } catch {
        // A recipe mid-edit can be transiently unrenderable. Skipping a frame
        // is correct; letting it escape would kill the loop for good.
      }
    });
  }

  async rebake() {
    const recipe = this.recipe;
    if (!recipe || validateRecipe(recipe).length) {
      // An invalid recipe has no waveform to show. Clearing rather than
      // keeping the last good one is deliberate: a stale picture of a
      // different sound is worse than an empty panel.
      this.buffer = null;
      this.invalidate();
      return;
    }
    const token = ++this._bakeToken;
    try {
      const buffer = await bakeRecipe(recipe, recipeDuration(recipe));
      if (token !== this._bakeToken) return; // a newer edit already superseded this
      this.buffer = buffer;
    } catch {
      this.buffer = null;
    }
    this.invalidate();
  }

  audition(distance = this.distance) {
    if (!this.recipe || validateRecipe(this.recipe).length) return;
    auditionRecipe(this.recipe, distance);
  }

  // ---- drawing ----

  /** Size a canvas to its CSS box at device resolution. Returns its 2D ctx. */
  fit(canvas, height) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth || 600;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    return { g, width, height };
  }

  draw() {
    this.drawWave();
    this.drawRig();
  }

  /**
   * The baked buffer, as min/max per pixel column.
   *
   * Peak-per-column rather than point sampling: a 22kHz buffer has far more
   * samples than pixels, so sampling every Nth would alias a transient away
   * entirely — and a transient is exactly what an author is shaping when they
   * drag "attack".
   */
  drawWave() {
    const { g, width, height } = this.fit(this.waveCanvas, 140);
    const mid = height / 2;

    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(width, mid);
    g.stroke();

    if (!this.buffer) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '12px system-ui, sans-serif';
      g.fillText(this.recipe ? 'Rendering…' : 'No sound selected', 10, mid - 6);
      return;
    }

    const data = this.buffer.getChannelData(0);
    const perPx = data.length / width;
    g.strokeStyle = '#7fd4ff';
    g.beginPath();
    for (let x = 0; x < width; x++) {
      const from = Math.floor(x * perPx);
      const to = Math.min(data.length, Math.floor((x + 1) * perPx));
      let lo = 1;
      let hi = -1;
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (from >= to) { lo = 0; hi = 0; }
      g.moveTo(x + 0.5, mid - hi * mid);
      g.lineTo(x + 0.5, mid - lo * mid);
    }
    g.stroke();

    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`${this.buffer.duration.toFixed(2)}s`, 6, 14);
  }

  /**
   * The distance rig: the gain curve the panner will apply, its refDistance
   * and maxDistance markers, and the listener's position on the axis.
   *
   * This is the graphic that answers "how will this sound from over there",
   * which is otherwise only discoverable by driving the camera across the map
   * and guessing.
   */
  drawRig() {
    const { g, width, height } = this.fit(this.rigCanvas, 180);
    const pad = 34;
    const plotW = width - pad * 2;
    const plotH = height - pad - 26;
    const falloff = this.recipe?.falloff;

    const xOf = (d) => pad + (d / MAX_AXIS) * plotW;
    const yOf = (gain) => pad + (1 - gain) * plotH;

    // axes
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.moveTo(pad, pad);
    g.lineTo(pad, pad + plotH);
    g.lineTo(pad + plotW, pad + plotH);
    g.stroke();

    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '11px system-ui, sans-serif';
    g.fillText('loudness', 4, pad - 8);
    g.fillText(`${MAX_AXIS}m`, pad + plotW - 26, pad + plotH + 16);
    g.fillText('0m', pad - 6, pad + plotH + 16);

    if (!falloff) return;

    // The curve, sampled from the engine's own function.
    g.strokeStyle = '#7fd4ff';
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= plotW; x++) {
      const d = (x / plotW) * MAX_AXIS;
      const gain = linearGainAt(d, falloff);
      const py = yOf(gain);
      if (x === 0) g.moveTo(pad + x, py);
      else g.lineTo(pad + x, py);
    }
    g.stroke();
    g.lineWidth = 1;

    // Markers. refDistance is where falloff begins; maxDistance is where the
    // sound is genuinely gone — which only became true once distanceModel was
    // set to 'linear', since 'inverse' ignores maxDistance entirely.
    for (const [d, label, colour] of [
      [falloff.refDistance, 'full volume', 'rgba(126,235,168,0.8)'],
      [falloff.maxDistance, 'silent', 'rgba(255,140,120,0.8)'],
    ]) {
      if (!Number.isFinite(d) || d > MAX_AXIS) continue;
      g.strokeStyle = colour;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(xOf(d), pad);
      g.lineTo(xOf(d), pad + plotH);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = colour;
      g.fillText(label, xOf(d) + 4, pad + 10);
    }

    // The listener, wherever the distance slider has them.
    const d = this.distance;
    const gain = linearGainAt(d, falloff);
    g.fillStyle = '#ffd479';
    g.beginPath();
    g.arc(xOf(d), yOf(gain), 4, 0, Math.PI * 2);
    g.fill();

    this.readout.textContent =
      `${Math.round(d)}m · ${Math.round(gain * 100)}% loudness · ` +
      `${(propagationDelay(d) * 1000).toFixed(0)}ms travel`;
  }
}
