/**
 * The sound editor's recipe model, and the rules that decide where an
 * authored sound is allowed to play.
 *
 * The two most load-bearing checks here are the bounds tests and the id
 * stability tests, for different reasons.
 *
 * **Bounds are not taste.** `bakeRecipe` sizes an `OfflineAudioContext` at
 * `duration * SAMPLE_RATE` frames, and a recipe can arrive from another
 * player, so an unbounded duration is a denial of service against every peer
 * in the lobby rather than merely a long sound. `recipeDuration` accounting
 * for `startTime` is the specific thing that makes the bound real: eight
 * individually-legal layers staggered end to end would otherwise ask for a
 * render several times the ceiling.
 *
 * **Ids are content addresses**, so the whole scheme rests on "same sound ⇒
 * same id, different sound ⇒ different id". A rename that moved the id would
 * orphan every buffer baked for it; two different sounds sharing an id would
 * mean one peer's cache answering for another's sound.
 *
 * Dependency-free: recipes are plain objects, so none of this needs a browser
 * or an AudioContext.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankRecipe, blankLayer, cloneRecipe, forkRecipe, applyMacros,
  recipeDuration, soundIdFor, syncId, validateRecipe, isCustomId,
  CUSTOM_ID_PREFIX, SOUND_SAVE_MODE,
} from '../src/sound/soundRecipe.js';
import { soundCatalogFor } from '../src/sound/soundCatalog.js';
import { SOUND_EVENTS, silentEvents, soundEventFor } from '../src/audio/soundEvents.js';
import {
  SOUND_GROUPS, LAYER_CONTROLS, LEVELS, MAX_DURATION, MAX_LAYERS,
  controlVisible, deriveBounds, deriveLayerBounds,
} from '../src/sound/soundSchema.js';

test('a blank recipe is valid and content-addressed', () => {
  const recipe = blankRecipe();
  assert.deepEqual(validateRecipe(recipe), []);
  assert.ok(isCustomId(recipe.id));
  assert.ok(recipe.id.startsWith(CUSTOM_ID_PREFIX));
  assert.equal(recipe.id, soundIdFor(recipe));
});

test('renaming a sound does not move its id', () => {
  const a = blankRecipe('Thunder');
  const b = cloneRecipe(a);
  b.name = 'Something else entirely';
  b.description = 'and a different description';
  syncId(b);
  assert.equal(b.id, a.id, 'name and description are identity keys, not content');
});

test('re-binding a sound to a different event does not move its id', () => {
  // If it did, every re-bind would orphan the buffer already baked for this
  // recipe — the cache is keyed on the recipe id.
  const a = blankRecipe();
  a.event = 'weaponFire';
  syncId(a);
  const b = cloneRecipe(a);
  b.event = 'destroyed';
  syncId(b);
  assert.equal(b.id, a.id);
});

test('changing what a sound actually sounds like moves its id', () => {
  const a = blankRecipe();
  const b = cloneRecipe(a);
  b.layers[0].startFreq += 100;
  syncId(b);
  assert.notEqual(b.id, a.id);
});

test('a recipe whose id does not match its contents is rejected', () => {
  const recipe = blankRecipe();
  recipe.layers[0].gain = 0.31;
  // deliberately not re-synced
  const problems = validateRecipe(recipe);
  assert.ok(problems.some((p) => /Id does not match/.test(p)), problems.join('; '));
});

test('recipeDuration accounts for staggered layers, not just the longest one', () => {
  const recipe = blankRecipe();
  recipe.layers = [
    { ...blankLayer('noise'), duration: 0.5, startTime: 0 },
    { ...blankLayer('tone'), duration: 0.5, startTime: 2 },
  ];
  assert.ok(recipeDuration(recipe) > 2.5, `got ${recipeDuration(recipe)}`);
});

test('layers staggered past the ceiling are rejected even when each is legal', () => {
  const recipe = blankRecipe();
  recipe.layers = [
    { ...blankLayer('noise'), duration: 4, startTime: 0 },
    { ...blankLayer('tone'), duration: 4, startTime: 4 },
  ];
  syncId(recipe);
  // Each layer is inside its own bounds; the render is not.
  for (const layer of recipe.layers) {
    assert.ok(layer.duration <= 4 && layer.startTime <= 4);
  }
  const problems = validateRecipe(recipe);
  assert.ok(
    problems.some((p) => p.includes(`under ${MAX_DURATION} seconds`)),
    problems.join('; '),
  );
});

test('too many layers is rejected', () => {
  const recipe = blankRecipe();
  recipe.layers = Array.from({ length: MAX_LAYERS + 1 }, () => blankLayer('noise'));
  syncId(recipe);
  assert.ok(validateRecipe(recipe).some((p) => p.includes(`At most ${MAX_LAYERS} layers`)));
});

test('a layer field outside its slider range is rejected', () => {
  const recipe = blankRecipe();
  const { max } = deriveLayerBounds().noise.startFreq;
  recipe.layers[0].startFreq = max + 1;
  syncId(recipe);
  assert.ok(validateRecipe(recipe).some((p) => /startFreq must be between/.test(p)));
});

test('a falloff whose silence point is nearer than its full-volume point is rejected', () => {
  // Not reachable by dragging, but reachable by a hand-written recipe — and
  // the linear distance model divides by (max - ref).
  const recipe = blankRecipe();
  recipe.falloff = { refDistance: 40, rolloffFactor: 1, maxDistance: 30 };
  syncId(recipe);
  assert.ok(validateRecipe(recipe).some((p) => /Silent beyond/.test(p)));
});

test('an identical sound already in the catalog is reported', () => {
  const recipe = blankRecipe();
  const twin = cloneRecipe(recipe);
  twin.name = 'A different name for the same sound';
  syncId(twin);
  assert.ok(validateRecipe(recipe, { catalog: [twin] }).some((p) => /already exists/.test(p)));
});

test('an unknown layer kind is rejected rather than ignored', () => {
  const recipe = blankRecipe();
  recipe.layers = [{ kind: 'granular', duration: 0.2 }];
  syncId(recipe);
  assert.ok(validateRecipe(recipe).some((p) => /unknown kind/.test(p)));
});

test('forking strips the save row it came from', () => {
  const recipe = { ...blankRecipe(), saveId: 'abc', saveName: 'Row', draft: true };
  const fork = forkRecipe(recipe);
  assert.equal(fork.saveId, undefined);
  assert.equal(fork.saveName, undefined);
  assert.equal(fork.draft, undefined);
  assert.deepEqual(validateRecipe(fork), []);
});

// --- macros ---------------------------------------------------------------

test('macros write through to the layers and leave a valid recipe', () => {
  const base = blankRecipe();
  const recipe = cloneRecipe(base);
  applyMacros(recipe, base, { size: 2, brightness: 1, length: 1 });
  // Bigger means lower — the one piece of real acoustics in the macro set.
  assert.ok(recipe.layers[0].startFreq < base.layers[0].startFreq);
  assert.deepEqual(validateRecipe(recipe), []);
});

test('macros clamp to the layer bounds rather than producing an invalid sound', () => {
  const base = blankRecipe();
  const recipe = cloneRecipe(base);
  applyMacros(recipe, base, { size: 0.2, brightness: 3, length: 3 });
  assert.deepEqual(validateRecipe(recipe), [], 'an extreme macro must still be saveable');
});

test('macros are measured from the base, not accumulated', () => {
  const base = blankRecipe();
  const once = cloneRecipe(base);
  applyMacros(once, base, { size: 2 });
  const twice = cloneRecipe(base);
  applyMacros(twice, base, { size: 2 });
  applyMacros(twice, base, { size: 2 });
  assert.equal(twice.layers[0].startFreq, once.layers[0].startFreq);
});

// --- levels ---------------------------------------------------------------

test('every control carries a level, and every level is one of LEVELS', () => {
  const all = [
    ...SOUND_GROUPS.flatMap((g) => g.controls),
    ...Object.values(LAYER_CONTROLS).flat(),
  ];
  for (const control of all) {
    assert.ok(LEVELS.includes(control.level), `${control.path ?? control.field} has level ${control.level}`);
  }
});

test('levels are cumulative: advanced shows everything low does', () => {
  const all = SOUND_GROUPS.flatMap((g) => g.controls);
  const atLow = all.filter((c) => controlVisible(c, 'low'));
  const atAdvanced = all.filter((c) => controlVisible(c, 'advanced'));
  assert.ok(atLow.length > 0);
  assert.ok(atAdvanced.length > atLow.length, 'advanced must add controls, not replace them');
  for (const control of atLow) assert.ok(atAdvanced.includes(control));
});

test('bounds are derived from the sliders, so a range is written once', () => {
  const bounds = deriveBounds();
  for (const group of SOUND_GROUPS) {
    for (const control of group.controls) {
      if (control.type !== 'slider') continue;
      assert.deepEqual(bounds[control.path], { min: control.min, max: control.max });
    }
  }
});

// --- mode resolution ------------------------------------------------------

test('offline modes get this machine’s own sounds', () => {
  const mine = { ...blankRecipe(), event: 'weaponFire' };
  for (const mode of ['sandbox', 'multiplayer-ai']) {
    assert.deepEqual(soundCatalogFor(mode, [mine], []), [mine], mode);
  }
});

test('online ignores local sounds entirely and uses the match’s', () => {
  const mine = { ...blankRecipe('Mine'), event: 'weaponFire' };
  const theirs = { ...blankRecipe('Match'), event: 'destroyed' };
  const got = soundCatalogFor('multiplayer-online', [mine], [theirs]);
  assert.deepEqual(got, [theirs]);
});

test('an unrecognised mode falls through to built-ins alone', () => {
  const mine = { ...blankRecipe(), event: 'weaponFire' };
  assert.deepEqual(soundCatalogFor('some-mode-nobody-has-thought-about', [mine], [mine]), []);
});

test('drafts and unbound sounds never play, in any mode', () => {
  const draft = { ...blankRecipe('Draft'), event: 'weaponFire', draft: true };
  const unbound = { ...blankRecipe('Unbound'), event: null };
  assert.deepEqual(soundCatalogFor('sandbox', [draft, unbound], []), []);
});

// --- the event registry ---------------------------------------------------

test('event ids are unique', () => {
  const ids = SOUND_EVENTS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the registry records moments that have no sound today', () => {
  // The point of the registry: harvesting has two fully-written generators
  // and no call site anywhere, which nothing surfaced before this list.
  const silent = silentEvents().map((e) => e.id);
  for (const id of ['harvestScoop', 'harvestDeliver', 'notification']) {
    assert.ok(silent.includes(id), `${id} should be listed as silent`);
    assert.equal(soundEventFor(id).builtin, true, `${id} has a generator, it is just never called`);
  }
});

test('the save mode is what customSounds writes and stays inside the API’s limit', () => {
  assert.equal(SOUND_SAVE_MODE, 'sound-def');
  // server/src/routes/saves.js: mode is z.string().max(32).nullish()
  assert.ok(SOUND_SAVE_MODE.length <= 32);
});

// --- the buffer cache key -------------------------------------------------

/**
 * `cacheKey` is pure, so the bug it fixes can be pinned here rather than by a
 * browser count — which is the better test in every respect: deterministic,
 * dependency-free, and it names the actual defect instead of a symptom that
 * needs a working AudioContext, a running dev server and a rendered page to
 * observe.
 *
 * Imported from audio.js, which pulls in `three` at module scope. That is the
 * one dependency `npm test` tolerates — it is already a runtime dependency of
 * the game and needs no browser, database or network to import.
 */
