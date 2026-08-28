/**
 * Authorable engines and ambience beds.
 *
 * The most valuable test here is the dullest: **the default spec reproduces
 * the constants the hardcoded graph used.** Every vehicle in the game runs
 * through `engineGraph`, so a slip in the default table changes how the whole
 * fleet sounds — silently, because nothing else would fail. The numbers are
 * pinned individually rather than as one snapshot object so a failure names
 * the parameter that moved.
 *
 * Same argument for `DEFAULT_AMBIENCE_SPEC`: the jitter widths were rewritten
 * from `0.85 + r*0.3` into a centre-and-width form, which is a *refactor of
 * arithmetic* — precisely the kind of change that looks obviously equivalent
 * and is not. The range is asserted at both ends.
 *
 * Dependency-free: specs are plain objects, and nothing here constructs an
 * audio graph.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ENGINE_SPEC, DEFAULT_AMBIENCE_SPEC, AMBIENCE_SEGMENT_SECONDS } from '../src/audio/synth.js';
import {
  blankRecipe, blankEngineRecipe, blankAmbienceRecipe, blankOfKind, blankLayer,
  cloneRecipe, kindOf, syncId, validateRecipe,
} from '../src/sound/soundRecipe.js';
import { RECIPE_KINDS, deriveBounds, groupsFor, ENGINE_GROUPS, AMBIENCE_GROUPS, SOUND_GROUPS } from '../src/sound/soundSchema.js';

// --- the non-regression guard ---------------------------------------------

test('the default engine spec is the graph that shipped before it was authorable', () => {
  // These are the literal constants the hardcoded engineGraph used. Changing
  // one changes every vehicle in the game, so it should have to be deliberate.
  assert.equal(DEFAULT_ENGINE_SPEC.oscillators, 2);
  assert.equal(DEFAULT_ENGINE_SPEC.wave, 'sawtooth');
  assert.equal(DEFAULT_ENGINE_SPEC.detune, 1.008);
  assert.equal(DEFAULT_ENGINE_SPEC.filterType, 'lowpass');
  assert.equal(DEFAULT_ENGINE_SPEC.filterQ, 0.5);
  assert.equal(DEFAULT_ENGINE_SPEC.cutoffRatio, 4);
  assert.equal(DEFAULT_ENGINE_SPEC.cutoffRise, 10);
  assert.equal(DEFAULT_ENGINE_SPEC.pitchRise, 0.9);
  assert.equal(DEFAULT_ENGINE_SPEC.gainIdle, 0.14);
  assert.equal(DEFAULT_ENGINE_SPEC.gainRise, 0.12);
  // Not derived from idle/rise — the original graph was constructed at 0.18,
  // which is no expression of the other two.
  assert.equal(DEFAULT_ENGINE_SPEC.gainStart, 0.18);
});

test('the default engine response reproduces the original expressions', () => {
  const s = DEFAULT_ENGINE_SPEC;
  const baseHz = 150;
  // Originals, transcribed from the hardcoded setSpeed:
  //   osc1 = baseHz * (1 + f * 0.9)
  //   osc2 = baseHz * 1.008 * (1 + f * 0.9)
  //   cutoff = baseHz * (4 + f * 10)
  //   gain = 0.14 + f * 0.12
  for (const f of [0, 0.25, 0.5, 1]) {
    assert.equal(baseHz * (1 + f * s.pitchRise), baseHz * (1 + f * 0.9), `pitch at ${f}`);
    assert.equal(baseHz * (s.detune ** 1) * (1 + f * s.pitchRise),
      baseHz * 1.008 * (1 + f * 0.9), `second oscillator at ${f}`);
    assert.equal(baseHz * (s.cutoffRatio + f * s.cutoffRise), baseHz * (4 + f * 10), `cutoff at ${f}`);
    assert.equal(s.gainIdle + f * s.gainRise, 0.14 + f * 0.12, `gain at ${f}`);
  }
});

test('the default ambience spec reproduces the original jitter ranges', () => {
  // The originals were `900 * (0.85 + r*0.3)` etc. Rewritten as a centre and a
  // width, the endpoints must land in the same place — this is arithmetic that
  // looks obviously equivalent and is worth checking anyway.
  const lo = (v, jitter) => v * (1 - jitter / 2);
  const hi = (v, jitter) => v * (1 - jitter / 2 + jitter);

  const day = DEFAULT_AMBIENCE_SPEC.day;
  assert.equal(lo(day.baseFreq, day.freqJitter), 900 * 0.85);
  assert.equal(hi(day.baseFreq, day.freqJitter), 900 * (0.85 + 0.3));
  assert.ok(Math.abs(lo(day.lfoHz, day.lfoJitter) - 0.13 * 0.7) < 1e-12);
  assert.equal(lo(day.lfoDepth, day.depthJitter), 400 * 0.8);
  assert.equal(day.gain, 0.5);

  const night = DEFAULT_AMBIENCE_SPEC.night;
  assert.equal(lo(night.baseFreq, night.freqJitter), 500 * 0.85);
  assert.ok(Math.abs(lo(night.lfoHz, night.lfoJitter) - 0.07 * 0.7) < 1e-12);
  assert.equal(lo(night.lfoDepth, night.depthJitter), 180 * 0.8);
  assert.equal(night.gain, 0.32);

  for (const bed of [day, night]) {
    assert.equal(bed.segmentSeconds, AMBIENCE_SEGMENT_SECONDS);
    assert.equal(bed.filterQ, 0.4);
  }
});

// --- kinds ----------------------------------------------------------------

test('a recipe with no kind is a sound effect', () => {
  // The migration path: every recipe saved before kinds existed lacks the
  // field, and they are all sfx. Nothing has to rewrite them.
  const legacy = blankRecipe('old');
  delete legacy.kind;
  assert.equal(kindOf(legacy), 'sfx');
  syncId(legacy);
  assert.deepEqual(validateRecipe(legacy), []);
});

test('a blank of every kind is valid', () => {
  for (const kind of RECIPE_KINDS) {
    const recipe = blankOfKind(kind, 'T');
    assert.equal(kindOf(recipe), kind);
    assert.deepEqual(validateRecipe(recipe), [], `${kind} did not validate`);
  }
});

test('a blank engine is an exact copy of the built-in', () => {
  // So an author edits away from a known point rather than toward one.
  assert.deepEqual(blankEngineRecipe().engine, DEFAULT_ENGINE_SPEC);
});

test('a blank bed is seeded from the bed it replaces', () => {
  assert.deepEqual(blankAmbienceRecipe('d', 'day').ambience, DEFAULT_AMBIENCE_SPEC.day);
  assert.deepEqual(blankAmbienceRecipe('n', 'night').ambience, DEFAULT_AMBIENCE_SPEC.night);
});

test('each kind carries exactly one body', () => {
  // A mismatched body is worse than an error: bakeRecipe would find no layers
  // and render silence, or engineGraph would find no spec and use the default
  // — both of which read as the editor ignoring the author.
  const engine = blankEngineRecipe();
  engine.layers = [blankLayer('noise')];
  syncId(engine);
  assert.ok(validateRecipe(engine).some((p) => /no layers/.test(p)));

  const sfx = blankRecipe();
  sfx.engine = { ...DEFAULT_ENGINE_SPEC };
  syncId(sfx);
  assert.ok(validateRecipe(sfx).some((p) => /Only an engine recipe/.test(p)));

  const bed = blankAmbienceRecipe();
  bed.engine = { ...DEFAULT_ENGINE_SPEC };
  syncId(bed);
  assert.ok(validateRecipe(bed).some((p) => /Only an engine recipe/.test(p)));
});

test('a bed must replace day or night', () => {
  const bed = blankAmbienceRecipe();
  bed.event = 'midday';
  syncId(bed);
  assert.ok(validateRecipe(bed).some((p) => /must replace/.test(p)));
});

test('an unknown kind is rejected', () => {
  const recipe = blankRecipe();
  recipe.kind = 'orchestra';
  syncId(recipe);
  assert.ok(validateRecipe(recipe).some((p) => /kind must be one of/.test(p)));
});

// --- bounds ---------------------------------------------------------------

test('engine and ambience paths are bounded by the schema', () => {
  const bounds = deriveBounds();
  assert.ok(bounds['engine.pitchRise'], 'engine paths must be bounded');
  assert.ok(bounds['ambience.baseFreq'], 'ambience paths must be bounded');

  const engine = blankEngineRecipe();
  engine.engine.pitchRise = bounds['engine.pitchRise'].max + 1;
  syncId(engine);
  assert.ok(validateRecipe(engine).some((p) => /engine.pitchRise must be between/.test(p)));

  const bed = blankAmbienceRecipe();
  bed.ambience.baseFreq = bounds['ambience.baseFreq'].max + 1;
  syncId(bed);
  assert.ok(validateRecipe(bed).some((p) => /ambience.baseFreq must be between/.test(p)));
});

test('groupsFor returns the right controls per kind', () => {
  assert.equal(groupsFor('engine'), ENGINE_GROUPS);
  assert.equal(groupsFor('ambience'), AMBIENCE_GROUPS);
  assert.equal(groupsFor('sfx'), SOUND_GROUPS);
  assert.equal(groupsFor(undefined), SOUND_GROUPS);
});

test('every engine and ambience control is level-tagged and addressed by path', () => {
  for (const group of [...ENGINE_GROUPS, ...AMBIENCE_GROUPS]) {
    for (const control of group.controls) {
      assert.ok(control.path, `${group.title} has a control with no path`);
      assert.ok(control.level, `${control.path} has no level`);
      assert.equal(control.field, undefined, `${control.path} uses field, not path`);
    }
  }
});

// --- identity -------------------------------------------------------------

test('re-binding an engine to a different vehicle does not move its id', () => {
  const a = blankEngineRecipe();
  a.event = 'scout-buggy';
  syncId(a);
  const b = cloneRecipe(a);
  b.event = 'tracked-tank';
  syncId(b);
  assert.equal(b.id, a.id, 'event is an identity key for every kind');
});

test('changing an engine spec moves its id', () => {
  const a = blankEngineRecipe();
  const b = cloneRecipe(a);
  b.engine.pitchRise += 0.1;
  syncId(b);
  assert.notEqual(b.id, a.id);
});
