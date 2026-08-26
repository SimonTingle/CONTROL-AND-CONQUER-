import * as THREE from 'three';
import * as synth from './synth.js';

/**
 * The spatial audio engine: one `AudioListener` on the camera, a pooled set
 * of `PositionalAudio` voices, and a small `playAt`/`playLoopAt` API.
 *
 * This is the only file in `src/audio/` that touches THREE or the scene
 * graph — `synth.js` is pure DSP with no idea sound has a position at all.
 *
 * ## Binaural panning is not implemented here — it's inherited
 *
 * `THREE.AudioListener` extends `Object3D`. Adding it as a child of `camera`
 * means it inherits the camera's position and orientation automatically
 * every time the camera's matrix updates — which `ChaseCamera.update` and
 * `MapControls.update` already do every frame in `main.js`'s `renderTick`.
 * No per-frame listener code is needed here beyond the one-time `add()` in
 * `initAudio`.
 *
 * Each `PositionalAudio` voice wraps a native Web Audio `PannerNode`. Setting
 * `panningModel = 'HRTF'` is what makes a sound behind the camera actually
 * sound different from one in front of it — genuine binaural spatialization,
 * computed by the browser's audio thread, not by any code in this file.
 * `refDistance`/`rolloffFactor`/`maxDistance` give the distance falloff the
 * same way. This file's job is entirely: pick where to put the sound, pick
 * which buffer to play through it, and keep a bounded number of voices alive
 * regardless of battle size.
 *
 * ## Pooling
 *
 * Mirrors `render/projectileFx.js`'s pattern deliberately: a fixed-size array
 * of reusable nodes, oldest-voice stealing when the pool is exhausted rather
 * than growing unbounded. A dropped voice costs nothing correctness-wise —
 * sound is presentation, exactly like the projectile pool it's copied from.
 */

/** Concurrent one-shot voices. Lower on a device autoQuality has already
 * judged as struggling — see `setLowPower`. */
const VOICE_POOL_SIZE = 24;
const VOICE_POOL_SIZE_LOW = 10;

/** One persistent loop voice per visible vehicle engine, capped the same way. */
const LOOP_POOL_SIZE = 16;
const LOOP_POOL_SIZE_LOW = 6;

let ctx = null;
let listener = null;
let scene = null;

let voices = []; // { audio: THREE.PositionalAudio, busyUntil }
let nextVoice = 0;
let globalVoices = []; // { audio: THREE.Audio }
let nextGlobalVoice = 0;
let loops = new Map(); // key -> { audio, engine, group }
let lowPower = false;

// --- adjustable levels, surfaced as sliders in ui/controlSchema.js's Sound
// section. Each is independent: master sits on the listener (everything
// downstream of it), the other three scale one category apiece. ---
let masterVolume = 0.9;
let effectsVolume = 1;
let engineVolume = 0.15;
// Deliberately low by default — this is meant to read as wind under
// everything else, not compete with it. The slider gives headroom back up
// to 1 for anyone who wants it more present.
let ambienceVolume = 0.10;
/** Base level the day/night crossfade scales from, before ambienceVolume. */
const AMBIENCE_BASE = 0.16;

let ambienceSegmentsPlayed = 0; // debug counter — see debugState()
let dayBed = null; // AmbienceBed
let nightBed = null;
let lastNightFactor = 0;

/** Cached baked buffers, keyed `${id}:${variation}`. Synthesis runs once per
 * distinct key and is reused for every subsequent play. */
const bufferCache = new Map();
/** In-flight bakes, so two shots fired the same frame don't double-render. */
const bakingPromises = new Map();

const GENERATORS = {
  weaponFire: (p) => synth.weaponFire(p?.calibre),
  explosionGround: (p) => synth.explosion(p?.intensity, true),
  explosionHull: (p) => synth.explosion(p?.intensity, false),
  destroyed: (p) => synth.destroyed(p?.scale),
  harvestScoop: () => synth.harvestScoop(),
  harvestDeliver: () => synth.harvestDeliver(),
  coinPickup: () => synth.coinPickup(),
  coinSpawn: () => synth.coinSpawn(),
  uiConfirm: () => synth.uiConfirm(),
  uiCancel: () => synth.uiCancel(),
  uiRefused: () => synth.uiRefused(),
  structureComplete: () => synth.structureComplete(),
  matchStart: () => synth.matchStart(),
  victory: () => synth.victory(),
  defeat: () => synth.defeat(),
  notification: () => synth.notification(),
};