const { cacheKey } = await import('../src/audio/audio.js');

test('the cache key distinguishes generator params', () => {
  // The bug: the key was `${id}:${variation}` with params passed to the
  // generator but absent from the key. Three variations, so after three plays
  // every explosion returned whichever buffer was baked first — a 5-damage
  // plink and a base-station kill made the identical noise.
  const light = cacheKey('explosionGround', { intensity: 0.3 }, 0);
  const heavy = cacheKey('explosionGround', { intensity: 3.4 }, 0);
  assert.notEqual(light, heavy);
});

test('the cache key still collapses repeats of the same params', () => {
  // The other half, and the reason params are quantised rather than keyed
  // raw: `intensity` is a continuous sqrt, so an exact-float key would mean a
  // fresh offline render for practically every shell — trading a correctness
  // bug for a performance one.
  assert.equal(
    cacheKey('explosionGround', { intensity: 1.0 }, 0),
    cacheKey('explosionGround', { intensity: 1.001 }, 0),
  );
  assert.equal(cacheKey('uiConfirm', null, 2), cacheKey('uiConfirm', null, 2));
});

test('the cache key is stable regardless of param insertion order', () => {
  // Keys are built from sorted names, so two call sites that happen to build
  // the same params object differently still hit one cache entry.
  assert.equal(
    cacheKey('weaponFire', { calibre: 20, intensity: 1 }, 1),
    cacheKey('weaponFire', { intensity: 1, calibre: 20 }, 1),
  );
});

