/**
 * The sound editor's data model: making, copying and checking recipes.
 *
 * **A recipe is data that describes a sound, not a sound.** This is the whole
 * architectural move the Sound Creator rests on. Today a sound is *code*:
 * `GENERATORS` in `src/audio/audio.js` is a hardcoded map of sixteen ids to JS
 * functions in `synth.js`, so nothing can be authored, saved or shared without
 * shipping new code. Expressed as data, a sound is a few hundred bytes of
 * JSON, which means it rides the existing `/saves` pipeline and the existing
 * match relay untouched — where an audio *file* would be megabytes and would
 * destroy this codebase's deliberate zero-asset property.
 *
 * Three constraints this file exists to protect:
 *
 * - **Built-ins are never rewritten.** A recipe *overrides* a sound event by
 *   binding to its id; `GENERATORS` stays exactly as it is. So the sixteen
 *   shipped sounds cannot regress as a side effect of the editor existing, and
 *   deleting a custom sound restores the original rather than leaving a hole.
 *   `forkBuiltin()` is honest about being an approximation, not a decompile.
 * - **Layer fields map 1:1 onto `noiseBurst()` / `tone()`.** The baker is a
 *   thin interpreter over the primitives the real synth already uses, so a
 *   recipe the editor emits is playable by construction.
 * - **A recipe can arrive from another player**, so every bound is a real
 *   limit rather than a taste: `duration * SAMPLE_RATE` is an allocation, and
 *   an unbounded one is a denial of service against every peer in the match.
 *   `validateRecipe` is therefore run on the server too, exactly as
 *   `validateDef` is for vehicles.
 *
 * Ids are content addresses, reusing `fnv1a64` and the `custom:` prefix from
 * the vehicle builder verbatim — same canonical JSON, same identity-key
 * exclusion — so renaming a sound does not move its id, and two authors who
 * build the same sound converge on one id rather than colliding on a name.
 */
import { fnv1a64 } from '../core/fnv1a.js';
import { canonicalJson, CUSTOM_ID_PREFIX, isCustomId } from '../builder/vehicleDraft.js';
import {
  LAYER_CONTROLS, LEVELS, MAX_DURATION, MAX_LAYERS,
  deriveBounds, deriveLayerBounds, getPath,
} from './soundSchema.js';

const BOUNDS = deriveBounds();
const LAYER_BOUNDS = deriveLayerBounds();

export { CUSTOM_ID_PREFIX, isCustomId };

/** Save-format version, stored alongside the recipe. Bump on a breaking change. */
export const SOUND_SCHEMA_VERSION = 1;

/** The save `mode` these are stored under. Free-form on the API, so no backend change. */
export const SOUND_SAVE_MODE = 'sound-def';

/**
 * Keys that say *which* sound this is, or how it got here, rather than *what
 * it sounds like*. All excluded from the fingerprint.
 *
 * `event` is in here deliberately: binding the same sound to a different game
 * event must not mint a new id, or every rebind would orphan the old buffer
 * and defeat the cache.
 */
const IDENTITY_KEYS = ['id', 'name', 'description', 'event', 'draft', 'saveId', 'saveName', 'macros'];

/** The canonical serialisation a recipe's id is derived from. */
export function recipeFingerprint(recipe) {
  const sound = {};
  for (const key of Object.keys(recipe ?? {})) {
    if (!IDENTITY_KEYS.includes(key)) sound[key] = recipe[key];
  }
  return canonicalJson(sound);
}

/** A recipe's id, derived from its contents. */
export function soundIdFor(recipe) {
  return CUSTOM_ID_PREFIX + fnv1a64(recipeFingerprint(recipe));
}

/** Recompute `recipe.id` from its contents, in place. Returns the same recipe. */
export function syncId(recipe) {
  recipe.id = soundIdFor(recipe);
  return recipe;
}

/** Deep copy via JSON — sound because recipes are pure data. */
export const cloneRecipe = (recipe) => JSON.parse(JSON.stringify(recipe));

/** A layer with every field the matching primitive reads, so none is undefined. */
export function blankLayer(kind = 'noise') {
  return kind === 'tone'
    ? { kind: 'tone', wave: 'sine', startHz: 440, endHz: 220, duration: 0.3, attack: 0.005, gain: 0.4, startTime: 0 }
    : { kind: 'noise', duration: 0.3, startFreq: 3000, endFreq: 200, attack: 0.004, gain: 0.5, startTime: 0 };
}

/**
 * A minimal but complete sound — a noise burst plus a low tone, which is the
 * shape most of the shipped cues share, so the first audition is recognisably
 * a sound effect rather than a click.
 *
 * Falloff defaults are `FALLOFF.default` from `audio.js`: a recipe that never
 * opens the Reach group is positioned exactly like an unedited built-in.
 */
export function blankRecipe(name = 'New Sound') {
  const recipe = {
    id: '',
    name,
    description: 'Built in the sound editor.',
    // Which game event this overrides. Null means it is authored but not yet
    // bound to anything — a perfectly valid state while designing.
    event: null,
    editorLevel: 'medium',
    gain: 0.8,
    layers: [blankLayer('noise'), { ...blankLayer('tone'), startHz: 180, endHz: 60, duration: 0.4 }],
    acoustics: {
      airAbsorption: 0.5,
      reverbSend: 0,
      echoDelay: 0,
      echoFeedback: 0,
      echoMix: 0,
    },
    falloff: { refDistance: 10, rolloffFactor: 1.6, maxDistance: 140 },
  };
  return syncId(recipe);
}