/**
 * How far each category should carry, and how it falls off. Tuned against
 * `ChaseCamera.MAX_DISTANCE` (160 units, chaseCamera.js) as the "far but the
 * camera can still get there" edge — a category expected to be heard across
 * roughly that whole span gets a `maxDistance` near it; a small UI/economy
 * tick that only matters up close gets a much shorter one.
 */
const FALLOFF = {
  weaponFire: { refDistance: 14, rolloffFactor: 1.4, maxDistance: 260 },
  explosionGround: { refDistance: 20, rolloffFactor: 1.1, maxDistance: 340 },
  explosionHull: { refDistance: 20, rolloffFactor: 1.1, maxDistance: 340 },
  destroyed: { refDistance: 26, rolloffFactor: 1, maxDistance: 400 },
  default: { refDistance: 10, rolloffFactor: 1.6, maxDistance: 140 },
};

function falloffFor(id) {
  return FALLOFF[id] ?? FALLOFF.default;
}

/** Seconds of overlap between one segment ending and the next beginning —
 * long enough to be inaudible as a seam, short enough not to smear two
 * different LFO wobbles together into mush. */
const AMBIENCE_CROSSFADE = 0.6;

/**
 * One ambience bed (day or night): a *chain* of freshly-synthesized segments,
 * never a looped buffer.
 *
 * `Audio.setLoop(true)` was the obvious way to keep a bed playing forever,
 * and is deliberately not used anywhere in this class. A loop, however long,
 * is a fixed recording that eventually repeats itself to a listener who
 * stays long enough — which is exactly what "generative, not a loop" rules
 * out. Instead this alternates between two `THREE.Audio` voices: while one
 * plays out its segment, the other bakes and starts the *next* one
 * (`synth.ambienceSegment` rerolls its own parameters every call — see that
 * function's header), overlapped by `AMBIENCE_CROSSFADE` so the handoff is a
 * fade, not a click. Each voice schedules its own successor from its
 * `ended` event, so the chain is self-driving — nothing in `renderTick`
 * pumps it, the same "reacts to its own completion" shape
 * `ui/creditBurst.js`'s DOM particles already use via `animationend`.
 *
 * `level` is the bed's own target volume, in [0, 1] before the day/night
 * crossfade and the `ambienceVolume` slider are applied by `updateAmbience` —
 * this class only ever multiplies its two voices' gains by `level`, it
 * doesn't know why that number is what it is.
 */
class AmbienceBed {
  constructor(kind) {
    this.kind = kind;
    this.level = 0;
    this.voices = [new THREE.Audio(listener), new THREE.Audio(listener)];
    this.active = 0; // index into this.voices currently the louder one
    this.stopped = false;
    this._playSegment(this.active);
  }

  setLevel(level) {
    this.level = level;
    // The buffer's own fade in/out (synth.js's `ambienceSegment`) is baked
    // into the sample data at render time, not driven by this live gain node
    // — so there's no competing automation here to fight, and every playing
    // voice can simply be set to the new level directly.
    for (const v of this.voices) {
      if (v.isPlaying) v.setVolume(this.level);
    }
  }

