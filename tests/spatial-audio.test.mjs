/**
 * The parts of the spatial audio system that don't need a real
 * `AudioContext`/`OfflineAudioContext` — neither exists under `node --test`,
 * so this covers exactly what `docs/plans/` for this feature said it would:
 * pure math with no Web Audio dependency. Buffer rendering
 * (`synth.js`'s generators) and the `PositionalAudio` voice pool
 * (`audio.js`) are exercised only by the manual/browser verification in that
 * plan, not here.
 *
 * `nightFactor` (render/projectileFx.js) is included because the day/night
 * ambience crossfade in `audio.js`'s `updateAmbience` is driven by it
 * directly — the same curve that already decides the shell shadow/glow
 * cross-fade and the headlight gate, so "sound agrees with everything else
 * about when night starts" rests entirely on this one function's shape being
 * right.
 *
 * The volume getter/setter pairs are included because they're plain module
 * state with no Web Audio dependency — `setMasterVolume` reaches for
 * `listener` only if one has been attached by `initAudio`, which never runs
 * under `node --test`, so `listener` stays null and that line is a no-op.
 * This is the same shape `ui/controlSchema.js`'s Sound section calls
 * directly, so it doubles as a check that the slider wiring's `get`/`set`
 * pair actually round-trips.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nightFactor, DAY_ELEVATION, NIGHT_ELEVATION } from '../src/render/projectileFx.js';
import { variedSeed } from '../src/audio/synth.js';
import * as audio from '../src/audio/audio.js';

// ---- nightFactor: what updateAmbience's crossfade rests on ----

test('nightFactor is 0 at and above the day threshold', () => {
  assert.equal(nightFactor(DAY_ELEVATION), 0);
  assert.equal(nightFactor(DAY_ELEVATION + 20), 0, 'clamped, not negative or >0 past noon');
});

test('nightFactor is 1 at and below the night threshold', () => {
  assert.equal(nightFactor(NIGHT_ELEVATION), 1);
  assert.equal(nightFactor(NIGHT_ELEVATION - 20), 1, 'clamped at 1 well past midnight');
});

test('nightFactor is monotonic through dusk — no double-dip in the crossfade', () => {
  // A non-monotonic curve here would mean the ambience beds briefly swap
  // back toward day mid-dusk before continuing toward night — audible as a
  // stutter in the crossfade.
  let last = nightFactor(DAY_ELEVATION);
  for (let e = DAY_ELEVATION - 1; e >= NIGHT_ELEVATION; e--) {
    const v = nightFactor(e);
    assert.ok(v >= last, `dropped from ${last} to ${v} at elevation ${e}`);
    last = v;
  }
});

test('day and night ambience volumes always sum to the same master level', () => {
  // Mirrors audio.js's updateAmbience: dayGain = (1-night)*M, nightGain =
  // night*M. If nightFactor ever left its output outside [0,1] this
  // invariant would break — a silent dip or a doubled peak at the crossfade
  // midpoint — which is exactly the kind of bug that's inaudible in a code
  // review and obvious in play.
  const MASTER = 0.5;
  for (const e of [-10, NIGHT_ELEVATION, -1, 0, 5, DAY_ELEVATION, 30]) {
    const night = nightFactor(e);
    const day = 1 - night;
    assert.ok(Math.abs(day * MASTER + night * MASTER - MASTER) < 1e-9, `broke at elevation ${e}`);
  }
});

// ---- variedSeed: sound variation, not simulation determinism ----

test('variedSeed returns a value in [0, 1)', () => {
  for (let i = 0; i < 200; i++) {
    const v = variedSeed();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('variedSeed is not a constant — repeated cues actually vary', () => {
  const samples = new Set();
  for (let i = 0; i < 20; i++) samples.add(variedSeed());
  assert.ok(samples.size > 1, 'every call returned the same value');
});

// ---- volume controls: plain state, round-trips through get/set ----

test('each volume defaults inside [0, 1]', () => {
  for (const get of [audio.getMasterVolume, audio.getEffectsVolume, audio.getEngineVolume, audio.getAmbienceVolume]) {
    const v = get();
    assert.ok(v >= 0 && v <= 1, `default ${v} out of range`);
  }
});

test('engine and ambience default to their new low levels', () => {
  // These two specifically were turned down from their original defaults
  // (0.8 and 0.35) — pinned here so a future change to either has to be
  // deliberate, not an accidental revert.
  assert.equal(audio.getEngineVolume(), 0.15);
  assert.equal(audio.getAmbienceVolume(), 0.10);
});

test('set/get round-trips for every control', () => {
  audio.setMasterVolume(0.42);
  assert.equal(audio.getMasterVolume(), 0.42);
  audio.setEffectsVolume(0.7);
  assert.equal(audio.getEffectsVolume(), 0.7);
  audio.setEngineVolume(0.15);
  assert.equal(audio.getEngineVolume(), 0.15);
  audio.setAmbienceVolume(0.9);
  assert.equal(audio.getAmbienceVolume(), 0.9);
});

test('every setter clamps to [0, 1], both directions', () => {
  audio.setMasterVolume(5);
  assert.equal(audio.getMasterVolume(), 1);
  audio.setMasterVolume(-3);
  assert.equal(audio.getMasterVolume(), 0);

  audio.setAmbienceVolume(2);
  assert.equal(audio.getAmbienceVolume(), 1);
  audio.setAmbienceVolume(-1);
  assert.equal(audio.getAmbienceVolume(), 0);
});

test('the four controls are independent — setting one leaves the others alone', () => {
  audio.setMasterVolume(0.5);
  audio.setEffectsVolume(0.5);
  audio.setEngineVolume(0.5);
  audio.setAmbienceVolume(0.5);

  audio.setEffectsVolume(0.9);

  assert.equal(audio.getMasterVolume(), 0.5);
  assert.equal(audio.getEngineVolume(), 0.5);
  assert.equal(audio.getAmbienceVolume(), 0.5);
  assert.equal(audio.getEffectsVolume(), 0.9);
});

test('setMasterVolume does not throw before initAudio has attached a listener', () => {
  // node --test never calls initAudio (no AudioContext exists), so `listener`
  // is null here — this is exactly the path controlSchema.js's slider would
  // hit if a user somehow dragged it before the engine finished initializing.
  assert.doesNotThrow(() => audio.setMasterVolume(0.6));
  assert.equal(audio.getMasterVolume(), 0.6);
});

test('setAmbienceVolume does not throw with no ambience beds constructed', () => {
  // Same reasoning as above, for the day/night crossfade re-application path.
  assert.doesNotThrow(() => audio.setAmbienceVolume(0.3));
  assert.equal(audio.getAmbienceVolume(), 0.3);
});

// ---- stepEnginePresence: the stop/start ramp's own arithmetic ----

test('presence ramps up from 0 while moving, and reaches 1', () => {
  let p = 0;
  for (let i = 0; i < 200; i++) p = audio.stepEnginePresence(p, 1, 1 / 60);
  assert.equal(p, 1, 'ramped all the way up given enough time');
});

test('presence ramps down to 0 once stopped', () => {
  let p = 1;
  for (let i = 0; i < 200; i++) p = audio.stepEnginePresence(p, 0, 1 / 60);
  assert.equal(p, 0, 'ramped all the way down given enough time');
});

test('a single large dt does not overshoot past the target in either direction', () => {
  assert.equal(audio.stepEnginePresence(0, 1, 999), 1, 'clamped at the top');
  assert.equal(audio.stepEnginePresence(1, 0, 999), 0, 'clamped at the bottom');
});

test('a speed at or below the stop epsilon counts as stationary', () => {
  // Below the epsilon, the ramp heads toward 0 even starting from full
  // presence — this is the "stop vehicle engine noise if stationary" case.
  const next = audio.stepEnginePresence(1, 0.01, 1 / 60);
  assert.ok(next < 1, 'presence started decaying toward silence');
});

test('a speed just above the stop epsilon counts as moving', () => {
  const next = audio.stepEnginePresence(0, 0.03, 1 / 60);
  assert.ok(next > 0, 'presence started rising toward full');
});

test('presence never leaves [0, 1] across a long random walk of speeds', () => {
  let p = 0;
  for (let i = 0; i < 500; i++) {
    const speedFrac = (i % 7) / 6; // deterministic zig-zag between 0 and 1
    p = audio.stepEnginePresence(p, speedFrac, 1 / 60);
    assert.ok(p >= 0 && p <= 1, `presence left range: ${p} at step ${i}`);
  }
});

// ---- engineWritesNeeded / shouldReleaseIdleLoop: the per-frame write budget ----
//
// These exist because of a measured regression, not a theoretical one. With
// `updateEngineLoop` writing volume, position and speed unconditionally, a
// 40-vehicle benchmark scene in which *every vehicle was parked and silent*
// scheduled 229.7 AudioParam automation events per frame — 14.4 per engine
// loop, ~13,800/second at 60fps — to describe a fleet that was not moving and
// could not be heard. See docs/plans/fps-regression.md.
//
// The contract worth protecting is therefore a negative one: when nothing has
// changed, nothing is written.

const NEXT = { volume: 0.5, speedFrac: 0.4, x: 10, y: 2, z: -3 };

test('the first update writes everything, to establish a baseline', () => {
  const w = audio.engineWritesNeeded(null, NEXT);
  assert.deepEqual(w, { volume: true, speed: true, position: true });
});

test('an unchanged loop writes nothing at all', () => {
  // The whole point. A parked fleet must cost no automation events.
  const w = audio.engineWritesNeeded({ ...NEXT }, { ...NEXT });
  assert.deepEqual(w, { volume: false, speed: false, position: false });
});

test('each parameter is written independently of the others', () => {
  const louder = audio.engineWritesNeeded({ ...NEXT }, { ...NEXT, volume: NEXT.volume + 0.2 });
  assert.deepEqual(louder, { volume: true, speed: false, position: false });

  const faster = audio.engineWritesNeeded({ ...NEXT }, { ...NEXT, speedFrac: NEXT.speedFrac + 0.2 });
  assert.deepEqual(faster, { volume: false, speed: true, position: false });

  const moved = audio.engineWritesNeeded({ ...NEXT }, { ...NEXT, x: NEXT.x + 5 });
  assert.deepEqual(moved, { volume: false, speed: false, position: true });
});

test('changes far below the audible threshold are not written', () => {
  const w = audio.engineWritesNeeded({ ...NEXT }, {
    ...NEXT,
    volume: NEXT.volume + 1e-9,
    speedFrac: NEXT.speedFrac + 1e-9,
    x: NEXT.x + 1e-9,
  });
  assert.deepEqual(w, { volume: false, speed: false, position: false });
});

test('position is compared in three dimensions, not just one', () => {
  // A vehicle climbing a slope or moving purely in z must still update the
  // panner; an early draft compared only x and would have pinned those voices.
  for (const axis of ['x', 'y', 'z']) {
    const w = audio.engineWritesNeeded({ ...NEXT }, { ...NEXT, [axis]: NEXT[axis] + 5 });
    assert.equal(w.position, true, `movement along ${axis} was not noticed`);
  }
});

test('a drift too slow to trip the threshold still eventually writes', () => {
  // The reason the baseline is the last value *written* rather than the last
  // value seen. Against last-seen, a vehicle creeping by a hundredth of the
  // threshold per frame would never write and its voice would silently
  // detach from it forever.
  const written = { ...NEXT };
  let wrote = false;
  for (let i = 0; i < 5000 && !wrote; i++) {
    const next = { ...NEXT, x: NEXT.x + i * 1e-4 };
    if (audio.engineWritesNeeded(written, next).position) wrote = true;
  }
  assert.ok(wrote, 'a slow drift never accumulated into a write');
});

test('a loop is not released while it can still be heard', () => {
  assert.equal(audio.shouldReleaseIdleLoop(0.5, 0, 99), false, 'still audible');
});

test('a loop is not released while its vehicle is moving', () => {
  assert.equal(audio.shouldReleaseIdleLoop(0, 1, 99), false, 'still moving');
});

test('a silent, stopped loop is released only after the idle window', () => {
  // The hysteresis: a vehicle pausing at a waypoint and driving on must not
  // tear down and rebuild five audio nodes on consecutive frames.
  assert.equal(audio.shouldReleaseIdleLoop(0, 0, 0), false, 'released instantly');
  assert.equal(audio.shouldReleaseIdleLoop(0, 0, 0.5), false, 'released inside the window');
  assert.equal(audio.shouldReleaseIdleLoop(0, 0, 5), true, 'never released at all');
});
