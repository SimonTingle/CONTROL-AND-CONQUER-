/**
 * A transient, non-blocking message — for things like autosave that fire in
 * the background and must never freeze play the way window.alert would.
 *
 * No toast/notification surface existed anywhere in this codebase before this
 * (every save/load confirmation today is a blocking window.alert, fine for an
 * explicit click, not for something that happens on its own every 5 minutes).
 * Self-contained rather than an index.html element: it creates its own node
 * on first use and reuses it after, so nothing else has to know it exists.
 */

let el = null;

function ensureEl() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'toast hidden';
  document.body.appendChild(el);
  return el;
}

let hideTimer = null;

/**
 * @param {string} message
 * @param {number} [durationMs]
 * @param {{label: string, onClick: () => void}} [action] an optional button.
 *   A toast carrying one does **not** auto-hide: it is offering the only way
 *   out of a state the player cannot otherwise leave (waiting on a peer who is
 *   never going to connect, say), and a way out that fades after three seconds
 *   is no way out at all.
 */
export function showToast(message, durationMs = 3000, action = null) {
  const node = ensureEl();
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(hideTimer);

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      node.classList.add('hidden');
      action.onClick();
    });
    node.appendChild(button);
    return;
  }

  // Restart the fade window on every call rather than letting an earlier
  // toast's timer hide a newer message out from under it.
  hideTimer = setTimeout(() => node.classList.add('hidden'), durationMs);
}
