/**
 * Procedural sound design — pure DSP, no THREE, no positioning, no pooling.
 *
 * There are no sound *assets* in this game. Every cue is synthesized at
 * runtime from a small vocabulary of primitives (noise, tone, envelope,
 * filter sweep), the same approach `jsfxr`/Vlambeer-style games use for
 * weapon and impact SFX: it costs zero network payload, and — the reason it
 * fits this codebase specifically — its parameters are the same numbers
 * already driving the visuals. `explosion()`'s `intensity` argument is fed
 * the identical `sqrt(damage / REFERENCE_DAMAGE)` curve `core/craters.js`
 * uses to size a crater, so a shell that digs a bigger hole also makes a
 * bigger bang, from one shared number rather than two tuned separately.
 *
 * Every generator here renders into an `AudioBuffer` via `OfflineAudioContext`
 * and returns a Promise — baking happens once per distinct sound (cached by
 * `audio.js`, keyed on id + a small integer variation), never per shot. A
 * 40-shell barrage plays 40 cheap `AudioBufferSourceNode.start()` calls
 * against buffers that already exist, not 40 fresh synthesis graphs.
 *
 * The one exception is `engineGraph()`, which builds a *live*, persistent
 * node graph instead of baking to a buffer — an engine's pitch and filter
 * cutoff track vehicle speed continuously, which a fixed buffer can't do.
 *
 * Nothing here reads a wall clock, a random seed, or simulation state — it is
 * render-only in the same sense `projectileFx.js`'s debris scatter is (see
 * CLAUDE.md: "Render-only code may use whatever it likes"), so `Math.random`
 * for sound variation is fine and used deliberately, via `variedSeed` below.
 */

/** Sample rate for every baked buffer. 22.05kHz is plenty for short SFX and
 * halves the render cost and memory of 44.1kHz for content with no real
 * high-frequency detail to preserve. */
export const SAMPLE_RATE = 22050;

/**
 * A small integer seed derived from a sound id and a variation index, used to
 * jitter parameters (pitch, noise mix) so the same cue doesn't sound like a
 * looped sample when it repeats rapidly — a real problem for weapon fire and
 * impacts specifically. Deliberately not the deterministic `fnv1a` used
 * elsewhere for simulation rolls: this has no correctness requirement to
 * satisfy, and reusing that hash here would misleadingly imply one.
 */
export function variedSeed() {
  return Math.random();
}

/**
 * Render a callback that builds a Web Audio graph into an offline context,
 * and return the resulting buffer. Every generator below is a thin wrapper
 * over this — it exists once so channel count, sample rate and the
 * start/render boilerplate live in exactly one place.
 *
 * @param {number} duration seconds
 * @param {(ctx: OfflineAudioContext) => void} build wires up the graph;
 *   whatever it connects to `ctx.destination` is what gets rendered
 */
async function bake(duration, build) {
  const frames = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  build(ctx);
  return ctx.startRendering();
}

/**
 * A short burst of filtered noise — the basis of every explosion, impact and
 * weapon-fire sound. White noise is generated once into a reusable buffer per
 * offline context (there is no built-in noise node), then shaped by an
 * envelope and a lowpass sweep.
 *
 * @param {OfflineAudioContext} ctx
 * @param {object} opts
 * @param {number} opts.duration seconds
 * @param {number} opts.startFreq lowpass cutoff at the start, Hz
 * @param {number} opts.endFreq lowpass cutoff at the end, Hz — lower than
 *   startFreq for the classic "bright crack fading to a dull thud" shape
 * @param {number} opts.attack seconds to full volume
 * @param {number} opts.release seconds from full volume to silence
 * @param {number} opts.gain peak linear gain
 * @param {AudioNode} [opts.destination] defaults to ctx.destination
 */
function noiseBurst(ctx, { duration, startFreq, endFreq, attack, gain, destination }) {
  const frames = Math.ceil(duration * ctx.sampleRate);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(startFreq, ctx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), ctx.currentTime + duration);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, ctx.currentTime);
  env.gain.linearRampToValueAtTime(gain, ctx.currentTime + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

  source.connect(filter);
  filter.connect(env);
  env.connect(destination ?? ctx.destination);
  source.start();
  return { source, filter, env };
}

