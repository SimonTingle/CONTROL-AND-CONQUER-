/**
 * Starting points.
 *
 * The editor's first release opened every new sound as the same blank
 * noise+tone, which is a bad place to start from for the same reason a blank
 * page is: the distance between it and anything recognisable is most of the
 * work, and it is exactly the part that needs synthesis knowledge the editor
 * was supposed to make unnecessary. A preset is not a shortcut past learning
 * the controls — it is the thing you open the controls *on*.
 *
 * These are ordinary recipes, so:
 *
 * - they cost nothing at runtime (data, not code, and nothing bakes until a
 *   sound is actually auditioned or played);
 * - every one of them is editable, saveable and forkable the moment it is
 *   loaded, which is the point;
 * - `npm test` can assert that every single one passes `validateRecipe`, so a
 *   preset can never ship in a state the editor would refuse to save.
 *
 * Between them they exercise all six layer kinds, which is the second reason
 * they exist: `fm`, `sweep`, `pulse` and `chirp` are useless if nobody can
 * find out what they sound like, and reading a slider called "Modulator
 * ratio" does not tell you.
 *
 * **These have not been judged by ear.** There is no audio hardware in the
 * environment they were written in. Each is built from the acoustics of the
 * thing it names — an explosion is a bright transient decaying into low
 * noise, a bell is inharmonic FM with a falling modulation index, a pass-by
 * is a resonant band sweeping down — which is a sound basis for a starting
 * point and is not the same as a finished sound. They are meant to be opened
 * and adjusted, and the editor's whole purpose is that doing so is cheap.
 */
import { syncId } from './soundRecipe.js';

/** `blankRecipe`'s falloff, restated so a preset is a complete recipe. */
const NEAR = { refDistance: 10, rolloffFactor: 1.6, maxDistance: 140 };
const FAR = { refDistance: 20, rolloffFactor: 1.1, maxDistance: 340 };
/** UI and radio cues are heard, not located — they need no reach at all. */
const CLOSE = { refDistance: 6, rolloffFactor: 2, maxDistance: 60 };

const QUIET = { airAbsorption: 0.5, reverbSend: 0, echoDelay: 0, echoFeedback: 0, echoMix: 0 };

const preset = (id, name, category, { gain = 0.8, layers, falloff = NEAR, acoustics = QUIET }) => ({
  id,
  name,
  category,
  recipe: syncId({
    id: '',
    name,
    description: `Preset: ${name}.`,
    event: null,
    editorLevel: 'medium',
    gain,
    layers,
    acoustics: { ...acoustics },
    falloff: { ...falloff },
  }),
});

/**
 * @typedef {object} SoundPreset
 * @property {string} id
 * @property {string} name
 * @property {'combat'|'ui'|'world'|'radio'} category groups the dashboard list
 * @property {object} recipe a complete, valid recipe
 */

