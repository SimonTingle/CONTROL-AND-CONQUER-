/**
 * The lobby's guard against calling `onStart` more than once for one match.
 *
 * `startOnlineMatch` -> `beginMatch` -> `deployStartingForces` is purely
 * additive: it spawns each team's starting base and scout without clearing
 * anything first. Call it twice on the same world and every vehicle doubles —
 * confirmed live: a client that fell into this in the field reported 8
 * vehicles where 4 was correct. `LobbyScreen` had two independent ways to
 * reach it twice: the host's own click in `start()` racing a poll's
 * `refresh()` seeing the same status change moments later, and an in-flight
 * `refresh()` resuming after `hide()` had already fired for an earlier one.
 * `this.entered` is the latch that closes both.
 *
 * No jsdom dependency: LobbyScreen's DOM usage is a small, fixed surface
 * (createElement, classList, append/appendChild, replaceChildren,
 * addEventListener), stubbed here rather than adding a browser dependency
 * to keep `npm test` running in plain Node, no database, no network.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LobbyScreen } from '../src/ui/lobbyScreen.js';

function fakeElement() {
  const el = {
    className: '',
    textContent: '',
    type: '',
    children: [],
    listeners: {},
    classList: {
      add(c) { el._classes ??= new Set(); el._classes.add(c); },
      remove(c) { el._classes?.delete(c); },
      contains(c) { return !!el._classes?.has(c); },
    },
    appendChild(child) { el.children.push(child); return child; },
    append(...kids) { el.children.push(...kids); },
    replaceChildren(...kids) { el.children = [...kids]; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
  };
  return el;
}

function installFakeDom() {
  globalThis.document = {
    createElement: () => fakeElement(),
    body: fakeElement(),
  };
}

/** A match API whose `getMatch` resolves only when the test says to. */
function fakeApi({ maxPlayers = 2 } = {}) {
  let releaseGetMatch = null;
  const pendingGetMatch = new Promise((res) => { releaseGetMatch = res; });
  return {
    listMatches: async () => [],
    createMatch: async () => ({ id: 'm1', maxPlayers, status: 'open' }),
    joinMatch: async () => ({ match: { id: 'm1', maxPlayers, status: 'open' } }),
    startMatch: async () => {},
    getMatch: async () => {
      await pendingGetMatch;
      return { match: { id: 'm1', maxPlayers, status: 'running' }, players: [] };
    },
    leaveMatch: async () => {},
    /** Test control: let a stuck `getMatch` resolve. */
    _release: () => releaseGetMatch(),
  };
}

test('start() and an in-flight refresh() racing it fire onStart only once', async () => {
  installFakeDom();
  const api = fakeApi();
  const started = [];
  const lobby = new LobbyScreen({ api, onStart: (id) => started.push(id), onBack: () => {} });
  lobby.show();
  lobby.current = { id: 'm1', maxPlayers: 2, status: 'open' };
  lobby.isHost = true;

  // A poll begins — its getMatch() is in flight and will not resolve until
  // released below, simulating a slow request outliving the host's own click.
  const refreshPromise = lobby.refresh();

  // The host clicks Start while that poll is still in flight.
  await lobby.start();
  assert.deepEqual(started, ['m1'], 'the host\'s own click fires onStart');

  // Now let the stale poll's request resolve. Pre-fix, this was the second
  // call: `hide()` (called by the poll's own status==='running' branch)
  // cannot cancel a request already in flight, so onStart fired again on top
  // of the world the first call had already built.
  api._release();
  await refreshPromise;

  assert.deepEqual(started, ['m1'], 'onStart fired exactly once, not twice');
  lobby.stopPolling(); // show() started a setInterval; nothing else stops it here
});

test('two overlapping refresh() polls fire onStart only once', async () => {
  installFakeDom();
  const api = fakeApi();
  const started = [];
  const lobby = new LobbyScreen({ api, onStart: (id) => started.push(id), onBack: () => {} });
  lobby.show();
  lobby.current = { id: 'm1', maxPlayers: 2, status: 'open' };

  // Two polls in flight at once — a slow connection can produce this without
  // any user action at all.
  const first = lobby.refresh();
  const second = lobby.refresh();

  api._release();
  await Promise.all([first, second]);

  assert.deepEqual(started, ['m1'], 'both polls observed the same match; only one may act on it');
  lobby.stopPolling();
});

test('show() resets the latch for a fresh visit to the lobby', async () => {
  installFakeDom();
  const api = fakeApi();
  const started = [];
  const lobby = new LobbyScreen({ api, onStart: (id) => started.push(id), onBack: () => {} });

  lobby.show();
  lobby.current = { id: 'm1', maxPlayers: 2, status: 'open' };
  lobby.isHost = true;
  await lobby.start();
  assert.equal(lobby.entered, true, 'latched after a real start');

  // A brand new visit to the lobby (e.g. after a match ends and the player
  // returns to host another) must not still be latched from the last one.
  lobby.show();
  assert.equal(lobby.entered, false, 'show() begins a fresh visit');
  lobby.stopPolling();
});
