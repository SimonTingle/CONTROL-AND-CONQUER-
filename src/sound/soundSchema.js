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
export const LAYER_KINDS = ['noise', 'tone', 'fm', 'sweep', 'pulse', 'chirp'];

/** Display names. The raw kind is a shorthand; the label says what it makes. */
export const LAYER_LABELS = {
  noise: 'Noise',
  tone: 'Tone',
  fm: 'FM (metallic)',
  sweep: 'Sweep (band)',
  pulse: 'Pulse (rhythm)',
  chirp: 'Chirp (repeats)',
};

const layerNum = (field, label, min, max, step, level = 'medium') =>
  ({ type: 'slider', field, label, min, max, step, level });

/**
 * A layer's dropdown.
 *
 * Deliberately NOT `pick()` above, which is for the fixed-path controls and
 * emits `path`. A layer control is addressed by `field` — its real path
 * depends on the layer's index — and the editor's `buildLayerControl` reads
 * `control.field` for every widget type. Using `pick()` here wrote to
 * `layer[undefined]`, so the waveform dropdown silently did nothing: it
 * looked right, changed nothing, and re-read as blank. One helper per
 * addressing mode is what stops that recurring.
 */
const layerPick = (field, label, options, level = 'medium') =>
  ({ type: 'select', field, label, options, level });

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
    layerPick('wave', 'Waveform', ['sine', 'square', 'sawtooth', 'triangle'], 'medium'),
    layerNum('duration', 'Length', 0.02, 4, 0.01, 'medium'),
    layerNum('startHz', 'Start pitch (Hz)', 20, 6000, 1, 'medium'),
    layerNum('endHz', 'End pitch (Hz)', 20, 6000, 1, 'medium'),
    layerNum('attack', 'Attack', 0.001, 0.5, 0.001, 'advanced'),
    layerNum('gain', 'Level', 0, 1, 0.01, 'medium'),
    layerNum('startTime', 'Delay in', 0, 4, 0.01, 'advanced'),
  ],

  // --- the four added after the first release --------------------------
  //
  // `noise` and `tone` between them cover impacts and chimes and very little
  // else: both are a single source through a lowpass, so anything metallic,
  // anything that moves past you, anything that repeats, and anything with a
  // resonant band rather than a ceiling was simply unmakeable. Each of these
  // is one extra Web Audio node over what already exists, and each unlocks a
  // whole family rather than one more variation.

  // Carrier modulated by a second oscillator. The classic way to get
  // inharmonic partials — bells, clangs, alarms, sci-fi tones — none of which
  // can be built by summing `tone` layers, because their partials are not
  // whole-number multiples of the fundamental.
  fm: [
    layerPick('wave', 'Carrier wave', ['sine', 'square', 'sawtooth', 'triangle'], 'medium'),
    layerNum('duration', 'Length', 0.02, 4, 0.01, 'medium'),
    layerNum('startHz', 'Start pitch (Hz)', 20, 6000, 1, 'medium'),
    layerNum('endHz', 'End pitch (Hz)', 20, 6000, 1, 'medium'),
    // Expressed as a ratio, not Hz: the character of an FM sound follows the
    // carrier:modulator *ratio*, so a bell stays a bell when transposed.
    layerNum('ratio', 'Modulator ratio', 0.1, 12, 0.05, 'medium'),
    layerNum('index', 'Brightness (FM index)', 0, 2000, 5, 'medium'),
    layerNum('attack', 'Attack', 0.001, 0.5, 0.001, 'advanced'),
    layerNum('gain', 'Level', 0, 1, 0.01, 'medium'),
    layerNum('startTime', 'Delay in', 0, 4, 0.01, 'advanced'),
  ],

  // Noise through a *bandpass* that sweeps, rather than the lowpass `noise`
  // uses. A moving resonant band is what a pass-by actually sounds like; a
  // falling lowpass ceiling only ever sounds like something getting duller.
  sweep: [
    layerNum('duration', 'Length', 0.02, 4, 0.01, 'medium'),
    layerNum('startFreq', 'Band start (Hz)', 60, 11000, 10, 'medium'),
    layerNum('endFreq', 'Band end (Hz)', 60, 11000, 10, 'medium'),
    // High Q is the difference between "wind" and "a whistle".
    layerNum('q', 'Resonance', 0.3, 24, 0.1, 'medium'),
    layerNum('attack', 'Attack', 0.001, 0.5, 0.001, 'advanced'),
    layerNum('gain', 'Level', 0, 1, 0.01, 'medium'),
    layerNum('startTime', 'Delay in', 0, 4, 0.01, 'advanced'),
  ],

  // A tone gated by an LFO on its own gain. Alarms, klaxons, geiger ticks,
  // radio squelch — anything whose identity is a *rhythm* rather than a
  // timbre, which no amount of envelope shaping on a single tone can produce.
  pulse: [
    layerPick('wave', 'Waveform', ['sine', 'square', 'sawtooth', 'triangle'], 'medium'),
    layerNum('duration', 'Length', 0.02, 4, 0.01, 'medium'),
    layerNum('startHz', 'Pitch (Hz)', 20, 6000, 1, 'medium'),
    layerNum('rateHz', 'Pulses per second', 0.5, 40, 0.5, 'medium'),
    // 0 = smooth tremolo, 1 = hard on/off gating.
    layerNum('depth', 'Gate depth', 0, 1, 0.01, 'medium'),
    layerNum('gain', 'Level', 0, 1, 0.01, 'medium'),
    layerNum('startTime', 'Delay in', 0, 4, 0.01, 'advanced'),
  ],

  // N fast pitch ramps in a row. Birds, UI trills, radio blips, data bursts —
  // built as repeats rather than as N separate layers so a 12-blip chirp
  // costs one layer of the eight allowed, not twelve.
  chirp: [
    layerPick('wave', 'Waveform', ['sine', 'square', 'triangle', 'sawtooth'], 'medium'),
    layerNum('duration', 'Length', 0.02, 4, 0.01, 'medium'),
    layerNum('startHz', 'Start pitch (Hz)', 20, 6000, 1, 'medium'),
    layerNum('endHz', 'End pitch (Hz)', 20, 6000, 1, 'medium'),
    layerNum('repeats', 'Repeats', 1, 24, 1, 'medium'),
    layerNum('gain', 'Level', 0, 1, 0.01, 'medium'),
    layerNum('startTime', 'Delay in', 0, 4, 0.01, 'advanced'),
  ],
};