/** @type {SoundPreset[]} */
export const SOUND_PRESETS = [
  // --- combat -------------------------------------------------------------
  preset('explosion', 'Explosion', 'combat', {
    gain: 0.9,
    falloff: FAR,
    layers: [
      // Bright crack collapsing to a dull roar — the shape every impact
      // shares, and the reason `noise`'s two cutoffs are start and end
      // rather than one setting.
      { kind: 'noise', duration: 0.9, startFreq: 2600, endFreq: 90, attack: 0.004, gain: 0.8, startTime: 0 },
      // The low sine under it carries the weight. Noise alone reads as a
      // hiss; this is what makes it an impact.
      { kind: 'tone', wave: 'sine', startHz: 120, endHz: 38, duration: 0.7, attack: 0.005, gain: 0.55, startTime: 0 },
    ],
  }),
  preset('gunshot', 'Gunshot', 'combat', {
    gain: 0.85,
    falloff: FAR,
    layers: [
      { kind: 'noise', duration: 0.14, startFreq: 5200, endFreq: 600, attack: 0.001, gain: 0.85, startTime: 0 },
      { kind: 'tone', wave: 'square', startHz: 1500, endHz: 200, duration: 0.05, attack: 0.001, gain: 0.4, startTime: 0 },
    ],
  }),
  preset('metal-impact', 'Metal impact', 'combat', {
    layers: [
      // Inharmonic partials are what make this metal rather than a drum, and
      // are precisely what a stack of `tone` layers cannot produce.
      { kind: 'fm', wave: 'sine', startHz: 430, endHz: 380, ratio: 5.1, index: 900, duration: 0.7, attack: 0.001, gain: 0.5, startTime: 0 },
      { kind: 'noise', duration: 0.12, startFreq: 7000, endFreq: 1200, attack: 0.001, gain: 0.4, startTime: 0 },
    ],
  }),
  preset('whoosh', 'Whoosh / pass-by', 'combat', {
    falloff: FAR,
    layers: [
      // A resonant band falling as it passes — Doppler's perceptual signature.
      // A lowpass sweep cannot do this; it only ever gets duller.
      { kind: 'sweep', startFreq: 2400, endFreq: 350, q: 3.5, duration: 0.7, attack: 0.12, gain: 0.6, startTime: 0 },
    ],
  }),

  // --- ui -----------------------------------------------------------------
  preset('ui-beep', 'UI beep', 'ui', {
    gain: 0.6,
    falloff: CLOSE,
    layers: [
      { kind: 'tone', wave: 'sine', startHz: 880, endHz: 880, duration: 0.08, attack: 0.004, gain: 0.5, startTime: 0 },
    ],
  }),
  preset('ui-confirm', 'UI confirm (two-note)', 'ui', {
    gain: 0.6,
    falloff: CLOSE,
    layers: [
      { kind: 'tone', wave: 'sine', startHz: 660, endHz: 660, duration: 0.07, attack: 0.003, gain: 0.45, startTime: 0 },
      // A rising interval reads as "yes"; the same two notes falling read as
      // "no". This is the whole difference between confirm and cancel.
      { kind: 'tone', wave: 'sine', startHz: 990, endHz: 990, duration: 0.09, attack: 0.003, gain: 0.45, startTime: 0.07 },
    ],
  }),
  preset('alert', 'Alert', 'ui', {
    gain: 0.7,
    falloff: CLOSE,
    layers: [
      // Rhythm, not timbre, is what makes an alert an alert.
      { kind: 'pulse', wave: 'square', startHz: 740, rateHz: 7, depth: 1, duration: 0.9, gain: 0.35, startTime: 0 },
    ],
  }),
  preset('klaxon', 'Klaxon', 'ui', {
    gain: 0.75,
    falloff: FAR,
    layers: [
      { kind: 'pulse', wave: 'sawtooth', startHz: 220, rateHz: 2, depth: 0.9, duration: 1.6, gain: 0.4, startTime: 0 },
      { kind: 'pulse', wave: 'sawtooth', startHz: 165, rateHz: 2, depth: 0.9, duration: 1.6, gain: 0.3, startTime: 0.25 },
    ],
  }),
  preset('coin', 'Coin / pickup', 'ui', {
    gain: 0.6,
    falloff: CLOSE,
    layers: [
      // An ascending arpeggio is the genre convention for "you gained
      // something", and reads that way even with no other context.
      { kind: 'chirp', wave: 'sine', startHz: 1200, endHz: 2400, repeats: 3, duration: 0.24, gain: 0.4, startTime: 0 },
    ],
  }),

  // --- world --------------------------------------------------------------
  preset('engine-rev', 'Engine rev', 'world', {
    layers: [
      // A low pulse train is a firing cycle; the sweep over it is intake
      // noise. Together they read as an engine rather than as a buzz.
      { kind: 'pulse', wave: 'sawtooth', startHz: 90, rateHz: 22, depth: 0.55, duration: 1.2, gain: 0.35, startTime: 0 },
      { kind: 'sweep', startFreq: 400, endFreq: 1400, q: 1.2, duration: 1.2, attack: 0.25, gain: 0.25, startTime: 0 },
    ],
  }),
  preset('wind-gust', 'Wind gust', 'world', {
    gain: 0.5,
    falloff: FAR,
    layers: [
      // attack is capped at 0.5s by the schema — the validator caught this
      // preset asking for 0.8 while it was being written, which is the
      // derived bounds doing exactly what they exist for.
      { kind: 'sweep', startFreq: 500, endFreq: 900, q: 0.8, duration: 2.2, attack: 0.5, gain: 0.5, startTime: 0 },
    ],
  }),

  // --- radio --------------------------------------------------------------
  // These three are what the radio system's artifacts bind to. They are here
  // rather than only in that system so they can be auditioned and retuned in
  // the editor like anything else.
  preset('radio-squelch', 'Radio squelch', 'radio', {
    gain: 0.5,
    falloff: CLOSE,
    layers: [
      { kind: 'noise', duration: 0.07, startFreq: 3000, endFreq: 900, attack: 0.001, gain: 0.5, startTime: 0 },
      { kind: 'chirp', wave: 'square', startHz: 1800, endHz: 900, repeats: 2, duration: 0.05, gain: 0.25, startTime: 0 },
    ],
  }),
  preset('radio-static', 'Radio static', 'radio', {
    gain: 0.35,
    falloff: CLOSE,
    layers: [
      // Band-limited to roughly a voice channel — 300Hz to 3kHz is what makes
      // noise read as "radio" rather than as "hiss".
      { kind: 'sweep', startFreq: 900, endFreq: 1100, q: 0.6, duration: 1.5, attack: 0.05, gain: 0.5, startTime: 0 },
    ],
  }),
  preset('radio-blip', 'Radio blip', 'radio', {
    gain: 0.5,
    falloff: CLOSE,
    layers: [
      { kind: 'chirp', wave: 'square', startHz: 2200, endHz: 1400, repeats: 3, duration: 0.16, gain: 0.35, startTime: 0 },
    ],
  }),
];

export const PRESET_CATEGORIES = ['combat', 'ui', 'world', 'radio'];

export const presetById = (id) => SOUND_PRESETS.find((p) => p.id === id) ?? null;
