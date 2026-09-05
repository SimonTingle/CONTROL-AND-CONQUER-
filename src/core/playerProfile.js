/**
 * The only thing this game remembers about *you* between sessions.
 *
 * Nothing here is simulation state and nothing here is ever serialised into a
 * save or sent over the wire. It exists to answer two questions the hint
 * system asks: how many matches has this person started, and which hints have
 * they already been shown.
 *
 * ## Why local rather than on the account
 *
 * The obvious home for "matches played" is the `users` table, and it isn't
 * used, for two reasons. Accounts are entirely optional here — a build with no
 * API server configured hides every sign-in affordance (`src/net/api.js`), and
 * a first-time player is exactly the person least likely to have registered,
 * so an account-backed novice test would be blind to precisely the audience it
 * exists to serve. And a hint you have already dismissed reappearing because
 * you signed out is worse than one that doesn't follow you to a new device.
 *
 * ## Every read must survive a hostile store
 *
 * Safari in private mode throws on `localStorage` access rather than failing
 * soft — `src/net/api.js`'s token accessor is wrapped for that exact reason
 * and this follows it. A corrupt or hand-edited value must also yield defaults
 * rather than a parse error: this module is imported during boot, and a
 * throwing profile read would take the whole game down over a stale string.
 */

const KEY = 'ptg-profile';

/**
 * Matches after which hints stop offering themselves.
 *
 * Three is a judgement call, not a measurement. One match is not enough to
 * have met the economy at all; by the fourth the player has either learned the
 * loop or turned the hints off, and continuing to volunteer them past that
 * point is how a tutorial becomes a nag.
 */
export const NOVICE_MATCHES = 3;

const DEFAULTS = {
  matchesStarted: 0,
  /** Hint ids already shown and dismissed. Once ever, not once per match. */
  seenHints: [],
  /**
   * Tri-state on purpose. `null` means "never expressed a preference", which
   * is what lets the novice heuristic apply at all — an explicit `true` or
   * `false` from the settings toggle outranks it in both directions, so a
   * veteran can switch hints back on for a friend and a fast learner can
   * silence them on match one.
   */
  hintsEnabled: null,
};

/** @returns {typeof DEFAULTS} never throws; returns defaults on any failure. */
export function getProfile() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { ...DEFAULTS };
  }
  if (!raw) return { ...DEFAULTS };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };

  // Field-by-field rather than a spread, so a value of the wrong type — from
  // an older build or a hand edit — is replaced instead of propagated into
  // code that expects to be able to call .includes() on it.
  return {
    matchesStarted:
      Number.isFinite(parsed.matchesStarted) && parsed.matchesStarted >= 0
        ? parsed.matchesStarted
        : DEFAULTS.matchesStarted,
    seenHints: Array.isArray(parsed.seenHints)
      ? parsed.seenHints.filter((id) => typeof id === 'string')
      : [],
    hintsEnabled:
      typeof parsed.hintsEnabled === 'boolean' ? parsed.hintsEnabled : null,
  };
}

function write(profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Storage unavailable or full. Hints then behave as if this were a first
    // match every time, which is mildly repetitive and entirely playable —
    // far better than throwing at the start of every match.
  }
}

/** Call once per match start. Drives the novice test. */
export function recordMatchStarted() {
  const profile = getProfile();
  profile.matchesStarted += 1;
  write(profile);
  return profile.matchesStarted;
}

export function hasSeenHint(id) {
  return getProfile().seenHints.includes(id);
}

export function markHintSeen(id) {
  const profile = getProfile();
  if (profile.seenHints.includes(id)) return;
  profile.seenHints.push(id);
  write(profile);
}

/**
 * Whether hints should offer themselves at all.
 *
 * An explicit preference wins; otherwise this is the novice test.
 */
export function hintsEnabled() {
  const profile = getProfile();
  if (typeof profile.hintsEnabled === 'boolean') return profile.hintsEnabled;
  return profile.matchesStarted <= NOVICE_MATCHES;
}

export function setHintsEnabled(value) {
  const profile = getProfile();
  profile.hintsEnabled = !!value;
  write(profile);
}

/**
 * Forget which hints have been shown, without touching the match count or the
 * on/off preference — "show me that again", not "pretend I am new".
 */
export function resetHints() {
  const profile = getProfile();
  profile.seenHints = [];
  write(profile);
}
