/**
 * The god-mode gate: exactly one account, matched exactly.
 *
 * `isGodModeAccount` is what `game.openBuilder()` and `game.openSoundCreator()`
 * in `main.js` check before opening either editor, and what the button row in
 * `portalScreen.js` checks before rendering the buttons at all — one
 * predicate, two enforcement points, so "only admin has access" holds even if
 * a future call site skips the button.
 *
 * Dependency-free: the predicate is a pure string comparison.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GOD_MODE_EMAIL, isGodModeAccount } from '../src/core/adminAccount.js';

test('the admin account passes', () => {
  assert.equal(isGodModeAccount({ email: GOD_MODE_EMAIL }), true);
});

test('no signed-in account fails', () => {
  assert.equal(isGodModeAccount(null), false);
  assert.equal(isGodModeAccount(undefined), false);
});

test('a different account fails', () => {
  assert.equal(isGodModeAccount({ email: 'someone.else@example.com' }), false);
});

test('a case-different email fails — exact match only, not case-insensitive', () => {
  // Loosening this to a case-insensitive match is a real security decision,
  // not a refactor, so it must not happen by accident.
  assert.equal(isGodModeAccount({ email: GOD_MODE_EMAIL.toUpperCase() }), false);
});

test('an account with no email fails', () => {
  assert.equal(isGodModeAccount({}), false);
});
