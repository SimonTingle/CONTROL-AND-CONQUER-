/**
 * Every editable sound parameter, as data.
 *
 * Same shape and the same reasoning as `src/builder/builderSchema.js`: a
 * declarative control list the editor renders into widgets, addressing fields
 * by dotted path rather than by closure, because the recipe being edited is
 * swapped wholesale whenever the author picks a different sound from the
 * dashboard.
 *
 * Two things are specific to sound.
 *
 * **The three ability levels are one schema, filtered.** Every control carries
 * `level: 'low' | 'medium' | 'advanced'`, and switching level changes *which
 * controls render* — it does not switch editors, and it never changes the
 * recipe. A sound authored at `advanced` and then viewed at `low` still has
 * all of its layers; the author simply stops being shown the knobs. This
 * matters because the alternative — three editors, or three recipe formats —
 * would mean a sound could not move between levels without being rebuilt.
 *
 * **Layers are a list, so their bounds are per-kind rather than per-path.**
 * `layers.3.startFreq` is not a path that can be written down in advance, so
 * `deriveLayerBounds()` returns bounds keyed by layer kind and field name and
 * `validateRecipe` walks the actual list. The top-level acoustics and falloff
 * blocks are ordinary fixed paths and use `deriveBounds()`, unchanged in
 * spirit from the vehicle builder.
 *
 * Ranges are the real limits of what the baker and the Web Audio graph cope
 * with, not taste: an `OfflineAudioContext` is allocated at
 * `duration * SAMPLE_RATE` frames, so the duration ceiling is a memory bound
 * that a recipe arriving from another player must not be able to exceed.
 */

export { getPath, setPath } from '../builder/builderSchema.js';

export const LEVELS = ['low', 'medium', 'advanced'];

/** Level ordering, so a control tagged `low` is visible at `advanced` too. */
const LEVEL_RANK = { low: 0, medium: 1, advanced: 2 };

/** Is `control` shown to an author working at `level`? */
export function controlVisible(control, level) {
  const want = LEVEL_RANK[level] ?? LEVEL_RANK.medium;
  return (LEVEL_RANK[control.level] ?? 0) <= want;
}

const num = (path, label, min, max, step, level = 'medium') =>
  ({ type: 'slider', path, label, min, max, step, level });
const pick = (path, label, options, level = 'medium') =>
  ({ type: 'select', path, label, options, level });

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * Layer fields map 1:1 onto `noiseBurst()` and `tone()` in `synth.js`.
 *
 * That correspondence is the whole reason the baker stays thin, and it is
 * deliberately not abstracted: adding a field here without adding it to the
 * matching primitive would produce a control that silently does nothing, which
 * is the failure mode a one-to-one mapping makes obvious.
 *
 * `field` rather than `path` because a layer's real path depends on its index.
 */
export const LAYER_KINDS = ['noise', 'tone'];

const layerNum = (field, label, min, max, step, level = 'medium') =>
  ({ type: 'slider', field, label, min, max, step, level });

export const LAYER_CONTROLS = {
  noise: [
    layerNum('duration', 'Length', 0.02, 4, 0.01, 'medium'),
    layerNum('startFreq', 'Opening brightness (Hz)', 60, 11000, 10, 'medium'),
    layerNum('endFreq', 'Closing brightness (Hz)', 20, 11000, 10, 'medium'),
    layerNum('attack', 'Attack', 0.001, 0.5, 0.001, 'advanced'),
    layerNum('gain', 'Level', 0, 1, 0.01, 'medium'),
    layerNum('startTime', 'Delay in', 0, 4, 0.01, 'advanced'),
  ],
  tone: [
    pick('wave', 'Waveform', ['sine', 'square', 'sawtooth', 'triangle'], 'medium'),
    layerNum('duration', 'Length', 0.02, 4, 0.01, 'medium'),
    layerNum('startHz', 'Start pitch (Hz)', 20, 6000, 1, 'medium'),
    layerNum('endHz', 'End pitch (Hz)', 20, 6000, 1, 'medium'),
    layerNum('attack', 'Attack', 0.001, 0.5, 0.001, 'advanced'),
    layerNum('gain', 'Level', 0, 1, 0.01, 'medium'),
    layerNum('startTime', 'Delay in', 0, 4, 0.01, 'advanced'),
  ],
};

/** Hard ceilings a recipe cannot exceed however it was authored or received. */
export const MAX_LAYERS = 8;
/** Seconds. The `OfflineAudioContext` allocation is linear in this. */
export const MAX_DURATION = 6;

// ---------------------------------------------------------------------------
// Fixed-path controls
// ---------------------------------------------------------------------------

/**
 * Acoustics and falloff.
 *
 * Falloff defaults match `FALLOFF.default` in `audio.js` — only four sound ids
 * ship with anything else — so a recipe that never touches this group sounds
 * positioned exactly like an unedited built-in.
 */
export const SOUND_GROUPS = [
  {
    title: 'Identity',
    controls: [
      { type: 'text', path: 'name', label: 'Name', level: 'low' },
    ],
  },
  {
    title: 'Shape',
    controls: [
      // The `low` macros. They are not stored: `applyMacros()` writes them
      // through to the layer fields, so a sound edited at `low` and reopened
      // at `advanced` shows real layer values rather than a separate,
      // divergent set of numbers.
      num('macros.size', 'Size', 0.2, 3, 0.05, 'low'),
      num('macros.brightness', 'Brightness', 0.2, 3, 0.05, 'low'),
      num('macros.length', 'Length', 0.2, 3, 0.05, 'low'),
    ],
  },
  {
    title: 'Reach',
    controls: [
      num('falloff.refDistance', 'Full volume within', 1, 60, 1, 'low'),
      num('falloff.maxDistance', 'Silent beyond', 20, 600, 10, 'low'),
      num('falloff.rolloffFactor', 'Rolloff', 0.2, 4, 0.05, 'advanced'),
      num('gain', 'Overall level', 0, 1, 0.01, 'medium'),
    ],
  },
  {
    title: 'Acoustics',
    controls: [
      num('acoustics.airAbsorption', 'Muffling with distance', 0, 1, 0.01, 'medium'),
      num('acoustics.reverbSend', 'Reverb', 0, 1, 0.01, 'medium'),
      num('acoustics.echoDelay', 'Echo time', 0, 1.2, 0.01, 'advanced'),
      num('acoustics.echoFeedback', 'Echo repeats', 0, 0.85, 0.01, 'advanced'),
      num('acoustics.echoMix', 'Echo level', 0, 1, 0.01, 'advanced'),
    ],
  },
];

/**
 * Every fixed-path slider's range, as `{ 'dotted.path': { min, max } }`.
 *
 * Derived rather than restated for the reason `deriveBounds` exists in the
 * vehicle builder: a range is written once and binds both the widget and the
 * validator, so they cannot drift apart. Here it also binds the *server*, via
 * the same recipe validation, which is what stops a hostile recipe.
 */
export function deriveBounds(groups = SOUND_GROUPS) {
  const bounds = {};
  for (const group of groups) {
    for (const control of group.controls) {
      if (control.type !== 'slider') continue;
      bounds[control.path] = { min: control.min, max: control.max };
    }
  }
  return bounds;
}

/** Layer field ranges, as `{ kind: { field: { min, max } } }`. */
export function deriveLayerBounds(controls = LAYER_CONTROLS) {
  const bounds = {};
  for (const kind of Object.keys(controls)) {
    bounds[kind] = {};
    for (const control of controls[kind]) {
      if (control.type !== 'slider') continue;
      bounds[kind][control.field] = { min: control.min, max: control.max };
    }
  }
  return bounds;
}
