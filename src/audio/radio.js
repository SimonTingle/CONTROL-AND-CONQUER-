/**
 * The team radio net: what your units say to each other, and how it sounds.
 *
 * ## The constraint this file is shaped by
 *
 * The voice is browser TTS, and **`speechSynthesis` output cannot be routed
 * into Web Audio.** This was confirmed by probing Chromium rather than assumed:
 * `SpeechSynthesisUtterance` exposes `text`, `lang`, `voice`, `volume`, `rate`
 * and `pitch` and nothing else — no AudioNode, no MediaStream — and
 * `speechSynthesis.captureStream` does not exist. So the voice can never carry
 * a filter, be positioned, reach the mixer, or be recorded.
 *
 * The resolution, agreed with the author of the request: **the voice is dry,
 * and everything around it is real.** The squelch that opens the channel, the
 * static bed under the line, and the squelch that closes it are ordinary Web
 * Audio sounds played through the existing global voice pool — filtered,
 * mixed, and editable in the Sound Creator like any other cue. What you hear
 * as "a radio" is mostly those artifacts; the voice is the part in the middle.
 *
 * `utterance.volume`, `rate` and `pitch` do exist, and they are what is left to
 * work with: volume follows the radio slider, while rate and pitch give each
 * vehicle class a recognisably different speaker.
 *
 * ## No voices is the normal case, not an error
 *
 * `speechSynthesis.getVoices()` returns an empty list on plenty of real
 * systems — a stripped Linux install, a locked-down browser, a headless
 * container (including every environment this file was developed in). When it
 * does, `speak()` still plays both artifacts and still emits the caption, so
 * the net reads as present and the information still arrives. That is the
 * primary path here, not a fallback bolted on afterwards.
 *
 * It also means `utterance.onend` cannot be relied on: with no voice, Chrome
 * may fire `onerror`, or nothing at all. Every utterance therefore carries a
 * timer that closes the channel regardless, or the static bed would run
 * forever on the first line ever spoken.
 *
 * ## Presentation only
 *
 * Nothing here touches `stateHash`, `snapshot`, or a simulated value — audio is
 * presentation, and a peer hearing different chatter is cosmetic by
 * construction. `Math.random` is used freely for line variation, exactly as
 * `synth.js`'s `variedSeed()` already is.
 */
import { playGlobal } from './audio.js';

/** Reserved event ids for the three artifacts. Bindable in the Sound Creator —
 * the `radio-squelch`, `radio-static` and `radio-blip` presets exist for them. */
export const RADIO_OPEN = 'radioOpen';
export const RADIO_STATIC = 'radioStatic';
export const RADIO_CLOSE = 'radioClose';

/**
 * How each kind of crew sounds.
 *
 * Keyed by the tags `src/vehicles/catalog.js` already carries, so no vehicle
 * def needs a new field: a scout is `recon`, a tank is `combat`, the base
 * station is `command`. `pitch` and `rate` are the only two expressive
 * controls the Web Speech API offers, so they carry the whole characterisation.
 */
export const VOICE_CLASSES = {
  recon: { label: 'Scout', pitch: 1.35, rate: 1.15 },
  combat: { label: 'Armour', pitch: 0.8, rate: 0.95 },
  economy: { label: 'Harvester', pitch: 1.05, rate: 1.0 },
  support: { label: 'Engineer', pitch: 1.15, rate: 1.05 },
  command: { label: 'Command', pitch: 0.7, rate: 0.9 },
};

export const DEFAULT_VOICE_CLASS = 'command';

/**
 * The voice class for a vehicle def, from tags it already has.
 *
 * Ordered rather than first-match-wins on the def's own array: `scout-buggy`
 * is tagged `['recon', 'combat']`, and it should read as a scout, not as
 * armour. So the *preference* order lives here, not in the catalog.
 */
const CLASS_PRIORITY = ['command', 'recon', 'support', 'economy', 'combat'];

export function voiceClassFor(def) {
  const tags = def?.tags;
  if (!Array.isArray(tags)) return DEFAULT_VOICE_CLASS;
  for (const candidate of CLASS_PRIORITY) {
    if (tags.includes(candidate)) return candidate;
  }
  return DEFAULT_VOICE_CLASS;
}