  _playSegment(index) {
    if (this.stopped) return;
    const voice = this.voices[index];
    synth.ambienceSegment(this.kind).then((buffer) => {
      if (this.stopped) return;
      ambienceSegmentsPlayed++;
      voice.setBuffer(buffer);
      voice.setVolume(this.level);
      voice.play();

      // Schedule the *other* voice's next segment to start shortly before
      // this one ends, so the two overlap by AMBIENCE_CROSSFADE instead of
      // leaving a gap — a real gap would be as audible as a loop seam, just
      // silent instead of a click.
      const nextAt = Math.max(0, buffer.duration - AMBIENCE_CROSSFADE) * 1000;
      this._timer = setTimeout(() => {
        if (this.stopped) return;
        this.active = 1 - index;
        this._playSegment(this.active);
      }, nextAt);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._timer);
    for (const v of this.voices) {
      if (v.isPlaying) v.stop();
    }
  }
}

/**
 * One-time setup: attaches the listener to the camera and builds the voice
 * pool. Call once, after `camera` exists.
 *
 * Web Audio requires a user gesture before it will produce sound in most
 * browsers (iOS Safari enforces this strictly). `initAudio` creates the
 * (suspended) context immediately so buffers can bake ahead of time; actual
 * playback is silent until `resume()` runs from a real pointer event.
 */
export function initAudio(camera, worldScene) {
  scene = worldScene;
  ctx = THREE.AudioContext.getContext();
  listener = new THREE.AudioListener();
  camera.add(listener);
  // Master volume lives on the listener itself (every PositionalAudio's own
  // gain node connects straight to listener.getInput()), so a separate gain
  // node here would sit outside every voice's signal path and do nothing.
  listener.setMasterVolume(masterVolume);

  voices = [];
  for (let i = 0; i < VOICE_POOL_SIZE; i++) {
    const audio = new THREE.PositionalAudio(listener);
    audio.setVolume(1);
    scene.add(audio);
    voices.push({ audio, busyUntil: 0 });
  }

  // A small non-positional pool for cues with no meaningful world position —
  // match start/victory/defeat, a generic notification pop. These should
  // reach the player regardless of where the camera happens to be looking,
  // so they skip PositionalAudio's panner/distance model entirely rather
  // than being placed at some arbitrary point (the camera itself, say) that
  // would make them fall silent the moment the camera panned away.
  globalVoices = [];
  for (let i = 0; i < 4; i++) {
    const a = new THREE.Audio(listener);
    globalVoices.push(a);
  }

  // Two always-running ambience beds — day and night — crossfaded against
  // each other by `updateAmbience` so the transition through dusk is a fade,
  // not a cut. Each bed is its own AmbienceBed, a chain of freshly-synthesized
  // segments rather than one buffer on `Audio.setLoop(true)` — see
  // AmbienceBed's own header for why that distinction is the point.
  dayBed = new AmbienceBed('day');
  nightBed = new AmbienceBed('night');
}

/**
 * Crossfade the ambience beds by sun elevation. `night` is expected to be the
 * caller's own `nightFactor(elevation)` (render/projectileFx.js) — the same
 * 0..1 curve already shared by the shadow/glow cross-fade and the headlight
 * gate, so ambience agrees with everything else about when night has started
 * rather than running its own threshold.
 */
export function updateAmbience(night) {
  lastNightFactor = night;
  if (!dayBed || !nightBed) return;
  const level = AMBIENCE_BASE * ambienceVolume;
  dayBed.setLevel((1 - night) * level);
  nightBed.setLevel(night * level);
}

/**
 * Resume the (possibly suspended) `AudioContext`. Wire this to the first
 * pointer/touch event on the canvas — the game already gates its first real
 * interaction behind a click (unit selection, build placement), so this adds
 * no new friction, just needs to run before the first sound is expected.
 */
export function resume() {
  if (ctx?.state === 'suspended') ctx.resume();
}

/**
 * Shrink the voice/loop budget and drop to equalpower panning (stereo pan +
 * distance, no HRTF convolution — cheaper, loses front/back disambiguation)
 * on a device `autoQuality` has already judged as struggling. Called from
 * the same place `main.js` reads `autoQuality.low`, not on a separate timer —
 * one quality signal, not two.
 */
export function setLowPower(low) {
  lowPower = low;
}

// --- volume controls, surfaced in ui/controlSchema.js's Sound section ---
// Each pair follows the `get`/`set` shape every other controlSchema.js entry
// already expects, so the slider factory there needs no special case for
// audio at all.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function getMasterVolume() {
  return masterVolume;
}
export function setMasterVolume(v) {
  masterVolume = clamp01(v);
  listener?.setMasterVolume(masterVolume);
}

export function getEffectsVolume() {
  return effectsVolume;
}
export function setEffectsVolume(v) {
  effectsVolume = clamp01(v);
}

export function getEngineVolume() {
  return engineVolume;
}
export function setEngineVolume(v) {
  engineVolume = clamp01(v);
  // Applied live, not just to future loops — a vehicle already driving
  // shouldn't have to stop and restart its engine to pick up the new level.
  // Scaled by each loop's own presence, same as updateEngineLoop, so
  // dragging this slider while a vehicle is parked doesn't audibly un-mute
  // it — presence, not this slider, decides whether it's parked or not.
  for (const loop of loops.values()) loop.audio.setVolume(engineVolume * loop.presence);
}

export function getAmbienceVolume() {
  return ambienceVolume;
}
export function setAmbienceVolume(v) {
  ambienceVolume = clamp01(v);
  // Re-apply immediately against whatever elevation updateAmbience was last
  // called with, rather than waiting for the next render frame's call —
  // the slider should react the instant it's dragged.
  updateAmbience(lastNightFactor);
}

function voicePoolSize() {
  return lowPower ? VOICE_POOL_SIZE_LOW : VOICE_POOL_SIZE;
}

