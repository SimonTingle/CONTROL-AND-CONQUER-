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
// Ambience — generative, chained segments, never a literal loop
// ---------------------------------------------------------------------------

/**
 * Segment length in seconds. Short enough that baking one is cheap and the
 * next is always ready well before it's needed; long enough that the LFO
 * wobble inside a segment reads as weather, not a trill.
 */
export const AMBIENCE_SEGMENT_SECONDS = 5;

/**
 * One take on an ambience bed's character — filtered noise with a slow LFO
 * wobbling the lowpass cutoff, the difference between a flat hiss and
 * something that reads as wind or surf.
 *
 * **This is not a loop.** `audio.js` never sets `Audio.setLoop(true)` on
 * anything built from this — instead it calls `ambienceSegment(kind)` again
 * for every new segment, and every call here rerolls its own LFO rate/depth
 * and base cutoff via `variedSeed()`. The result is a continuous stream that
 * never repeats the same take twice, which a single looped buffer — however
 * long — structurally cannot be: a loop of any length eventually shows its
 * seam to a listener who stays long enough, and this doesn't have one to show.
 *
 * The buffer still fades its own two ends to silence, which is what makes the
 * crossfade `audio.js` performs *between* two of these clickless — the fade
 * is insurance for that handoff, not a loop seam, since nothing here ever
 * plays past its own end.
 *
 * @param {'day'|'night'} kind day is brighter and wobbles faster; night is
 *   darker, slower, and quieter — the same "night is calmer" read
 *   `render/projectileFx.js`'s shadow-to-glow cross-fade already gives the
 *   visuals.
 */
/**
 * The two beds exactly as they sounded before ambience was authorable.
 *
 * The jitter widths encode what the original expressions did: `0.85 + r*0.3`
 * is a 30%-wide window centred on 1, so `freqJitter: 0.3`. Writing them this
 * way rather than as opaque min/max pairs is what lets one schema describe
 * both beds and lets an author reason about "how much does this wander"
 * instead of about two numbers that have to stay ordered.
 *
 * Pinned by test against the ranges they produce, for the same reason
 * DEFAULT_ENGINE_SPEC is: authoring must not change what already ships.
 */
export const DEFAULT_AMBIENCE_SPEC = {
  day: {
    baseFreq: 900, freqJitter: 0.3,
    lfoHz: 0.13, lfoJitter: 0.6,
    lfoDepth: 400, depthJitter: 0.4,
    gain: 0.5, filterQ: 0.4,
    segmentSeconds: AMBIENCE_SEGMENT_SECONDS,
  },
  night: {
    baseFreq: 500, freqJitter: 0.3,
    lfoHz: 0.07, lfoJitter: 0.6,
    lfoDepth: 180, depthJitter: 0.4,
    gain: 0.32, filterQ: 0.4,
    segmentSeconds: AMBIENCE_SEGMENT_SECONDS,
  },
};