/** Seconds to assume a line lasts when the platform gives us no `onend`. */
const FALLBACK_SECONDS_PER_WORD = 0.42;
const FALLBACK_MIN_SECONDS = 0.9;
const FALLBACK_MAX_SECONDS = 6;

let radioVolume = 0.8;
let speaking = false;
/** The close-the-channel timer, so a superseding line cannot leave two running. */
let closeTimer = null;

export const getRadioVolume = () => radioVolume;
export function setRadioVolume(v) {
  radioVolume = Math.min(1, Math.max(0, Number(v) || 0));
}

export const isSpeaking = () => speaking;

/** Available TTS voices, or [] where there are none. Never throws. */
export function availableVoices() {
  try {
    return typeof speechSynthesis === 'undefined' ? [] : (speechSynthesis.getVoices() ?? []);
  } catch {
    return [];
  }
}

/**
 * Nudge the speech engine awake on a real user gesture.
 *
 * Chrome refuses to speak before user activation, the same rule that keeps the
 * AudioContext suspended — so this is called from the identical
 * `pointerdown` handler in main.js rather than from a second gesture hook of
 * its own. `getVoices()` is also asynchronous on Chrome and returns [] until
 * the voice list has loaded, so touching it here starts that load early.
 */
export function primeSpeech() {
  try {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.getVoices();
    if (speechSynthesis.paused) speechSynthesis.resume();
  } catch {
    // A browser that throws here simply has no speech. The artifacts and the
    // captions still work, which is the whole point of the design.
  }
}

/** How long to hold the channel open when the platform will not tell us. */
function estimateSeconds(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.min(FALLBACK_MAX_SECONDS, Math.max(FALLBACK_MIN_SECONDS, words * FALLBACK_SECONDS_PER_WORD));
}

/**
 * Say one line over the radio.
 *
 * The artifacts play unconditionally; the voice is attempted and may silently
 * not happen. `onDone` always fires exactly once — the chatter scheduler uses
 * it to know when the channel is free, so a path that could skip it would
 * wedge the whole net after one line.
 *
 * @param {string} text what is said
 * @param {object} [opts]
 * @param {string} [opts.voiceClass] a key of VOICE_CLASSES
 * @param {() => void} [opts.onDone] called once when the channel closes
 * @returns {boolean} whether the channel was opened (false if muted)
 */
export function speak(text, { voiceClass = DEFAULT_VOICE_CLASS, onDone } = {}) {
  if (radioVolume <= 0) {
    // Muted is not "queue it for later" — a player who turned the radio off
    // should not get a backlog when they turn it back on.
    onDone?.();
    return false;
  }

  const voice = VOICE_CLASSES[voiceClass] ?? VOICE_CLASSES[DEFAULT_VOICE_CLASS];
  speaking = true;

  playGlobal(RADIO_OPEN, null, radioVolume);
  // The bed is started as a one-shot rather than a loop: it is short, and a
  // loop would need stopping, which is exactly the thing that goes wrong when
  // `onend` never fires.
  playGlobal(RADIO_STATIC, null, radioVolume * 0.5);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(closeTimer);
    closeTimer = null;
    speaking = false;
    playGlobal(RADIO_CLOSE, null, radioVolume);
    onDone?.();
  };

  let spoke = false;
  try {
    if (typeof SpeechSynthesisUtterance !== 'undefined' && availableVoices().length > 0) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.pitch = voice.pitch;
      utterance.rate = voice.rate;
      utterance.volume = radioVolume;
      utterance.onend = close;
      utterance.onerror = close;
      speechSynthesis.speak(utterance);
      spoke = true;
    }
  } catch {
    spoke = false;
  }

  // Always armed, even when `spoke` is true: `onend` is unreliable across
  // browsers and does not fire at all if the utterance is cancelled. The timer
  // is the guarantee that the channel closes; `onend` just closes it sooner.
  closeTimer = setTimeout(close, estimateSeconds(text) * 1000 + (spoke ? 400 : 0));
  return true;
}

/** Stop mid-line and close the channel — used when a match ends. */
export function cancelSpeech() {
  try {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  } catch {
    // Nothing to cancel.
  }
  clearTimeout(closeTimer);
  closeTimer = null;
  speaking = false;
}
