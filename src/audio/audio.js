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
let dayAmbience = null; // THREE.Audio, looping
let nightAmbience = null;
let loops = new Map(); // key -> { audio, engine, group }
let lowPower = false;

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
  listener.setMasterVolume(0.9);

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

  // Two always-playing, looping ambience beds — day and night — crossfaded
  // by `updateAmbience` rather than swapped, so the transition through dusk
  // is a fade rather than a cut. Both start baking immediately; playback
  // (silent until resume()) begins with volume at 0 and is raised once the
  // first `updateAmbience` call knows the actual sun elevation.
  dayAmbience = new THREE.Audio(listener);
  nightAmbience = new THREE.Audio(listener);
  dayAmbience.setLoop(true);
  nightAmbience.setLoop(true);
  dayAmbience.setVolume(0);
  nightAmbience.setVolume(0);
  synth.dayAmbience().then((buffer) => {
    dayAmbience.setBuffer(buffer);
    if (ctx.state === 'running') dayAmbience.play();
  });
  synth.nightAmbience().then((buffer) => {
    nightAmbience.setBuffer(buffer);
    if (ctx.state === 'running') nightAmbience.play();
  });
}

/**
 * Crossfade the ambience bed by sun elevation. `night` is expected to be the
 * caller's own `nightFactor(elevation)` (render/projectileFx.js) — the same
 * 0..1 curve already shared by the shadow/glow cross-fade and the headlight
 * gate, so ambience agrees with everything else about when night has started
 * rather than running its own threshold.
 */
export function updateAmbience(night) {
  if (!dayAmbience || !nightAmbience) return;
  if (ctx.state === 'running') {
    if (!dayAmbience.isPlaying && dayAmbience.buffer) dayAmbience.play();
    if (!nightAmbience.isPlaying && nightAmbience.buffer) nightAmbience.play();
  }
  const AMBIENCE_MASTER = 0.5;
  dayAmbience.setVolume((1 - night) * AMBIENCE_MASTER);
  nightAmbience.setVolume(night * AMBIENCE_MASTER);
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
    audio.setVolume(Math.min(1, gain));
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
    a.setVolume(Math.min(1, gain));
    a.play();
  });
}

/**
 * Start (or update) a continuous looped sound anchored to a moving object —
 * an engine. `key` identifies the loop across calls (a vehicle's id); calling
 * again with the same key updates its position and speed rather than
 * starting a second voice.
 *
 * @param {string|number} key stable per emitting entity
 * @param {THREE.Object3D} anchor followed every call — read, never retained
 *   across ticks in the sense CLAUDE.md warns about: this only ever reads
 *   `anchor.position` on the same call that receives it, never caches the
 *   object itself as "the current position" between calls without re-reading
 * @param {number} baseHz idle pitch
 * @param {number} speedFrac 0..1
 */
export function updateEngineLoop(key, anchor, baseHz, speedFrac) {
  if (!ctx || ctx.state !== 'running') return;
  let loop = loops.get(key);

  if (!loop) {
    if (loops.size >= loopPoolSize()) return; // budget exhausted; silently skip
    const audio = new THREE.PositionalAudio(listener);
    const f = falloffFor('default');
    audio.setRefDistance(14);
    audio.setRolloffFactor(1.5);
    audio.setMaxDistance(180);
    audio.panner.panningModel = lowPower ? 'equalpower' : 'HRTF';
    audio.setVolume(1);
    scene.add(audio);

    const engine = synth.engineGraph(ctx, baseHz);
    audio.setNodeSource(engine.output);

    loop = { audio, engine };
    loops.set(key, loop);
  }

  loop.audio.position.copy(anchor.position);
  loop.engine.setSpeed(speedFrac);
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
  };
}