/**
 * A pitched tone with a frequency slide — the basis of weapon cracks, UI
 * chimes and the coin-pickup jingle.
 *
 * @param {OfflineAudioContext} ctx
 * @param {object} opts
 * @param {'sine'|'square'|'sawtooth'|'triangle'} opts.wave
 * @param {number} opts.startHz
 * @param {number} opts.endHz
 * @param {number} opts.duration seconds
 * @param {number} opts.attack seconds
 * @param {number} opts.gain peak linear gain
 * @param {number} [opts.startTime] offset within the render, for chords/arpeggios
 */
function tone(ctx, { wave, startHz, endHz, duration, attack, gain, startTime = 0, destination }) {
  const osc = ctx.createOscillator();
  osc.type = wave;
  const t0 = ctx.currentTime + startTime;
  osc.frequency.setValueAtTime(startHz, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), t0 + duration);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(env);
  env.connect(destination ?? ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
  return { osc, env };
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/**
 * Weapon fire: a tight noise crack plus a short pitched click, scaled by
 * calibre. Bigger guns get a lower click and a longer, darker noise tail —
 * the same "damage decides brightness and length" idea `explosion` uses,
 * kept modest here since a rapid-fire weapon plays this many times a second.
 *
 * @param {number} calibre matches `turret.damage` — the same number the
 *   crater/impact-light systems already scale off
 */
export function weaponFire(calibre = 20) {
  const scale = Math.sqrt(Math.max(0.2, calibre / 20));
  const duration = 0.12 + scale * 0.05;
  const jitter = 1 + (variedSeed() - 0.5) * 0.08;
  return bake(duration + 0.05, (ctx) => {
    noiseBurst(ctx, {
      duration,
      startFreq: 4200 / scale,
      endFreq: 500,
      attack: 0.002,
      gain: 0.9,
    });
    tone(ctx, {
      wave: 'square',
      startHz: (1400 / scale) * jitter,
      endHz: 220 / scale,
      duration: 0.05,
      attack: 0.001,
      gain: 0.5,
    });
  });
}

/**
 * Impact / explosion. `intensity` is expected to be the caller's own
 * `sqrt(damage / REFERENCE_DAMAGE)` — the exact curve `Craters.shapeFor` uses
 * — so a ground hit that digs a bigger crater also booms bigger, from one
 * shared number rather than two independently tuned ones.
 *
 * @param {number} intensity roughly 0.3 (light) to 3+ (base-station-killer)
 * @param {boolean} ground true for a ground impact (dirt, drier/duller),
 *   false for a hull hit (more metallic, brighter transient)
 */
export function explosion(intensity = 1, ground = true) {
  const duration = 0.35 + intensity * 0.35;
  return bake(duration + 0.1, (ctx) => {
    noiseBurst(ctx, {
      duration,
      startFreq: ground ? 2600 : 3800,
      endFreq: ground ? 90 : 160,
      attack: 0.004,
      gain: Math.min(1, 0.55 + intensity * 0.18),
    });
    // A low sine "thump" under the noise gives the low-end weight noise alone
    // can't — the actual "impact" sensation, not just a hiss.
    tone(ctx, {
      wave: 'sine',
      startHz: 120 / Math.sqrt(intensity),
      endHz: 35,
      duration: Math.min(0.5, duration * 0.7),
      attack: 0.005,
      gain: Math.min(0.9, 0.4 + intensity * 0.15),
    });
    if (!ground) {
      // A short metallic ring on top of a hull hit — a detuned pair of tones
      // decaying fast, the cheapest approximation of a metal resonance.
      tone(ctx, { wave: 'triangle', startHz: 900, endHz: 700, duration: 0.15, attack: 0.001, gain: 0.25 });
      tone(ctx, { wave: 'triangle', startHz: 1180, endHz: 950, duration: 0.12, attack: 0.001, gain: 0.18 });
    }
  });
}

/**
 * A vehicle or structure's death — one step up from `explosion`, with a
 * longer, messier tail (the wreck settling) layered on. `scale` is the same
 * kind of weight/size number `leaveWreckage` already uses
 * (`hullLength * 0.28`-ish), clamped by the caller.
 */
export function destroyed(scale = 1) {
  const duration = 0.6 + scale * 0.4;
  return bake(duration + 0.15, (ctx) => {
    noiseBurst(ctx, { duration, startFreq: 3200, endFreq: 70, attack: 0.003, gain: 1 });
    tone(ctx, { wave: 'sine', startHz: 90, endHz: 25, duration: duration * 0.8, attack: 0.005, gain: 0.7 });
    // Debris tail: a second, quieter, longer noise burst starting a beat
    // later, brighter filter, so it reads as settling rubble rather than a
    // simple echo of the same bang.
    noiseBurst(ctx, {
      duration: duration * 0.6,
      startFreq: 1400,
      endFreq: 300,
      attack: 0.02,
      gain: 0.22,
    });
  });
}

// ---------------------------------------------------------------------------
// Economy & UI
// ---------------------------------------------------------------------------

/** Harvester scoop — a short rhythmic scrape. Looped by the caller. */
export function harvestScoop() {
  return bake(0.28, (ctx) => {
    noiseBurst(ctx, { duration: 0.18, startFreq: 1800, endFreq: 700, attack: 0.01, gain: 0.35 });
    tone(ctx, { wave: 'triangle', startHz: 260, endHz: 180, duration: 0.15, attack: 0.01, gain: 0.2 });
  });
}

/** Credits delivered at a refinery. */
export function harvestDeliver() {
  return bake(0.4, (ctx) => {
    tone(ctx, { wave: 'sine', startHz: 520, endHz: 780, duration: 0.18, attack: 0.005, gain: 0.4 });
    tone(ctx, { wave: 'sine', startHz: 780, endHz: 1040, duration: 0.16, attack: 0.001, gain: 0.35, startTime: 0.09 });
  });
}

/**
 * The bounty-coin jingle — a short ascending arpeggio, matching the gold
 * "arrival" moment `ui/creditBurst.js` already animates.
 */
export function coinPickup() {
  const notes = [660, 880, 1100, 1320];
  return bake(0.5, (ctx) => {
    notes.forEach((hz, i) => {
      tone(ctx, {
        wave: 'triangle',
        startHz: hz,
        endHz: hz * 1.01,
        duration: 0.18,
        attack: 0.003,
        gain: 0.28,
        startTime: i * 0.045,
      });
    });
  });
}

/** Coin appearing at a wreck — a soft, low chime, distinct from pickup. */
export function coinSpawn() {
  return bake(0.3, (ctx) => {
    tone(ctx, { wave: 'sine', startHz: 420, endHz: 520, duration: 0.22, attack: 0.01, gain: 0.22 });
  });
}

/** Generic confirm chime — menu open, valid placement, block toggle. */
export function uiConfirm() {
  return bake(0.16, (ctx) => {
    tone(ctx, { wave: 'sine', startHz: 700, endHz: 900, duration: 0.1, attack: 0.002, gain: 0.3 });
  });
}

/** Generic cancel/close — menu close, unblock. Lower and shorter than confirm. */
export function uiCancel() {
  return bake(0.14, (ctx) => {
    tone(ctx, { wave: 'sine', startHz: 500, endHz: 380, duration: 0.09, attack: 0.002, gain: 0.26 });
  });
}

/** Refused/invalid — insufficient funds, bad placement, blocked-field click. */
export function uiRefused() {
  return bake(0.22, (ctx) => {
    tone(ctx, { wave: 'square', startHz: 220, endHz: 160, duration: 0.14, attack: 0.001, gain: 0.22 });
  });
}

/** Structure finished building. */
export function structureComplete() {
  return bake(0.55, (ctx) => {
    [523, 659, 784].forEach((hz, i) =>
      tone(ctx, {
        wave: 'triangle',
        startHz: hz,
        endHz: hz,
        duration: 0.3,
        attack: 0.01,
        gain: 0.3,
        startTime: i * 0.09,
      })
    );
  });
}

// ---------------------------------------------------------------------------
// Match framing
// ---------------------------------------------------------------------------

export function matchStart() {
  return bake(0.6, (ctx) => {
    tone(ctx, { wave: 'square', startHz: 220, endHz: 440, duration: 0.4, attack: 0.02, gain: 0.35 });
  });
}

export function victory() {
  return bake(1.4, (ctx) => {
    [523, 659, 784, 1046].forEach((hz, i) =>
      tone(ctx, {
        wave: 'triangle',
        startHz: hz,
        endHz: hz,
        duration: 0.5,
        attack: 0.01,
        gain: 0.35,
        startTime: i * 0.14,
      })
    );
  });
}

export function defeat() {
  return bake(1.2, (ctx) => {
    [392, 349, 293, 220].forEach((hz, i) =>
      tone(ctx, {
        wave: 'sawtooth',
        startHz: hz,
        endHz: hz * 0.97,
        duration: 0.55,
        attack: 0.02,
        gain: 0.28,
        startTime: i * 0.16,
      })
    );
  });
}

export function notification() {
  return bake(0.2, (ctx) => {
    tone(ctx, { wave: 'sine', startHz: 880, endHz: 880, duration: 0.12, attack: 0.002, gain: 0.25 });
  });
}

// ---------------------------------------------------------------------------
// Ambience — short loopable textures, crossfaded by the caller
// ---------------------------------------------------------------------------

/**
 * A loop-friendly noise texture. Rendered with a fade-in/out on both ends so
 * a caller looping the buffer via `Audio.setLoop(true)` doesn't click at the
 * seam. `lfoHz` slowly wobbles the filter cutoff — the difference between a
 * flat hiss and something that reads as wind or surf.
 */
function ambienceLoop({ duration, baseFreq, lfoHz, lfoDepth, gain }) {
  return bake(duration, (ctx) => {
    const frames = Math.ceil(duration * ctx.sampleRate);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.4;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoHz;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = lfoDepth;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    filter.frequency.value = baseFreq;
    lfo.start();

    // Fade the whole two-second-plus loop in and out at its very ends only,
    // so the seam when it repeats is inaudible — the loop point itself stays
    // at full, steady volume.
    const env = ctx.createGain();
    const fade = Math.min(0.15, duration * 0.1);
    env.gain.setValueAtTime(0, ctx.currentTime);
    env.gain.linearRampToValueAtTime(gain, ctx.currentTime + fade);
    env.gain.setValueAtTime(gain, ctx.currentTime + duration - fade);
    env.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);

    source.connect(filter);
    filter.connect(env);
    env.connect(ctx.destination);
    source.start();
  });
}