function loopPoolSize() {
  return lowPower ? LOOP_POOL_SIZE_LOW : LOOP_POOL_SIZE;
}

async function bufferFor(id, params) {
  const generator = GENERATORS[id];
  if (!generator) return null;
  // A handful of baked variants per id, picked at random on each play — see
  // synth.js's header on why a repeated cue needs this to avoid sounding like
  // a looped sample. Cached forever once rendered.
  const variation = Math.floor(synth.variedSeed() * 3);
  const key = `${id}:${variation}`;
  if (bufferCache.has(key)) return bufferCache.get(key);
  if (bakingPromises.has(key)) return bakingPromises.get(key);

  const promise = generator(params).then((buffer) => {
    bufferCache.set(key, buffer);
    bakingPromises.delete(key);
    return buffer;
  });
  bakingPromises.set(key, promise);
  return promise;
}

/**
 * Play a one-shot sound at a world position.
 *
 * @param {string} id a key in GENERATORS
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {object} [params] passed to the synth generator (e.g. `{calibre}`)
 * @param {number} [gain=1] extra linear scale on top of the generator's own level
 */
export function playAt(id, x, y, z, params, gain = 1) {
  if (!ctx || ctx.state !== 'running') return;
  const size = voicePoolSize();

  // Pick the least-recently-used slot within the (possibly shrunk) budget
  // rather than always advancing round-robin over the full pool — the low-
  // power cap needs this to actually reduce concurrent voices, not just
  // which indices get reused.
  let slot = nextVoice % size;
  nextVoice = (nextVoice + 1) % size;
  const voice = voices[slot];
  if (!voice) return;

  bufferFor(id, params).then((buffer) => {
    if (!buffer) return;
    const { audio } = voice;
    if (audio.isPlaying) audio.stop();
    audio.setBuffer(buffer);
    const f = falloffFor(id);
    audio.setRefDistance(f.refDistance);
    audio.setRolloffFactor(f.rolloffFactor);
    audio.setMaxDistance(f.maxDistance);
    audio.panner.panningModel = lowPower ? 'equalpower' : 'HRTF';
    audio.setVolume(Math.min(1, gain * effectsVolume));
    audio.position.set(x, y, z);
    audio.play();
    voice.busyUntil = ctx.currentTime + buffer.duration;
  });
}

/**
 * Play a one-shot sound with no world position — match framing stings and
 * generic notifications. See the pool built in `initAudio` for why these
 * skip `PositionalAudio` rather than being placed at a fixed point.
 */
export function playGlobal(id, params, gain = 1) {
  if (!ctx || ctx.state !== 'running' || globalVoices.length === 0) return;
  const a = globalVoices[nextGlobalVoice];
  nextGlobalVoice = (nextGlobalVoice + 1) % globalVoices.length;

  bufferFor(id, params).then((buffer) => {
    if (!buffer) return;
    if (a.isPlaying) a.stop();
    a.setBuffer(buffer);
    a.setVolume(Math.min(1, gain * effectsVolume));
    a.play();
  });
}

/** speedFrac at or below this counts as "stopped" for the presence ramp
 * below — not exactly 0, since a vehicle very nearly stationary (rolling to
 * a halt, or nudged by a collision) shouldn't sit right on the boundary and
 * flicker between ramping up and down. */
const ENGINE_STOP_EPS = 0.02;
/** Seconds for presence to ramp fully 0->1 or 1->0. Long enough to read as a
 * fade, short enough that tapping the throttle doesn't feel sluggish. */
const ENGINE_RAMP_SECONDS = 0.8;

/**
 * One ramp step toward silence (stopped) or full presence (moving).
 * Extracted as a pure function — no THREE, no AudioContext, no module state
 * — specifically so the ramp's own arithmetic (the stop gate, the linear
 * rate, the clamp toward the target) can be unit tested without a real
 * `PositionalAudio` loop, which `node --test` has no way to construct.
 *
 * @param {number} presence current value, 0..1
 * @param {number} speedFrac 0..1
 * @param {number} dt real frame seconds
 * @returns {number} the next presence, 0..1
 */
export function stepEnginePresence(presence, speedFrac, dt) {
  const target = speedFrac > ENGINE_STOP_EPS ? 1 : 0;
  const step = dt / ENGINE_RAMP_SECONDS;
  return target > presence ? Math.min(target, presence + step) : Math.max(target, presence - step);
}