import { MIN_AMBIENCE_SEGMENT_SECONDS } from '../audio/synth.js';

/** Hard ceilings a recipe cannot exceed however it was authored or received. */
export const MAX_LAYERS = 8;
/** Seconds. The `OfflineAudioContext` allocation is linear in this. */
export const MAX_DURATION = 6;
/**
 * Seconds. Floor on an ambience bed's segment length — re-exported from
 * synth.js, which owns it because it is a property of how a bed renders.
 * MAX_DURATION bounds how *big* one render is; this bounds how *often* one
 * happens. See docs/plans/fps-regression-second-pass.md.
 */
export { MIN_AMBIENCE_SEGMENT_SECONDS };

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
export const RECIPE_KINDS = ['sfx', 'engine', 'ambience'];

export const KIND_LABELS = {
  sfx: 'Sound effect',
  engine: 'Engine',
  ambience: 'Ambience',
};

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
 * An engine is a *live graph*, not a baked buffer, so it has no layers and no
 * envelope — its parameters are the shape of a continuously running sound and
 * how that shape responds to speed. Different vocabulary, same machinery.
 *
 * The speed response is a handful of scalars rather than an editable curve.
 * That is a deliberate limit: a curve editor is a much bigger UI than this
 * earns, and these scalars span the range the existing graph actually covers.
 */