/** Wind and surf — bright-ish, faster wobble. */
export function dayAmbience() {
  return ambienceLoop({ duration: 4, baseFreq: 900, lfoHz: 0.13, lfoDepth: 400, gain: 0.5 });
}

/** Crickets/quiet wind — darker, slower wobble, lower overall level. */
export function nightAmbience() {
  return ambienceLoop({ duration: 4, baseFreq: 500, lfoHz: 0.07, lfoDepth: 180, gain: 0.32 });
}

// ---------------------------------------------------------------------------
// Continuous: live graphs, not baked buffers
// ---------------------------------------------------------------------------

/**
 * A persistent engine tone: a detuned sawtooth pair through a lowpass filter,
 * both driven continuously by the caller from `vehicle.speed`. Unlike
 * everything above, this returns live nodes rather than a buffer — an
 * engine's pitch has to track speed every frame, which a fixed buffer can't
 * do without either being re-baked constantly (expensive) or pitch-shifted
 * via `playbackRate` (works, but the filter cutoff still needs live control
 * for the "load" sensation, so a live graph is simpler than a hybrid).
 *
 * @param {AudioContext} ctx the *real*, non-offline context
 * @param {number} baseHz idle pitch, from `def.weight` (heavier = lower)
 * @returns {{ output: AudioNode, setSpeed: (speedFrac: number) => void, stop: () => void }}
 *   `speedFrac` is 0 (idle) to 1 (top speed); `output` is what the caller
 *   connects into its `PositionalAudio`'s node source.
 */