/**
 * Copy any recipe into a new editable one.
 *
 * Runtime-only keys are stripped rather than carried: a fork is a new sound,
 * not a second handle on the save row the original came from.
 */
export function forkRecipe(recipe, name) {
  const copy = cloneRecipe(recipe);
  copy.name = name ?? `${recipe.name} (copy)`;
  delete copy.draft;
  delete copy.saveId;
  delete copy.saveName;
  return syncId(copy);
}

/**
 * How long a recipe renders for — the longest layer's end, plus the tail the
 * acoustics add.
 *
 * This is the number the `OfflineAudioContext` is sized from, so it is what
 * the duration bound actually has to constrain. Bounding each layer alone
 * would not do it: eight layers each 4s long but staggered by `startTime`
 * would still ask for a 12-second render.
 */
export function recipeDuration(recipe) {
  let end = 0;
  for (const layer of recipe?.layers ?? []) {
    const at = Number(layer?.startTime) || 0;
    const len = Number(layer?.duration) || 0;
    if (at + len > end) end = at + len;
  }
  const echo = (Number(recipe?.acoustics?.echoDelay) || 0) * 2;
  return end + echo + 0.05;
}

const isFinitePositive = (v) => Number.isFinite(v) && v > 0;

/**
 * @returns {string[]} human-readable problems; empty means the recipe is safe
 *   to bake, to save, and to accept from another player.
 */
export function validateRecipe(recipe, { catalog = [] } = {}) {
  const problems = [];
  if (!recipe || typeof recipe !== 'object') return ['Not a sound recipe.'];

  if (!recipe.id || typeof recipe.id !== 'string') problems.push('Needs an id.');
  else if (!isCustomId(recipe.id)) problems.push(`Custom sound ids must start with "${CUSTOM_ID_PREFIX}".`);
  // The id is a content address, so it has to address this content. A recipe
  // whose id does not match its own contents is hand-edited or was written by
  // an older build; either way it must not be trusted, because the scheme's
  // one guarantee is that one id means one sound everywhere.
  else if (recipe.id !== soundIdFor(recipe)) problems.push('Id does not match the sound — re-save it.');
  else if (catalog.some((r) => r.id === recipe.id)) problems.push('An identical sound already exists.');

  if (!recipe.name || typeof recipe.name !== 'string') problems.push('Needs a name.');
  if (recipe.editorLevel !== undefined && !LEVELS.includes(recipe.editorLevel)) {
    problems.push(`editorLevel must be one of: ${LEVELS.join(', ')}.`);
  }
  if (recipe.event !== null && recipe.event !== undefined && typeof recipe.event !== 'string') {
    problems.push('event must be a sound id, or none.');
  }

  if (!Array.isArray(recipe.layers) || recipe.layers.length === 0) {
    problems.push('Needs at least one layer.');
  } else if (recipe.layers.length > MAX_LAYERS) {
    // Not taste: every layer is an oscillator or a noise buffer in the same
    // offline render, on every peer that hears this sound.
    problems.push(`At most ${MAX_LAYERS} layers.`);
  } else {
    recipe.layers.forEach((layer, i) => {
      const kind = layer?.kind;
      if (!LAYER_CONTROLS[kind]) {
        problems.push(`Layer ${i + 1} has an unknown kind.`);
        return;
      }
      if (kind === 'tone') {
        const waves = ['sine', 'square', 'sawtooth', 'triangle'];
        if (!waves.includes(layer.wave)) problems.push(`Layer ${i + 1}: waveform must be one of ${waves.join(', ')}.`);
      }
      if (!isFinitePositive(layer.duration)) problems.push(`Layer ${i + 1}: length must be a positive number.`);
      for (const [field, { min, max }] of Object.entries(LAYER_BOUNDS[kind])) {
        const value = layer[field];
        if (value === undefined || value === null) continue;
        if (!Number.isFinite(value)) problems.push(`Layer ${i + 1}: ${field} must be a number.`);
        else if (value < min || value > max) problems.push(`Layer ${i + 1}: ${field} must be between ${min} and ${max}.`);
      }
    });
  }

  const duration = recipeDuration(recipe);
  if (!Number.isFinite(duration) || duration <= 0) {
    problems.push('The sound has no length.');
  } else if (duration > MAX_DURATION) {
    // The bound that matters most for a recipe arriving over the wire: this
    // number multiplies SAMPLE_RATE into an allocation on every peer.
    problems.push(`The whole sound must be under ${MAX_DURATION} seconds (this one is ${duration.toFixed(2)}s).`);
  }

  if (recipe.falloff) {
    const { refDistance, maxDistance } = recipe.falloff;
    if (Number.isFinite(refDistance) && Number.isFinite(maxDistance) && maxDistance <= refDistance) {
      // `distanceModel: 'linear'` divides by (max - ref); equal values are a
      // divide by zero, and inverted ones make the sound get *louder* with
      // distance. Neither is reachable by dragging the sliders, but both are
      // reachable by a hand-written recipe.
      problems.push('"Silent beyond" must be further than "full volume within".');
    }
  }

  // Every fixed-path slider's range, now binding rather than advisory. Paths
  // absent from the recipe are skipped: the `macros.*` controls are transient
  // editor state written through to the layers, never stored.
  for (const [path, { min, max }] of Object.entries(BOUNDS)) {
    const value = getPath(recipe, path);
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value)) problems.push(`${path} must be a number.`);
    else if (value < min || value > max) problems.push(`${path} must be between ${min} and ${max}.`);
  }

  return problems;
}