export function ambienceSegment(kind, spec) {
  const s = { ...(DEFAULT_AMBIENCE_SPEC[kind === 'night' ? 'night' : 'day']), ...(spec ?? {}) };
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  // Each call re-rolls its own take — see the header above on why this is what
  // makes the stream generative rather than a loop with extra steps. The
  // jitter widths are part of the spec rather than hidden constants precisely
  // so an author can *see* them: setting them all to zero turns the bed back
  // into a loop, which is a legitimate thing to want and should be a visible
  // choice rather than an accident.
  const baseFreq = num(s.baseFreq, 900) * (1 - num(s.freqJitter, 0) / 2 + variedSeed() * num(s.freqJitter, 0));
  const lfoHz = num(s.lfoHz, 0.13) * (1 - num(s.lfoJitter, 0) / 2 + variedSeed() * num(s.lfoJitter, 0));
  const lfoDepth = num(s.lfoDepth, 400) * (1 - num(s.depthJitter, 0) / 2 + variedSeed() * num(s.depthJitter, 0));
  const gain = Math.min(1, Math.max(0, num(s.gain, 0.5)));
  const duration = Math.min(20, Math.max(1, num(s.segmentSeconds, AMBIENCE_SEGMENT_SECONDS)));
  const filterQ = num(s.filterQ, 0.4);

  return bake(duration, (ctx) => {
    const frames = Math.ceil(duration * ctx.sampleRate);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = filterQ;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoHz;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = lfoDepth;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    filter.frequency.value = baseFreq;
    lfo.start();

    // Fade this segment's own two ends to silence — insurance for the
    // crossfade audio.js performs against the *next*, freshly-baked segment,
    // not a loop seam (nothing here ever plays past its own end).
    const env = ctx.createGain();
    const fade = Math.min(0.6, duration * 0.15);
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
/**
 * The engine every vehicle had before engines were authorable.
 *
 * These are not defaults in the "reasonable starting value" sense — they are
 * the *exact* constants `engineGraph` used when its graph was hardcoded, kept
 * as one object so a vehicle with no recipe sounds byte-identical to how it
 * sounded before this feature existed. `tests/authorable-engines.test.mjs`
 * pins each number against the behaviour it produces, so a well-meaning tidy
 * of this table is a failing test rather than a silent change to every
 * vehicle in the game.
 *
 * Same non-regression rule that kept `GENERATORS` untouched when recipes
 * arrived: adding the ability to author something must not change what
 * already ships.
 */
export const DEFAULT_ENGINE_SPEC = {
  oscillators: 2,
  wave: 'sawtooth',
  /** Second oscillator's pitch ratio — the beat that stops it being a pure
   * tone. Small on purpose: past a few cents it stops being one engine. */
  detune: 1.008,
  filterType: 'lowpass',
  filterQ: 0.5,
  /** Cutoff at idle, as a multiple of pitch. */
  cutoffRatio: 4,
  /** How much further the cutoff opens at full speed, in the same units. */
  cutoffRise: 10,
  /** Pitch multiplier added at full speed: 0.9 means +90% at top speed. */
  pitchRise: 0.9,
  gainIdle: 0.14,
  gainRise: 0.12,
  /** Gain the graph is built at, before the first `setSpeed` overwrites it.
   * Its own field rather than derived from idle/rise: the original hardcoded
   * graph started at 0.18, which is not any expression of the other two, and
   * "identical unless authored" has to mean identical. */
  gainStart: 0.18,
};

/**
 * Render a few seconds of an engine held at one speed, as a buffer.
 *
 * `engineGraph` builds a *live* graph, which is right for the game and
 * useless for an editor: there is nothing to draw and nothing to audition
 * through the ordinary one-shot path. This runs the same construction logic
 * inside an `OfflineAudioContext` at a fixed speed so an author can hear what
 * they are editing.
 *
 * Deliberately reuses `engineGraph` rather than reimplementing the graph. A
 * separate "preview engine" would be free to drift from the real one, and an
 * editor that lies about its output is worse than one with no preview — the
 * same rule that makes the vehicle builder render with the real
 * `buildVehicleMesh`.
 *
 * @param {object} [spec] see DEFAULT_ENGINE_SPEC
 * @param {number} [baseHz] idle pitch
 * @param {number} [speedFrac] 0 idle .. 1 full
 * @param {number} [seconds]
 */
export function bakeEngineSample(spec, baseHz = 150, speedFrac = 0, seconds = 1.2) {
  const duration = Math.min(4, Math.max(0.2, seconds));
  return bake(duration, (ctx) => {
    const engine = engineGraph(ctx, baseHz, spec);
    // A short fade at both ends, so auditioning does not click. The live graph
    // does not need this — it is faded by the presence ramp in audio.js — but
    // a bare buffer starting mid-oscillation would.
    const env = ctx.createGain();
    const fade = Math.min(0.08, duration * 0.15);
    env.gain.setValueAtTime(0, 0);
    env.gain.linearRampToValueAtTime(1, fade);
    env.gain.setValueAtTime(1, duration - fade);
    env.gain.linearRampToValueAtTime(0, duration);
    engine.output.connect(env);
    env.connect(ctx.destination);
    engine.setSpeed(speedFrac);
  });
}

/**
 * A persistent engine tone, built from a spec.
 *
 * **Construction happens once per vehicle loop; only `setSpeed` runs per
 * frame.** That split is what makes authorable engines affordable at all, and
 * it is deliberately preserved here: every value the spec contributes is read
 * and folded into a local constant *now*, so `setSpeed` closes over plain
 * numbers and does no lookups, no branching on the spec, and no allocation.
 * The per-frame cost is identical to the hardcoded version — same four
 * `linearRampToValueAtTime` calls, or fewer with one oscillator.
 *
 * This matters more than usual: `updateEngineLoop` is the path an FPS
 * regression was already traced to once (docs/plans/fps-regression.md), and
 * the fix was removing per-frame automation writes. Reintroducing per-frame
 * work here would undo it.
 *
 * @param {AudioContext} ctx the *real*, non-offline context
 * @param {number} baseHz idle pitch, from `def.weight` (heavier = lower)
 * @param {object} [spec] see DEFAULT_ENGINE_SPEC
 */
export function engineGraph(ctx, baseHz, spec = DEFAULT_ENGINE_SPEC) {
  const s = { ...DEFAULT_ENGINE_SPEC, ...(spec ?? {}) };
  // Bounded here as well as in validateRecipe: a spec can arrive from a saved
  // recipe written by an older build, and two oscillators per vehicle across
  // a full loop pool is already the budget this system was tuned for.
  // `num` rather than `Number(x) || fallback`: `||` would replace a legitimate
  // zero (a spec with no pitch rise is a perfectly good flat engine), and
  // `Number(x) ?? fallback` does not work at all — `??` catches null and
  // undefined, not the NaN that `Number('nonsense')` actually produces.
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  const count = Math.min(3, Math.max(1, Math.round(num(s.oscillators, 1))));
  const detune = num(s.detune, 1);
  const pitchRise = num(s.pitchRise, 0);
  const cutoffRatio = Math.max(0.1, num(s.cutoffRatio, 1));
  const cutoffRise = num(s.cutoffRise, 0);
  const gainIdle = clamp01(num(s.gainIdle, 0));
  const gainRise = clamp01(num(s.gainRise, 0));

  const filter = ctx.createBiquadFilter();
  filter.type = s.filterType ?? 'lowpass';
  filter.Q.value = num(s.filterQ, 0.5);
  filter.frequency.value = baseHz * cutoffRatio;

  const gain = ctx.createGain();
  gain.gain.value = clamp01(num(s.gainStart, gainIdle));

  // Each oscillator's own pitch ratio, resolved once. The first sits at
  // baseHz; each further one is detuned by another step, so three oscillators
  // spread rather than stacking two at the same offset.
  const oscillators = [];
  const ratios = [];
  for (let i = 0; i < count; i++) {
    const ratio = detune ** i;
    const osc = ctx.createOscillator();
    osc.type = s.wave ?? 'sawtooth';
    osc.frequency.value = baseHz * ratio;
    osc.connect(filter);
    osc.start();
    oscillators.push(osc);
    ratios.push(baseHz * ratio);
  }

  filter.connect(gain);

  return {
    output: gain,
    setSpeed(speedFrac) {
      // NaN-safe, and that is not defensive padding: `Math.max(0, NaN)` is
      // NaN, so a clamp written the obvious way passes NaN straight through
      // to `linearRampToValueAtTime`, which **throws**. This runs every frame
      // for every moving vehicle, and the exception would escape into
      // `updateEngineLoop` and kill that vehicle's engine for the rest of the
      // match. A speed of NaN is reachable from a custom vehicle def whose
      // `speed` is zero or missing — the division that produces `speedFrac`
      // is guarded in main.js today, but nothing makes that guard permanent.
      const raw = Number(speedFrac);
      const f = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
      const t = ctx.currentTime + 0.05;
      // Pitch and filter cutoff both rise with speed/load — the two cues
      // that actually read as "engine working harder" together; either one
      // alone reads as a pitch-shifted sample rather than a real engine.
      const rise = 1 + f * pitchRise;
      for (let i = 0; i < oscillators.length; i++) {
        oscillators[i].frequency.linearRampToValueAtTime(ratios[i] * rise, t);
      }
      filter.frequency.linearRampToValueAtTime(baseHz * (cutoffRatio + f * cutoffRise), t);
      gain.gain.linearRampToValueAtTime(gainIdle + f * gainRise, t);
    },
    stop() {
      for (const osc of oscillators) osc.stop();
    },
  };
}

/**
 * A carrier oscillator whose frequency is modulated by a second oscillator —
 * two-operator FM.
 *
 * The reason this exists alongside `tone`: FM produces *inharmonic* partials,
 * sidebands at carrier ± n·modulator. Bells, clangs and alarm tones are
 * inharmonic, which is exactly why they cannot be built by stacking `tone`
 * layers — every partial a sum of tones can produce sits at a whole-number
 * multiple of the fundamental, and that is the definition of "not a bell".
 *
 * `ratio` rather than an absolute modulator frequency, because the character
 * of an FM sound follows the carrier:modulator ratio: hold the ratio and a
 * bell transposes and stays a bell; fix the modulator in Hz and it becomes a
 * different instrument at every pitch.
 *
 * @param {OfflineAudioContext} ctx
 */
function fmTone(ctx, { wave, startHz, endHz, ratio, index, duration, attack, gain, startTime = 0, destination }) {
  const t0 = ctx.currentTime + startTime;

  const carrier = ctx.createOscillator();
  carrier.type = wave;
  carrier.frequency.setValueAtTime(startHz, t0);
  carrier.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), t0 + duration);

  const modulator = ctx.createOscillator();
  modulator.type = 'sine'; // a non-sine modulator turns to mud very fast
  modulator.frequency.setValueAtTime(startHz * ratio, t0);
  modulator.frequency.exponentialRampToValueAtTime(Math.max(1, endHz * ratio), t0 + duration);

  // The modulation depth in Hz. Swept down alongside the amplitude envelope
  // so the sound gets *duller* as it decays, which is what a struck object
  // does — holding the index constant reads as synthetic.
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(index, t0);
  depth.gain.exponentialRampToValueAtTime(Math.max(0.0001, index * 0.02), t0 + duration);

  modulator.connect(depth);
  depth.connect(carrier.frequency);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  carrier.connect(env);
  env.connect(destination ?? ctx.destination);
  modulator.start(t0);
  carrier.start(t0);
  modulator.stop(t0 + duration + 0.02);
  carrier.stop(t0 + duration + 0.02);
  return { carrier, modulator, env };
}

/**
 * Noise through a *bandpass* whose centre frequency sweeps.
 *
 * `noiseBurst` uses a lowpass, which can only ever remove the top: sweeping
 * it sounds like something getting duller. A moving resonant band is a
 * different perceptual object — it is what a vehicle passing you actually
 * does to broadband noise, and with a high `q` it is a whistle rather than
 * wind. Neither is reachable with a lowpass at any setting.
 */
function noiseSweep(ctx, { duration, startFreq, endFreq, q, attack, gain, startTime = 0, destination }) {
  const t0 = ctx.currentTime + startTime;
  const frames = Math.ceil(duration * ctx.sampleRate);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(startFreq, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + duration);

  // Makeup gain, and not a fudge: a bandpass of centre f0 and quality Q passes
  // a band of width f0/Q, so the noise *power* through it falls as 1/Q and the
  // amplitude as 1/sqrt(Q). Without compensating, "Level 0.5" means something
  // completely different on a sweep than on a tone, and raising Q — which the
  // author does to make a whistle rather than wind — silences the layer as a
  // side effect of a control that says nothing about volume.
  //
  // The constant on top covers the rest of the gap: a lowpass passes
  // everything below its cutoff, so `noise` starts with far more of the
  // spectrum than any bandpass ever has. Measured against the other layer
  // kinds at matched Level rather than derived, and it only has to put them
  // in the same ballpark — the Level slider does the fine work.
  const makeup = Math.sqrt(Math.max(0.0001, q)) * 3.2;
  // Clamped to full scale, and this is the honest part: the loss *cannot* be
  // fully recovered. RMS and peak are different quantities — a narrow band has
  // little energy but its peak is still bounded by 1 — so past a point the
  // makeup would only drive the envelope past full scale and clip, which on
  // bandpassed noise is audible distortion rather than loudness. Measured
  // RMS at Level 0.4, Q 4: 0.006 uncompensated, 0.016 compensated and clamped,
  // against 0.032 for `noise` and ~0.054 for `tone`/`fm`. (An unclamped
  // version measured 0.027 — *higher* than the clamped one, because clipping
  // adds distortion energy. Louder and worse.)
  // A high-Q sweep stays quieter than a broadband layer, which is what a
  // narrow filter physically does; the Level slider and the recipe's overall
  // gain are where an author makes up the rest.
  const peak = Math.min(1, gain * makeup);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  source.connect(filter);
  filter.connect(env);
  env.connect(destination ?? ctx.destination);
  source.start(t0);
  return { source, filter, env };
}

/**
 * A tone gated by an LFO on its own gain — tremolo at low depth, hard on/off
 * at high depth.
 *
 * The family this unlocks is defined by *rhythm* rather than timbre: alarms,
 * klaxons, geiger ticks, engine idle chug, radio squelch. No envelope on a
 * single `tone` can produce a repeating pattern, and building one as N layers
 * would spend the whole eight-layer budget on a four-beep alert.
 *
 * The LFO is offset so it oscillates between `1 - depth` and `1` rather than
 * around zero: at depth 1 that is full gating, at 0 it is a steady tone, and
 * the control stays meaningful across its whole range.
 */
function pulseTone(ctx, { wave, hz, rateHz, depth, duration, gain, startTime = 0, destination }) {
  const t0 = ctx.currentTime + startTime;

  const osc = ctx.createOscillator();
  osc.type = wave;
  osc.frequency.setValueAtTime(hz, t0);

  const gate = ctx.createGain();
  gate.gain.value = 1 - depth;

  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = rateHz;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = depth * 0.5;
  lfo.connect(lfoDepth);
  lfoDepth.connect(gate.gain);

  // A gentle overall envelope on top, so the pulse train still fades rather
  // than stopping mid-cycle with a click.
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.02, duration * 0.1));
  env.gain.setValueAtTime(gain, t0 + duration * 0.8);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(gate);
  gate.connect(env);
  env.connect(destination ?? ctx.destination);
  lfo.start(t0);
  osc.start(t0);
  lfo.stop(t0 + duration + 0.02);
  osc.stop(t0 + duration + 0.02);
  return { osc, lfo, env };
}