export const ENGINE_GROUPS = [
  {
    title: 'Identity',
    controls: [{ type: 'text', path: 'name', label: 'Name', level: 'low' }],
  },
  {
    title: 'Timbre',
    controls: [
      num('engine.oscillators', 'Oscillators', 1, 3, 1, 'medium'),
      pick('engine.wave', 'Waveform', ['sawtooth', 'square', 'triangle', 'sine'], 'low'),
      // Cents, not a raw ratio: 1.008 means nothing to read, "a few cents
      // apart" is the thing an author is actually setting. Past a small
      // offset the two oscillators stop being one engine and become two.
      num('engine.detune', 'Detune', 1, 1.05, 0.001, 'medium'),
      pick('engine.filterType', 'Filter', ['lowpass', 'bandpass', 'highpass'], 'advanced'),
      num('engine.filterQ', 'Resonance', 0.1, 12, 0.1, 'advanced'),
    ],
  },
  {
    title: 'Response to speed',
    controls: [
      num('engine.cutoffRatio', 'Brightness at idle', 0.5, 20, 0.1, 'low'),
      num('engine.cutoffRise', 'Brightness at speed', 0, 40, 0.5, 'low'),
      num('engine.pitchRise', 'Pitch rise', 0, 3, 0.05, 'low'),
      num('engine.gainIdle', 'Level at idle', 0, 1, 0.01, 'medium'),
      num('engine.gainRise', 'Level at speed', 0, 1, 0.01, 'medium'),
      num('engine.gainStart', 'Level on start', 0, 1, 0.01, 'advanced'),
    ],
  },
];

/**
 * A bed is a chain of freshly baked segments, so its parameters are the
 * segment's shape *and how much it wanders between segments*.
 *
 * The jitter widths are exposed rather than hidden because they are what makes
 * the bed generative instead of a loop. Setting them to zero is a legitimate
 * choice — it just needs to be a visible one, not something an author does
 * without realising they have turned the wind into a repeating sample.
 */
export const AMBIENCE_GROUPS = [
  {
    title: 'Identity',
    controls: [{ type: 'text', path: 'name', label: 'Name', level: 'low' }],
  },
  {
    title: 'Bed',
    controls: [
      num('ambience.baseFreq', 'Tone (Hz)', 80, 4000, 10, 'low'),
      num('ambience.gain', 'Level', 0, 1, 0.01, 'low'),
      num('ambience.lfoHz', 'Wander rate (Hz)', 0.01, 2, 0.01, 'medium'),
      num('ambience.lfoDepth', 'Wander depth (Hz)', 0, 2000, 10, 'medium'),
      num('ambience.filterQ', 'Resonance', 0.1, 12, 0.1, 'advanced'),
      num('ambience.segmentSeconds', 'Segment length', MIN_AMBIENCE_SEGMENT_SECONDS, 20, 0.5, 'advanced'),
    ],
  },
  {
    title: 'Variation between segments',
    controls: [
      num('ambience.freqJitter', 'Tone wander', 0, 1, 0.01, 'medium'),
      num('ambience.lfoJitter', 'Rate wander', 0, 1, 0.01, 'medium'),
      num('ambience.depthJitter', 'Depth wander', 0, 1, 0.01, 'medium'),
    ],
  },
];

/** The control groups for a recipe kind. */
export function groupsFor(kind) {
  if (kind === 'engine') return ENGINE_GROUPS;
  if (kind === 'ambience') return AMBIENCE_GROUPS;
  return SOUND_GROUPS;
}

/**
 * Every fixed-path slider's range, as `{ 'dotted.path': { min, max } }`.
 *
 * Derived rather than restated for the reason `deriveBounds` exists in the
 * vehicle builder: a range is written once and binds both the widget and the
 * validator, so they cannot drift apart. Here it also binds the *server*, via
 * the same recipe validation, which is what stops a hostile recipe.
 */
export function deriveBounds(groups = [...SOUND_GROUPS, ...ENGINE_GROUPS, ...AMBIENCE_GROUPS]) {
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
