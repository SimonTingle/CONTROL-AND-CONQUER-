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
import { linearGainAt, propagationDelay, auditionRecipe, auditionBuffer } from '../audio/audio.js';
import { bakeRecipe, ambienceSegment, bakeEngineSample, DEFAULT_ENGINE_SPEC } from '../audio/synth.js';
import { recipeDuration, validateRecipe, kindOf } from './soundRecipe.js';

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
    this.auditionButtons = [];
    for (const d of [10, 60, 200]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'builder-btn';
      b.textContent = `Hear at ${d}m`;
      b.addEventListener('click', () => this.audition(d));
      b.dataset.distance = String(d);
      this.auditionButtons.push(b);
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
    this.relabelAuditionButtons();
    this.invalidate();
    clearTimeout(this._bakeTimer);
    this._bakeTimer = setTimeout(() => this.rebake(), BAKE_DEBOUNCE_MS);
  }

  /** The same three buttons mean distance for a sound and speed for an
   * engine, so they say which. */
  relabelAuditionButtons() {
    const engine = kindOf(this.recipe) === 'engine';
    const speedLabel = { 10: 'idle', 60: 'half', 200: 'full' };
    for (const b of this.auditionButtons ?? []) {
      const d = b.dataset.distance;
      b.textContent = engine ? `Hear at ${speedLabel[d]}` : `Hear at ${d}m`;
    }
    if (this.distanceSlider) this.distanceSlider.disabled = engine;
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
    const kind = kindOf(recipe);
    if (kind === 'engine') {
      // An engine is a live graph, not a buffer — there is nothing to bake and
      // nothing to draw a waveform of. Its picture is the speed response,
      // drawn straight from the spec in drawEngine().
      this.buffer = null;
      this.invalidate();
      return;
    }

    const token = ++this._bakeToken;
    try {
      // A bed segment IS a baked buffer, so it gets the ordinary waveform.
      const buffer = kind === 'ambience'
        ? await ambienceSegment(recipe.event === 'night' ? 'night' : 'day', recipe.ambience)
        : await bakeRecipe(recipe, recipeDuration(recipe));
      if (token !== this._bakeToken) return; // a newer edit already superseded this
      this.buffer = buffer;
    } catch {
      this.buffer = null;
    }
    this.invalidate();
  }

  /**
   * Hear the current recipe.
   *
   * For a sound effect the `distance` argument is the point — that is what the
   * rig is for. An engine has no distance to audition at; what varies is
   * *speed*, so the same buttons mean idle / half / full instead, and the
   * engine is rendered offline at that speed through the real `engineGraph`.
   */
  audition(arg = this.distance) {
    if (!this.recipe || validateRecipe(this.recipe).length) return;
    if (kindOf(this.recipe) !== 'engine') {
      auditionRecipe(this.recipe, arg);
      return;
    }
    // `arg` arrives as a distance from the shared buttons; map the three
    // fixed positions onto three speeds rather than adding a second row of
    // controls that only one kind would ever use.
    const speed = this.engineSpeedFor(arg);
    bakeEngineSample(this.recipe.engine, 150, speed, 1.2)
      .then((buffer) => auditionBuffer(buffer))
      .catch(() => {});
  }

  /** Map the three shared audition buttons onto idle / half / full. */
  engineSpeedFor(distance) {
    if (distance >= 200) return 1;
    if (distance >= 60) return 0.5;
    return 0;
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
    const kind = kindOf(this.recipe);
    if (kind === 'engine') {
      this.drawEngine();
      // Otherwise the distance rig keeps whatever the last sound effect left
      // there, which reads as a live graph belonging to this engine.
      this.clearRig('An engine is heard from its vehicle — reach is fixed.');
      return;
    }
    this.drawWave();
    // Only a positioned one-shot has a distance falloff to show. A bed is
    // non-positional and an engine's rig is its speed response, so drawing
    // the gain curve for either would be a graph of something inert — the
    // exact failure the acoustics curves were left out for.
    if (kind === 'sfx') this.drawRig();
    else this.clearRig();
  }

  clearRig(message = 'Ambience is non-positional — no distance falloff.') {
    const { g, height } = this.fit(this.rigCanvas, 40);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.font = '12px system-ui, sans-serif';
    g.fillText(message, 10, height / 2 + 4);
    this.readout.textContent = '';
  }

  /**
   * An engine's picture: pitch and filter cutoff against speed.
   *
   * This is the actual thing being authored. A waveform would be meaningless
   * even if one existed — the graph runs continuously and its whole character
   * is *how it changes with speed*, which is exactly what a still frame of it
   * cannot show.
   */
  drawEngine() {
    const { g, width, height } = this.fit(this.waveCanvas, 180);
    const spec = { ...DEFAULT_ENGINE_SPEC, ...(this.recipe?.engine ?? {}) };
    const pad = 38;
    const plotW = width - pad * 2;
    const plotH = height - pad - 26;
    // A representative idle pitch. The real one comes from vehicle weight at
    // runtime (260 - weight*14 in main.js); the shape of the response is what
    // this shows, and that shape is the same at any base pitch.
    const baseHz = 150;
    const maxHz = baseHz * (1 + spec.pitchRise) * 1.05;
    const maxCut = baseHz * (spec.cutoffRatio + spec.cutoffRise) * 1.05;

    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.moveTo(pad, pad);
    g.lineTo(pad, pad + plotH);
    g.lineTo(pad + plotW, pad + plotH);
    g.stroke();

    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '11px system-ui, sans-serif';
    g.fillText('idle', pad - 8, pad + plotH + 16);
    g.fillText('full speed', pad + plotW - 50, pad + plotH + 16);

    const line = (valueAt, max, colour, label, labelY) => {
      g.strokeStyle = colour;
      g.lineWidth = 2;
      g.beginPath();
      for (let x = 0; x <= plotW; x++) {
        const f = x / plotW;
        const y = pad + (1 - valueAt(f) / max) * plotH;
        if (x === 0) g.moveTo(pad + x, y);
        else g.lineTo(pad + x, y);
      }
      g.stroke();
      g.lineWidth = 1;
      g.fillStyle = colour;
      g.fillText(label, pad + 6, labelY);
    };

    // Two curves on two scales, which is honest here rather than sloppy: they
    // are different quantities (both Hz, but an octave of pitch and a filter
    // sweep are not comparable magnitudes), and what an author reads off this
    // is each curve's *shape*, not one against the other.
    line((f) => baseHz * (1 + f * spec.pitchRise), maxHz, '#7fd4ff', 'pitch', pad + 14);
    line((f) => baseHz * (spec.cutoffRatio + f * spec.cutoffRise), maxCut, '#ffd479', 'brightness', pad + 30);

    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText(
      `${spec.oscillators}\u00d7 ${spec.wave}, detune ${Number(spec.detune).toFixed(3)}`,
      pad + 6, pad + plotH - 8,
    );
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