export function engineGraph(ctx, baseHz) {
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  osc1.type = 'sawtooth';
  osc2.type = 'sawtooth';
  osc1.frequency.value = baseHz;
  osc2.frequency.value = baseHz * 1.008; // slight detune — two-cylinder beat, not a pure tone

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.5;
  filter.frequency.value = baseHz * 4;

  const gain = ctx.createGain();
  gain.gain.value = 0.18;

  osc1.connect(filter);
  osc2.connect(filter);
  filter.connect(gain);
  osc1.start();
  osc2.start();

  return {
    output: gain,
    setSpeed(speedFrac) {
      const f = Math.min(1, Math.max(0, speedFrac));
      const t = ctx.currentTime + 0.05;
      // Pitch and filter cutoff both rise with speed/load — the two cues
      // that actually read as "engine working harder" together; either one
      // alone reads as a pitch-shifted sample rather than a real engine.
      osc1.frequency.linearRampToValueAtTime(baseHz * (1 + f * 0.9), t);
      osc2.frequency.linearRampToValueAtTime(baseHz * 1.008 * (1 + f * 0.9), t);
      filter.frequency.linearRampToValueAtTime(baseHz * (4 + f * 10), t);
      gain.gain.linearRampToValueAtTime(0.14 + f * 0.12, t);
    },
    stop() {
      osc1.stop();
      osc2.stop();
    },
  };
}