/**
 * N short pitch ramps in a row — birds, UI trills, radio blips, data bursts.
 *
 * Built as one layer with a repeat count rather than N `tone` layers so a
 * twelve-blip burst costs one of the eight layers a recipe is allowed, not
 * twelve. The repeats share a single oscillator, restarting the pitch ramp
 * and the envelope each cycle.
 */
function chirpTone(ctx, { wave, startHz, endHz, repeats, duration, gain, startTime = 0, destination }) {
  const t0 = ctx.currentTime + startTime;
  const each = duration / repeats;
  // A gap keeps the blips distinct; without it a high repeat count smears
  // into one continuous glide and the control appears to do nothing.
  const sound = each * 0.6;

  const osc = ctx.createOscillator();
  osc.type = wave;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);

  for (let i = 0; i < repeats; i++) {
    const at = t0 + i * each;
    osc.frequency.setValueAtTime(startHz, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), at + sound);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + Math.min(0.004, sound * 0.2));
    env.gain.exponentialRampToValueAtTime(0.0001, at + sound);
  }

  osc.connect(env);
  env.connect(destination ?? ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
  return { osc, env };
}

// ---------------------------------------------------------------------------
// Radio
// ---------------------------------------------------------------------------

/**
 * The three artifacts the team radio plays around each spoken line.
 *
 * These carry more weight than a normal cue. The voice itself is browser TTS,
 * which **cannot be routed into Web Audio at all** — no filter, no position,
 * no mixer (see audio/radio.js). So these three are the only part of the radio
 * that can actually be shaped, and they are what make a dry system voice read
 * as a transmission rather than as a screen reader.
 *
 * Band-limited to roughly a voice channel on purpose: 300Hz-3kHz is the range
 * a real radio passes, and it is that restriction — not the noise — that the
 * ear identifies as "radio".
 *
 * Built-in generators rather than recipes shipped in the editor, so the radio
 * has a sound out of the box. A recipe bound to `radioOpen`/`radioStatic`/
 * `radioClose` still overrides them, exactly as it does for every other
 * built-in.
 */
