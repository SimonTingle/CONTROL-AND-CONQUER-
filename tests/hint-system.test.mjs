/**
 * `HintSystem` — which hint appears, and, mostly, which one doesn't.
 *
 * The interesting behaviour of an on-screen hint system is all refusal. Almost
 * every rule in `ui/hintSystem.js` exists to stop a card appearing: the opening
 * quiet period, the gap between hints, the per-match ceiling, the suppression
 * while a menu is open, the persisted seen-list, and `retiredWhen` dropping a
 * hint the player has already outgrown. A test suite that only checked that
 * hints *can* show would miss the entire design.
 *
 * No DOM and no localStorage: `HintSystem` takes its profile and its
 * definitions as constructor arguments precisely so this can run as plain
 * objects, keeping `npm test` dependency-free. `playerProfile`'s own storage
 * handling is covered separately at the bottom with a fake global.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HintSystem,
  OPENING_QUIET_SECONDS,
  MIN_GAP_SECONDS,
  MAX_PER_MATCH,
} from '../src/ui/hintSystem.js';

/** A profile whose persistence is a Set, so a test can inspect it directly. */
function fakeProfile({ enabled = true, seen = [] } = {}) {
  const seenHints = new Set(seen);
  return {
    hintsEnabled: () => enabled,
    hasSeenHint: (id) => seenHints.has(id),
    markHintSeen: (id) => seenHints.add(id),
  };
}

/** Minimal always-eligible definition. */
const def = (id, extra = {}) => ({
  id,
  modes: ['sandbox', 'multiplayer-ai', 'multiplayer-online'],
  priority: 1,
  title: id,
  text: `${id} text`,
  when: () => true,
  ...extra,
});

/** Collects what reached the screen. */
function makeSystem(defs, { profile = fakeProfile(), isTouch = false } = {}) {
  const shown = [];
  let visible = false;
  const system = new HintSystem({
    profile,
    defs,
    isTouch,
    onShow: (h) => {
      shown.push(h);
      visible = true;
    },
    onHide: () => {
      visible = false;
    },
  });
  return { system, shown, profile, isVisible: () => visible };
}

/** One observe() call worth `seconds`, with sane defaults for every gate. */
const ctx = (seconds, extra = {}) => ({
  dt: seconds,
  mode: 'sandbox',
  radialOpen: false,
  drawerOpen: false,
  underAttack: false,
  ...extra,
});

/** Advance past the opening quiet period in a single step. */
const PAST_QUIET = OPENING_QUIET_SECONDS + 1;

test('nothing fires during the opening quiet period', () => {
  const { system, shown } = makeSystem([def('a')]);
  system.observe(ctx(OPENING_QUIET_SECONDS - 1));
  assert.equal(shown.length, 0, 'a card in the first seconds is an obstacle, not an offer');
  system.observe(ctx(2));
  assert.equal(shown.length, 1);
});

test('only one hint is on screen at a time', () => {
  const { system, shown } = makeSystem([def('a'), def('b')]);
  system.observe(ctx(PAST_QUIET));
  system.observe(ctx(PAST_QUIET));
  assert.equal(shown.length, 1, 'the second hint must wait for the first to be dismissed');
});

test('the next hint waits out MIN_GAP_SECONDS after a dismissal', () => {
  const { system, shown } = makeSystem([def('a'), def('b')]);
  system.observe(ctx(PAST_QUIET));
  system.dismiss();

  system.observe(ctx(MIN_GAP_SECONDS - 1));
  assert.equal(shown.length, 1, 'hints must not chain one click after another');

  system.observe(ctx(2));
  assert.equal(shown.length, 2);
});

test('a match is capped at MAX_PER_MATCH hints', () => {
  const defs = Array.from({ length: MAX_PER_MATCH + 3 }, (_, i) => def(`h${i}`));
  const { system, shown } = makeSystem(defs);
  for (let i = 0; i < defs.length; i++) {
    system.observe(ctx(PAST_QUIET + MIN_GAP_SECONDS));
    system.dismiss();
  }
  assert.equal(shown.length, MAX_PER_MATCH);
});

