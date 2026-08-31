/**
 * The radio caption feed — the last few lines your units said.
 *
 * **This is not decoration.** `speechSynthesis.getVoices()` returns an empty
 * list on plenty of real systems, and on every environment this was developed
 * in. When it does, the radio still plays its squelch and static but says no
 * words, and this feed becomes the *only* carrier of what was actually
 * communicated. So it is built to stand alone, not to caption something that
 * is assumed to be audible.
 *
 * Self-creating, following `toast.js`: it makes its own node on first use and
 * nothing else has to know it exists.
 *
 * **Deliberately not inside `#hud`.** `Hud.update` ends with
 * `root.classList.toggle('hidden', !economyActive && !vehicle)` — the HUD
 * hides itself whenever nothing is selected and there is no economy yet. A
 * feed placed in there would disappear during the entire scouting game, which
 * is exactly when the radio has the most to say.
 */

/** Lines kept on screen. Enough to catch an exchange plus context; few enough
 * that it stays a radio net rather than a chat log. */
const MAX_LINES = 5;
/** How long a line stays before fading. Comfortably longer than the slowest
 * utterance, so the text never vanishes mid-sentence. */
const LINE_SECONDS = 9;

let root = null;

function ensureRoot() {
  if (root) return root;
  root = document.createElement('div');
  root.className = 'radio-feed';
  document.body.appendChild(root);
  return root;
}

/**
 * Add one line to the feed.
 *
 * @param {object} line
 * @param {string} line.speaker who is talking, e.g. "Scout"
 * @param {string} line.text what they said
 */
export function pushRadioLine({ speaker, text }) {
  const el = ensureRoot();

  const row = document.createElement('div');
  row.className = 'radio-line';

  const who = document.createElement('span');
  who.className = 'radio-speaker';
  who.textContent = `${speaker}:`;

  const what = document.createElement('span');
  what.className = 'radio-text';
  what.textContent = text;

  row.append(who, what);
  el.appendChild(row);

  while (el.childElementCount > MAX_LINES) el.removeChild(el.firstElementChild);

  // Each row expires on its own timer rather than the feed being swept on a
  // tick: nothing else here runs per frame, and a radio that needed a game
  // loop to clear its own text would be a strange dependency.
  setTimeout(() => {
    row.classList.add('radio-line-out');
    setTimeout(() => row.remove(), 600);
  }, LINE_SECONDS * 1000);
}

/** Clear the feed — a new match is a new net. */
export function clearRadioFeed() {
  root?.replaceChildren();
}