export function radioOpen() {
  return bake(0.14, (ctx) => {
    // The click of a carrier appearing: a short burst with a hard attack.
    noiseBurst(ctx, { duration: 0.07, startFreq: 3000, endFreq: 900, attack: 0.001, gain: 0.5 });
    tone(ctx, { wave: 'square', startHz: 1800, endHz: 900, duration: 0.04, attack: 0.001, gain: 0.22 });
  });
}

/**
 * The bed that runs under a line. Deliberately quiet and deliberately short —
 * it is played once per utterance rather than looped, because a loop would
 * need stopping and the one thing this system cannot rely on is being told
 * when an utterance ended (`onend` never fires when there is no voice).
 */
export function radioStatic() {
  return bake(1.6, (ctx) => {
    const frames = Math.ceil(1.6 * ctx.sampleRate);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass, not lowpass: the narrow passband is the whole cue. A lowpassed
    // hiss sounds like wind; a bandpassed one sounds like a channel.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1400;
    band.Q.value = 0.9;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, ctx.currentTime);
    env.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 0.05);
    env.gain.setValueAtTime(0.16, ctx.currentTime + 1.4);
    env.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.6);

    source.connect(band);
    band.connect(env);
    env.connect(ctx.destination);
    source.start();
  });
}

/** The channel closing — shorter and duller than the open, as a real squelch
 * tail is: the carrier drops before the noise gate does. */