/**
 * How much a value must move before it is worth scheduling an automation event
 * for it.
 *
 * `updateEngineLoop` used to write volume, position and speed unconditionally
 * on every frame for every loop. Each of those writes schedules AudioParam
 * automation — `setVolume` one event, `setSpeed` four — and three.js schedules
 * six more per loop from inside `renderer.render()` when it updates the
 * panner. Measured on a 40-vehicle benchmark scene with every vehicle parked
 * and silent: **229.7 AudioParam events per frame, 14.4 per engine loop**,
 * ~13,800/second at 60fps, to describe a fleet that was not moving and could
 * not be heard. See docs/plans/fps-regression.md.
 *
 * The thresholds are chosen to be inaudible rather than merely small: a
 * volume step of 1e-3 is roughly -60dB of change, and 1cm of position is far
 * below what the panner can resolve at this scale.
 */
const ENGINE_VOLUME_EPS = 1e-3;
const ENGINE_SPEED_EPS = 1e-3;
const ENGINE_POSITION_EPS_SQ = 1e-4; // (1cm)^2

/**
 * Which of an engine loop's three parameters actually need writing this frame.
 *
 * Pure and exported for the same reason `stepEnginePresence` is: this is the
 * arithmetic worth testing, and `node --test` cannot construct a
 * `PositionalAudio` to test it through. `last` is null on a loop's first
 * update, where everything must be written to establish a baseline.
 *
 * Each field is compared against the last value *actually written*, not the
 * last value seen. That matters: comparing against the last seen value would
 * let a slow drift — a vehicle creeping at a hundredth of the threshold per
 * frame — never accumulate enough to trigger a write, and the voice would
 * silently detach from the thing it is supposed to be following.
 */
export function engineWritesNeeded(last, next) {
  if (!last) return { volume: true, speed: true, position: true };
  const dx = next.x - last.x;
  const dy = next.y - last.y;
  const dz = next.z - last.z;
  return {
    volume: Math.abs(next.volume - last.volume) > ENGINE_VOLUME_EPS,
    speed: Math.abs(next.speedFrac - last.speedFrac) > ENGINE_SPEED_EPS,
    position: dx * dx + dy * dy + dz * dz > ENGINE_POSITION_EPS_SQ,
  };
}

/**
 * Seconds a loop must sit fully silent before its nodes are released.
 *
 * Not zero, because a vehicle that stops for a moment at a waypoint and drives
 * on would otherwise tear down and rebuild five audio nodes on consecutive
 * frames. Long enough to cover that; short enough that a parked fleet stops
 * costing anything well inside a normal match.
 */
const ENGINE_IDLE_RELEASE_SECONDS = 2;

/**
 * Whether a silent loop has been silent long enough to release outright.
 *
 * Muting a loop is not the same as stopping it. A loop at presence 0 still has
 * two sawtooth oscillators running through a biquad and an HRTF panner —
 * convolving, every audio quantum, to produce silence — and still takes six
 * panner automation events per frame from three.js because it is still in the
 * scene. Releasing it is what actually reclaims that; `updateEngineLoop`
 * rebuilds it the moment the vehicle moves again.
 */
export function shouldReleaseIdleLoop(presence, speedFrac, idleSeconds) {
  return presence <= 0 && speedFrac <= ENGINE_STOP_EPS && idleSeconds >= ENGINE_IDLE_RELEASE_SECONDS;
}

/**
 * Start (or update) a continuous looped sound anchored to a moving object —
 * an engine. `key` identifies the loop across calls (a vehicle's id); calling
 * again with the same key updates its position and speed rather than
 * starting a second voice.
 *
 * The loop's actual volume is `engineVolume * presence`, not a flat
 * `engineVolume` — `presence` is a per-loop 0..1 value this function ramps
 * toward 1 while the vehicle is moving and toward 0 while it's stationary,
 * so a parked vehicle goes fully silent instead of idling at
 * `engineGraph`'s own idle floor (which never reaches 0 — see its header).
 * A new loop starts at presence 0 and fades in on its first few calls even
 * if the vehicle is already moving, the same "nothing pops in at full
 * volume" rule every other voice in this file already follows.
 *
 * @param {string|number} key stable per emitting entity
 * @param {THREE.Object3D} anchor followed every call — read, never retained
 *   across ticks in the sense CLAUDE.md warns about: this only ever reads
 *   `anchor.position` on the same call that receives it, never caches the
 *   object itself as "the current position" between calls without re-reading
 * @param {number} baseHz idle pitch
 * @param {number} speedFrac 0..1
 * @param {number} dt real frame time, to integrate the presence ramp — this
 *   is render-only presentation, so it follows the same rule
 *   `render/projectileFx.js`'s effects do and uses wall-clock frame time,
 *   never simulated time.
 */
