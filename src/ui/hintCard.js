/**
 * The card a hint appears in.
 *
 * Self-creating on first use, following `toast.js` and `radioFeed.js`: it
 * makes its own node and nothing else in the codebase has to know it exists.
 * Like the radio feed it is deliberately **not** inside `#hud` — `Hud.update`
 * hides that whole element whenever nothing is selected and there is no
 * economy yet, which is exactly the early-game window most of these hints
 * belong to.
 *
 * ## It must never be in the way
 *
 * The layer is full-width but `pointer-events: none`, with events re-enabled
 * only on the card itself — the same trick `.credit-burst-layer` uses. So the
 * player can still drag the camera, tap the ground and open a command ring
 * through the space around a hint. Only the OK button is a target, and it is
 * sized for a thumb.
 *
 * A hint is dismissed by pressing OK and by nothing else. There is no fade-out
 * timer, because a card that disappears while you are still reading it teaches
 * you to stop reading them.
 */

let layer = null;
let card = null;
let titleEl = null;
let textEl = null;
let okEl = null;
let dismissHandler = null;

function ensureCard() {
  if (card) return card;

  layer = document.createElement('div');
  layer.className = 'hint-layer';

  card = document.createElement('div');
  card.className = 'hint-card hidden';
  // Announced when it appears rather than interrupting immediately: this is
  // advice, not an alert, and it competes with nothing else on the page.
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');

  titleEl = document.createElement('div');
  titleEl.className = 'hint-card-title';

  textEl = document.createElement('div');
  textEl.className = 'hint-card-text';

  okEl = document.createElement('button');
  okEl.type = 'button';
  okEl.className = 'hint-card-ok';
  okEl.textContent = 'OK';
  okEl.addEventListener('click', () => dismissHandler?.());

  card.append(titleEl, textEl, okEl);
  layer.appendChild(card);
  document.body.appendChild(layer);
  return card;
}

/**
 * @param {object} hint
 * @param {string} hint.title
 * @param {string} hint.text
 * @param {() => void} onDismiss called when the player presses OK.
 */
export function showHintCard({ title, text }, onDismiss) {
  const node = ensureCard();
  dismissHandler = onDismiss;
  titleEl.textContent = title;
  textEl.textContent = text;
  node.classList.remove('hidden');
  return node;
}

export function hideHintCard() {
  card?.classList.add('hidden');
  dismissHandler = null;
}