export function radioClose() {
  return bake(0.12, (ctx) => {
    noiseBurst(ctx, { duration: 0.05, startFreq: 1800, endFreq: 400, attack: 0.001, gain: 0.34 });
  });
}

// ---------------------------------------------------------------------------
// Authored sounds
// ---------------------------------------------------------------------------

/**
 * Last-ditch ceilings, matching `MAX_DURATION` / `MAX_LAYERS` in
 * `src/sound/soundSchema.js`. Restated here rather than imported so this file
 * keeps its one useful property — pure DSP with no dependency on the editor —
 * and so a bad recipe that somehow slipped past validation still cannot ask
 * for an unbounded allocation.
 */
const BAKE_DURATION_CEILING = 6;
const BAKE_LAYER_CEILING = 8;

/**
 * Render a sound *recipe* — the data model in `src/sound/soundRecipe.js` —
 * into a buffer, through the exact same `bake()` / `noiseBurst()` / `tone()`
 * the sixteen built-in generators above use.
 *
 * This is deliberately a thin interpreter and nothing more. Every layer field
 * is passed straight through to a primitive, so a sound the editor emits is
 * playable by construction and the editor's preview cannot disagree with what
 * the match plays: there is one synthesis path, not a preview one and a real
 * one. It is also why adding a new layer type is a change in exactly two
 * places — the `SOUND_GROUPS` schema and the switch below.
 *
 * The one thing this does that the built-ins don't is *not* vary: no
 * `variedSeed()` jitter. An author dragging a slider needs the change they
 * hear to be the change they made, and per-play variation would mask small
 * edits behind noise. Variation for authored sounds is a per-play concern
 * `audio.js` can add later on top of a stable bake, which is the right place
 * for it anyway.
 *
 * Bounds are the caller's job — `validateRecipe` runs on the editor's output
 * *and* on the server, because `duration * SAMPLE_RATE` is an allocation and a
 * recipe can arrive from another player. This function assumes it has been
 * checked, and clamps only as a last-ditch guard so a bug upstream degrades
 * into a short sound rather than an out-of-memory.
 *
 * @param {object} recipe a validated recipe
 * @param {number} duration total render length in seconds, from `recipeDuration()`
 * @returns {Promise<AudioBuffer>}
 */