test('highest priority wins when several are eligible', () => {
  const { system, shown } = makeSystem([
    def('low', { priority: 1 }),
    def('high', { priority: 9 }),
    def('mid', { priority: 5 }),
  ]);
  system.observe(ctx(PAST_QUIET));
  assert.equal(shown[0].id, 'high');
});

test('a hint is never shown twice, across matches', () => {
  const profile = fakeProfile();
  const { system, shown } = makeSystem([def('a')], { profile });
  system.observe(ctx(PAST_QUIET));
  system.dismiss();
  assert.ok(profile.hasSeenHint('a'), 'dismissing must persist, not just hide');

  system.reset(); // a new match
  system.observe(ctx(PAST_QUIET + MIN_GAP_SECONDS));
  assert.equal(shown.length, 1, 'a dismissed hint must not come back next match');
});

test('retiredWhen drops a hint unfired when the player works it out first', () => {
  const defs = [def('gesture', { retiredWhen: (c) => c.hasOpenedRadial })];
  const { system, shown, profile } = makeSystem(defs);

  system.observe(ctx(PAST_QUIET, { hasOpenedRadial: true }));
  assert.equal(shown.length, 0, 'competence is the real dismissal');
  assert.ok(
    !profile.hasSeenHint('gesture'),
    'retiring is per-match: unread, so still owed on a later match',
  );
});

test('retirement is evaluated even while a card is already up', () => {
  const defs = [
    def('first', { priority: 9 }),
    def('gesture', { priority: 1, retiredWhen: (c) => c.hasOpenedRadial }),
  ];
  const { system, shown } = makeSystem(defs);

  system.observe(ctx(PAST_QUIET));
  assert.equal(shown[0].id, 'first');
  // The player opens a command ring while the first card is still up.
  system.observe(ctx(1, { hasOpenedRadial: true }));
  system.dismiss();
  system.observe(ctx(MIN_GAP_SECONDS + 1));

  assert.equal(shown.length, 1, 'a hint retired behind a visible card must stay retired');
});

test('hints are suppressed while the player is mid-decision or under attack', () => {
  for (const gate of ['radialOpen', 'drawerOpen', 'underAttack']) {
    const { system, shown } = makeSystem([def('a')]);
    system.observe(ctx(PAST_QUIET, { [gate]: true }));
    assert.equal(shown.length, 0, `${gate} must hold a hint back`);
    system.observe(ctx(1));
    assert.equal(shown.length, 1, `${gate} clearing must release it`);
  }
});

test('mode-specific hints do not leak between modes', () => {
  const defs = [
    { ...def('online-only'), modes: ['multiplayer-online'] },
    { ...def('sandbox-only'), modes: ['sandbox'] },
  ];
  const { system, shown } = makeSystem(defs);
  system.observe(ctx(PAST_QUIET, { mode: 'sandbox' }));
  assert.equal(shown[0].id, 'sandbox-only');
});

test('textTouch replaces text on a touch device, and only there', () => {
  const defs = [def('a', { text: 'double-click', textTouch: 'press and hold' })];

  const touch = makeSystem(defs, { isTouch: true });
  touch.system.observe(ctx(PAST_QUIET));
  assert.equal(touch.shown[0].text, 'press and hold');

  const desktop = makeSystem(defs, { isTouch: false });
  desktop.system.observe(ctx(PAST_QUIET));
  assert.equal(desktop.shown[0].text, 'double-click');
});

test('disabled hints show nothing, and clear a card already on screen', () => {
  let enabled = true;
  const profile = {
    seen: new Set(),
    hintsEnabled: () => enabled,
    hasSeenHint(id) { return this.seen.has(id); },
    markHintSeen(id) { this.seen.add(id); },
  };
  const { system, shown, isVisible } = makeSystem([def('a')], { profile });

  system.observe(ctx(PAST_QUIET));
  assert.ok(isVisible(), 'precondition: a card is up');

  enabled = false;
  system.observe(ctx(1));
  assert.ok(!isVisible(), 'turning hints off must take the visible card with it');
  assert.ok(!profile.hasSeenHint('a'), 'switching off is not reading — the hint is still owed');

  enabled = true;
  system.observe(ctx(MIN_GAP_SECONDS + 1));
  assert.equal(shown.length, 2, 'and it is offered again once hints are back on');
});

