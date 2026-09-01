/**
 * A small, always-on commit stamp in the corner of the screen.
 *
 * Follows a real production report: two players on real devices, hitting a
 * multiplayer disconnect, with no quick way to confirm both were even on the
 * same build. The version was already computed at build time
 * (`__APP_VERSION__`, see vite.config.js) and logged to the console — but a
 * console line is invisible on a phone, and PR #108's fix for the deploy
 * itself stamping `'unknown'` only helps if someone can see the result.
 *
 * Deliberately not the perf HUD (`perfHud.js`): that one is opt-in
 * (`?perf=1` or the `p` key) and disappears with everything else it shows.
 * This one is meant to be glanced at without any setup, on both a phone and
 * a desktop, which is why it stays out of the top-left corner the hamburger
 * button already owns.
 */
// `typeof` guarded like api.js's __API_URL__ and matchClient.js's
// PROTOCOL_VERSION comment describes: __APP_VERSION__ is a Vite build-time
// global with no define step in a plain Node import (a dependency-free test
// importing this module has none), so a bare reference would throw
// ReferenceError rather than just being undefined.
const BUILD_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';

export function mountVersionBadge(version = BUILD_VERSION) {
  const el = document.createElement('div');
  el.id = 'version-badge';
  el.textContent = version;
  el.setAttribute('aria-hidden', 'true'); // decorative diagnostic text, not content
  document.body.appendChild(el);
  return el;
}
