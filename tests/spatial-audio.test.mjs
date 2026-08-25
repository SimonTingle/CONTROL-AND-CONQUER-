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
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nightFactor, DAY_ELEVATION, NIGHT_ELEVATION } from '../src/render/projectileFx.js';
import { variedSeed } from '../src/audio/synth.js';

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