test('variation still separates entries for one sound', () => {
  const a = cacheKey('destroyed', { scale: 1 }, 0);
  const b = cacheKey('destroyed', { scale: 1 }, 1);
  assert.notEqual(a, b);
});

// --- the four layer kinds added after the first release -------------------

/**
 * `noise` and `tone` between them are two shapes of "one source through a
 * lowpass", which is why whole families of sound were unmakeable: nothing
 * inharmonic (a bell), nothing with a moving resonant band (a pass-by),
 * nothing whose identity is a rhythm (an alarm), and nothing repeating (a
 * trill). These tests pin that the new kinds are real members of the schema
 * rather than aliases, and that the bounds and validation reach them exactly
 * as they reach the original two.
 */
const { SOUND_PRESETS } = await import('../src/sound/soundPresets.js');
const { LAYER_LABELS } = await import('../src/sound/soundSchema.js');

test('every layer kind has controls, bounds and a label', () => {
  const bounds = deriveLayerBounds();
  for (const kind of ['noise', 'tone', 'fm', 'sweep', 'pulse', 'chirp']) {
    assert.ok(LAYER_CONTROLS[kind]?.length, `${kind} has no controls`);
    assert.ok(Object.keys(bounds[kind] ?? {}).length, `${kind} has no bounds`);
    assert.ok(LAYER_LABELS[kind], `${kind} has no label`);
  }
});