export function updateEngineLoop(key, anchor, baseHz, speedFrac, dt) {
  if (!ctx || ctx.state !== 'running') return;
  let loop = loops.get(key);

  if (!loop) {
    // A stationary vehicle gets no voice at all. `stepEnginePresence` already
    // ramps a stopped engine to silence (that was the point of "silence engine
    // when parked"), so building the graph here would spend a pool slot, two
    // running oscillators, an HRTF panner and ~14 automation events a frame to
    // render nothing audible. Deferring creation until something actually moves
    // is also what stops the idle release below from thrashing: without this
    // guard a released loop would be rebuilt on the very next frame.
    if (speedFrac <= ENGINE_STOP_EPS) return;
    if (loops.size >= loopPoolSize()) return; // budget exhausted; silently skip
    const audio = new THREE.PositionalAudio(listener);
    const f = falloffFor('default');
    audio.setRefDistance(14);
    audio.setRolloffFactor(1.5);
    audio.setMaxDistance(180);
    audio.panner.panningModel = lowPower ? 'equalpower' : 'HRTF';
    scene.add(audio);

    const engine = synth.engineGraph(ctx, baseHz);
    audio.setNodeSource(engine.output);

    // `last` holds the values most recently *written* to the audio graph, so
    // the dirty check below has a baseline. `idleSeconds` accrues only while
    // fully silent and stopped.
    loop = { audio, engine, presence: 0, last: null, idleSeconds: 0 };
    loops.set(key, loop);
  }

  loop.presence = stepEnginePresence(loop.presence, speedFrac, dt);

  const stopped = speedFrac <= ENGINE_STOP_EPS;
  loop.idleSeconds = loop.presence <= 0 && stopped ? loop.idleSeconds + dt : 0;
  if (shouldReleaseIdleLoop(loop.presence, speedFrac, loop.idleSeconds)) {
    stopEngineLoop(key);
    return;
  }

  const pos = anchor.position;
  const volume = engineVolume * loop.presence;
  const next = { volume, speedFrac, x: pos.x, y: pos.y, z: pos.z };
  const writes = engineWritesNeeded(loop.last, next);

  // Each baseline advances only when that parameter was actually written — see
  // engineWritesNeeded's note on why comparing against the last *seen* value
  // would let a slow drift go unnoticed forever.
  if (!loop.last) loop.last = { volume: 0, speedFrac: 0, x: 0, y: 0, z: 0 };
  if (writes.volume) {
    loop.audio.setVolume(volume);
    loop.last.volume = volume;
  }
  if (writes.position) {
    loop.audio.position.copy(pos);
    loop.last.x = pos.x;
    loop.last.y = pos.y;
    loop.last.z = pos.z;
  }
  if (writes.speed) {
    loop.engine.setSpeed(speedFrac);
    loop.last.speedFrac = speedFrac;
  }
}

/** Stop and release a loop voice — call when its vehicle is destroyed/removed. */
export function stopEngineLoop(key) {
  const loop = loops.get(key);
  if (!loop) return;
  loop.engine.stop();
  loop.audio.disconnect();
  scene?.remove(loop.audio);
  loops.delete(key);
}

/** All active loops' keys, so a caller can reap ones whose vehicle is gone
 * without this module needing to know what a vehicle is. */
export function activeLoopKeys() {
  return [...loops.keys()];
}

/** Debug/e2e-smoke-test inspection — not read by any gameplay code. */
export function debugState() {
  return {
    contextState: ctx?.state ?? 'uninitialized',
    voiceCount: voices.length,
    playingVoices: voices.filter((v) => v.audio.isPlaying).length,
    loopCount: loops.size,
    cachedBuffers: bufferCache.size,
    // Rises for as long as the ambience beds run, confirming they're being
    // continuously replaced with fresh segments rather than looping one —
    // "not looping" isn't otherwise observable from outside this module.
    ambienceSegmentsPlayed,
    volumes: {
      master: masterVolume,
      effects: effectsVolume,
      engine: engineVolume,
      ambience: ambienceVolume,
    },
    // Per-loop presence — the stop/start ramp updateEngineLoop drives. Not
    // otherwise observable from outside this module; this is what a smoke
    // test watches to confirm a parked vehicle actually reaches 0 rather
    // than idling at some nonzero floor.
    enginePresence: Object.fromEntries([...loops].map(([key, loop]) => [key, loop.presence])),
  };
}
