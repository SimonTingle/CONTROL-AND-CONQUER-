/**
 * The one account god mode is for.
 *
 * Extracted from `portalScreen.js`, which previously held this as an inline
 * string literal (`user?.email === 'tingleteaching@gmail.com'`) checked in
 * exactly one place: whether the God Mode / Sound Creator buttons render.
 * That gated the only *reachable* path for an ordinary player, but the
 * launcher functions themselves — `game.openBuilder()` and
 * `game.openSoundCreator()` in `main.js` — had no check of their own. Nothing
 * stopped them being opened except that nothing else called them; a future
 * call site (a shortcut, a debug hook) would silently inherit no gate at all.
 *
 * One constant and one predicate here, used at both the button's render and
 * at each launcher's entry, so "only admin has access" is enforced by the
 * thing that actually opens the editor rather than only by whether a button
 * happened to be drawn.
 *
 * Not a general-purpose role system — there is exactly one admin account,
 * matched by an exact string, on purpose: broadening this to a role list or a
 * case-insensitive match is a real security decision and shouldn't happen as
 * a side effect of moving the string to a new file.
 */
export const GOD_MODE_EMAIL = 'tingleteaching@gmail.com';

/** @param {{email?: string}|null} user */
export const isGodModeAccount = (user) => user?.email === GOD_MODE_EMAIL;