test('a blank layer of every kind produces a valid recipe', () => {
  for (const kind of Object.keys(LAYER_CONTROLS)) {
    const recipe = blankRecipe('t');
    recipe.layers = [blankLayer(kind)];
    syncId(recipe);
    assert.deepEqual(validateRecipe(recipe), [], `${kind} did not validate`);
  }
});

test('a blank layer carries every field its controls declare', () => {
  // A field the schema exposes but blankLayer omits is a slider that reads
  // undefined and writes a value the primitive never had a default for.
  for (const kind of Object.keys(LAYER_CONTROLS)) {
    const layer = blankLayer(kind);
    for (const control of LAYER_CONTROLS[kind]) {
      const field = control.field;
      assert.notEqual(layer[field], undefined, `${kind}.${field} is undefined on a blank layer`);
    }
  }
});

test('every layer control is addressed by `field`, never `path`', () => {
  // The editor's buildLayerControl reads `control.field` for every widget
  // type. A layer control emitted with `path` instead (as the fixed-path
  // `pick()` helper does) writes to layer[undefined] — which is exactly how
  // the waveform dropdown silently did nothing before this was caught.
  for (const kind of Object.keys(LAYER_CONTROLS)) {
    for (const control of LAYER_CONTROLS[kind]) {
      assert.ok(control.field, `${kind} has a control with no field: ${JSON.stringify(control)}`);
      assert.equal(control.path, undefined, `${kind}.${control.field} uses path, not field`);
    }
  }
});

test('a bad waveform is rejected on every kind that has one', () => {
  for (const kind of Object.keys(LAYER_CONTROLS)) {
    const hasWave = LAYER_CONTROLS[kind].some((c) => c.type === 'select' && c.field === 'wave');
    if (!hasWave) continue;
    const recipe = blankRecipe('t');
    recipe.layers = [{ ...blankLayer(kind), wave: 'definitely-not-a-waveform' }];
    syncId(recipe);
    assert.ok(
      validateRecipe(recipe).some((p) => /waveform must be one of/.test(p)),
      `${kind} accepted a bad waveform`,
    );
  }
});

test('the new kinds are bounded like the old ones', () => {
  const bounds = deriveLayerBounds();
  const recipe = blankRecipe('t');
  recipe.layers = [{ ...blankLayer('fm'), index: bounds.fm.index.max + 1 }];
  syncId(recipe);
  assert.ok(validateRecipe(recipe).some((p) => /index must be between/.test(p)));
});

// --- presets --------------------------------------------------------------

test('every preset is a valid recipe', () => {
  // A preset that does not validate would be offered as a starting point and
  // then refuse to save, which is worse than not offering it.
  for (const preset of SOUND_PRESETS) {
    assert.deepEqual(validateRecipe(preset.recipe), [], `preset "${preset.id}" is invalid`);
  }
});

test('preset ids are unique', () => {
  const ids = SOUND_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the presets exercise every layer kind', () => {
  // The second reason presets exist: a slider called "Modulator ratio" tells
  // you nothing until you have heard one. A layer kind with no preset is a
  // feature nobody can discover.
  const used = new Set(SOUND_PRESETS.flatMap((p) => p.recipe.layers.map((l) => l.kind)));
  for (const kind of Object.keys(LAYER_CONTROLS)) {
    assert.ok(used.has(kind), `no preset demonstrates the "${kind}" layer`);
  }
});

test('presets carry their own content-addressed id', () => {
  for (const preset of SOUND_PRESETS) {
    assert.equal(preset.recipe.id, soundIdFor(preset.recipe), `preset "${preset.id}" id is stale`);
  }
});