test('the real hint catalogue has unique ids and valid modes', async () => {
  const { HINT_DEFS } = await import('../src/ui/hintDefs.js');
  const ids = HINT_DEFS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are persisted keys — duplicates collide');
  const known = new Set(['sandbox', 'multiplayer-ai', 'multiplayer-online']);
  for (const d of HINT_DEFS) {
    assert.ok(d.modes.length > 0 && d.modes.every((m) => known.has(m)), `${d.id} has a bad mode`);
    assert.equal(typeof d.when, 'function', `${d.id} needs a readiness test`);
  }
});

// ---- playerProfile: the storage wrapper must never throw ----

/** Installs a localStorage stand-in and returns a restore function. */
function withStorage(impl) {
  const had = 'localStorage' in globalThis;
  const prev = globalThis.localStorage;
  globalThis.localStorage = impl;
  return () => {
    if (had) globalThis.localStorage = prev;
    else delete globalThis.localStorage;
  };
}

test('a corrupt stored profile yields defaults rather than throwing', async () => {
  const restore = withStorage({
    getItem: () => '{not json at all',
    setItem: () => {},
  });
  try {
    const { getProfile } = await import(`../src/core/playerProfile.js?t=${Date.now()}-a`);
    const profile = getProfile();
    assert.equal(profile.matchesStarted, 0);
    assert.deepEqual(profile.seenHints, []);
  } finally {
    restore();
  }
});

test('a profile with wrong-typed fields is repaired, not propagated', async () => {
  const restore = withStorage({
    getItem: () => JSON.stringify({ matchesStarted: 'lots', seenHints: 'nope', hintsEnabled: 1 }),
    setItem: () => {},
  });
  try {
    const { getProfile } = await import(`../src/core/playerProfile.js?t=${Date.now()}-b`);
    const profile = getProfile();
    assert.equal(profile.matchesStarted, 0);
    // The real bug this guards: seenHints.includes() on a string silently
    // "works" and matches substrings, so a bad value must be replaced.
    assert.deepEqual(profile.seenHints, []);
    assert.equal(profile.hintsEnabled, null, 'a non-boolean must not stand in for a preference');
  } finally {
    restore();
  }
});

test('a throwing localStorage (Safari private mode) does not break reads or writes', async () => {
  const restore = withStorage({
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
  });
  try {
    const mod = await import(`../src/core/playerProfile.js?t=${Date.now()}-c`);
    assert.deepEqual(mod.getProfile().seenHints, []);
    assert.doesNotThrow(() => mod.recordMatchStarted());
    assert.doesNotThrow(() => mod.markHintSeen('a'));
    assert.doesNotThrow(() => mod.setHintsEnabled(false));
  } finally {
    restore();
  }
});

test('hints default on for a novice and off once past NOVICE_MATCHES', async () => {
  let stored = JSON.stringify({ matchesStarted: 1, seenHints: [], hintsEnabled: null });
  const restore = withStorage({
    getItem: () => stored,
    setItem: (_k, v) => { stored = v; },
  });
  try {
    const mod = await import(`../src/core/playerProfile.js?t=${Date.now()}-d`);
    assert.equal(mod.hintsEnabled(), true, 'match 1 is a novice');

    stored = JSON.stringify({ matchesStarted: mod.NOVICE_MATCHES + 1, seenHints: [], hintsEnabled: null });
    assert.equal(mod.hintsEnabled(), false, 'past the novice window they go quiet on their own');

    // An explicit preference outranks the heuristic in both directions.
    mod.setHintsEnabled(true);
    assert.equal(mod.hintsEnabled(), true, 'a veteran can switch them back on');
  } finally {
    restore();
  }
});