export function bakeRecipe(recipe, duration) {
  const total = Math.min(BAKE_DURATION_CEILING, Math.max(0.02, Number(duration) || 0.5));
  const master = Math.min(1, Math.max(0, Number(recipe?.gain) ?? 1));
  const layers = (recipe?.layers ?? []).slice(0, BAKE_LAYER_CEILING);

  return bake(total, (ctx) => {
    for (const layer of layers) {
      // Gains multiply rather than replace: the recipe's overall level is a
      // trim over the mix the author balanced, so moving it keeps the
      // relative weight of the layers intact.
      const gain = Math.min(1, Math.max(0, (Number(layer.gain) || 0) * master));
      if (gain <= 0) continue;
      const startTime = Math.max(0, Number(layer.startTime) || 0);
      const length = Math.max(0.01, Math.min(total - startTime, Number(layer.duration) || 0.1));
      if (length <= 0) continue;

      const attack = Math.max(0.0005, Number(layer.attack) || 0.005);

      switch (layer.kind) {
        case 'tone':
          tone(ctx, {
            wave: layer.wave ?? 'sine',
            startHz: Math.max(1, Number(layer.startHz) || 220),
            endHz: Math.max(1, Number(layer.endHz) || 220),
            duration: length,
            attack,
            gain,
            startTime,
          });
          break;

        case 'fm':
          fmTone(ctx, {
            wave: layer.wave ?? 'sine',
            startHz: Math.max(1, Number(layer.startHz) || 220),
            endHz: Math.max(1, Number(layer.endHz) || 220),
            ratio: Math.max(0.01, Number(layer.ratio) || 1),
            index: Math.max(0, Number(layer.index) || 0),
            duration: length,
            attack,
            gain,
            startTime,
          });
          break;

        case 'sweep':
          noiseSweep(ctx, {
            duration: length,
            startFreq: Math.max(20, Number(layer.startFreq) || 400),
            endFreq: Math.max(20, Number(layer.endFreq) || 4000),
            q: Math.max(0.0001, Number(layer.q) || 1),
            attack,
            gain,
            startTime,
          });
          break;

        case 'pulse':
          pulseTone(ctx, {
            wave: layer.wave ?? 'square',
            hz: Math.max(1, Number(layer.startHz) || 440),
            rateHz: Math.max(0.01, Number(layer.rateHz) || 8),
            depth: Math.min(1, Math.max(0, Number(layer.depth) ?? 1)),
            duration: length,
            gain,
            startTime,
          });
          break;

        case 'chirp':
          chirpTone(ctx, {
            wave: layer.wave ?? 'sine',
            startHz: Math.max(1, Number(layer.startHz) || 2000),
            endHz: Math.max(1, Number(layer.endHz) || 4000),
            // Rounded and floored at 1: a fractional or zero repeat count
            // divides the duration into nonsense and yields silence.
            repeats: Math.max(1, Math.round(Number(layer.repeats) || 1)),
            duration: length,
            gain,
            startTime,
          });
          break;

        default: {
          // `noise`, and anything unrecognised — validateRecipe rejects an
          // unknown kind, so reaching here with one means a bug upstream, and
          // a plain noise burst is the safest thing to make of it.
          //
          // `noiseBurst` has no `startTime` — it always begins at
          // `ctx.currentTime`, which in an offline context is 0. Rather than
          // change a primitive five shipped sounds depend on, a delayed noise
          // layer is routed through a DelayNode. Same audible result, and the
          // built-ins' code path is untouched.
          let destination = ctx.destination;
          if (startTime > 0) {
            const delay = ctx.createDelay(BAKE_DURATION_CEILING);
            delay.delayTime.value = startTime;
            delay.connect(ctx.destination);
            destination = delay;
          }
          noiseBurst(ctx, {
            duration: length,
            startFreq: Math.max(20, Number(layer.startFreq) || 3000),
            endFreq: Math.max(20, Number(layer.endFreq) || 200),
            attack: Math.max(0.0005, Number(layer.attack) || 0.004),
            gain,
            destination,
          });
        }
      }
    }
  });
}
