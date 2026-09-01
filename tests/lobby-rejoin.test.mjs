/**
 * `LobbyScreen.checkForOwnMatch()` — finding a way back into a match after a
 * reload.
 *
 * Found during a multiplayer pressure test: `GET /matches` (the browse list)
 * only ever lists `status = 'open'`, on purpose — a running match should not
 * look joinable to a stranger. But a match's id otherwise lived only in this
 * screen's own `current` field, which any reload, crash, or closed tab wipes.
 * Reproduced directly in the browser: reload a connected host's tab mid-match
 * and the guest's session stalls (the roster-quorum design in
 * `server/src/ws/match.js` pauses rather than shrinks) with no route back for
 * *either* side — the host included, even though they created the match.
 *
 * `/matches/mine` (new route, `server/src/routes/matches.js`) answers "does
 * this signed-in user have an open-or-running match?" `show()` now checks it
 * before falling back to the ordinary browse list.
 *
 * No jsdom dependency — same fake-DOM approach as lobby-reentry.test.mjs, to
 * keep `npm test` dependency-free.
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

function fakeApi({ getMyMatch }) {
  return {
    listMatches: async () => [],
    getMatch: async () => ({ match: null, players: [] }),
    getMyMatch,
    leaveMatch: async () => {},
  };
}

test('show() rejoins a running match it finds via /matches/mine', async () => {
  installFakeDom();
  const started = [];
  const api = fakeApi({
    getMyMatch: async () => ({
      match: { id: 'm1', hostUserId: 'host-1', maxPlayers: 2, status: 'running' },
      players: [],
    }),
  });
  const lobby = new LobbyScreen({
    api,
    onStart: (id) => started.push(id),
    onBack: () => {},
    getAccount: () => ({ id: 'guest-1' }),
  });

  lobby.show();
  await lobby.checkForOwnMatch(); // show() fires this un-awaited; await it directly here

  assert.deepEqual(started, ['m1'], 'a running match found via /matches/mine is rejoined automatically');
  assert.equal(lobby.isHost, false, 'guest-1 is not m1\'s host');
  lobby.stopPolling();
});

test('show() re-enters the waiting room for an own match still open (not yet started)', async () => {
  installFakeDom();
  const started = [];
  const api = fakeApi({
    getMyMatch: async () => ({
      match: { id: 'm1', hostUserId: 'host-1', maxPlayers: 2, status: 'open' },
      players: [{ userId: 'host-1', teamId: 0, displayName: 'Host' }],
    }),
  });
  const lobby = new LobbyScreen({
    api,
    onStart: (id) => started.push(id),
    onBack: () => {},
    getAccount: () => ({ id: 'host-1' }),
  });

  lobby.show();
  await lobby.checkForOwnMatch();

  assert.deepEqual(started, [], 'an open (not yet running) match does not fire onStart');
  assert.equal(lobby.current?.id, 'm1');
  assert.equal(lobby.isHost, true, 'host-1 is m1\'s host');
  lobby.stopPolling();
});

test('show() falls back to the ordinary browse list when there is no own match', async () => {
  installFakeDom();
  const started = [];
  const api = fakeApi({ getMyMatch: async () => ({ match: null }) });
  const lobby = new LobbyScreen({ api, onStart: (id) => started.push(id), onBack: () => {} });

  lobby.show();
  await lobby.checkForOwnMatch();

  assert.deepEqual(started, []);
  assert.equal(lobby.current, null, 'nothing to rejoin — current stays unset');
  lobby.stopPolling();
});

test('a failed /matches/mine request does not block the lobby from opening', async () => {
  installFakeDom();
  const started = [];
  const api = fakeApi({ getMyMatch: async () => { throw new Error('network_unreachable'); } });
  const lobby = new LobbyScreen({ api, onStart: (id) => started.push(id), onBack: () => {} });

  lobby.show();
  await assert.doesNotReject(lobby.checkForOwnMatch());

  assert.deepEqual(started, []);
  // panel got *something* rendered rather than being left blank/stuck.
  assert.ok(lobby.panel.children.length > 0, 'the browse list still rendered despite the failed lookup');
  lobby.stopPolling();
});

test('show() actually calls checkForOwnMatch() — not just renderBrowser()', async () => {
  // Every other test in this file calls checkForOwnMatch() directly so it can
  // await it deterministically, which means none of them would catch show()
  // itself losing the wiring — confirmed by hand: reverting `show()` to call
  // `renderBrowser()` alone left every other test here still green. This one
  // spies on the method instead, so the wiring is what's under test.
  installFakeDom();
  const api = fakeApi({ getMyMatch: async () => ({ match: null }) });
  const lobby = new LobbyScreen({ api, onStart: () => {}, onBack: () => {} });

  let calls = 0;
  const real = lobby.checkForOwnMatch.bind(lobby);
  lobby.checkForOwnMatch = () => { calls++; return real(); };

  lobby.show();
  await new Promise((r) => setTimeout(r, 0)); // let the un-awaited call settle

  assert.equal(calls, 1, 'show() must call checkForOwnMatch()');
  lobby.stopPolling();
});

test('a rejoin found after entered has already latched (a race with the poll loop) is a no-op', async () => {
  installFakeDom();
  const started = [];
  const api = fakeApi({
    getMyMatch: async () => ({
      match: { id: 'm1', hostUserId: 'host-1', maxPlayers: 2, status: 'running' },
      players: [],
    }),
  });
  const lobby = new LobbyScreen({ api, onStart: (id) => started.push(id), onBack: () => {}, getAccount: () => ({ id: 'guest-1' }) });

  lobby.show();
  lobby.entered = true; // something else (e.g. an overlapping poll) already acted
  await lobby.checkForOwnMatch();

  assert.deepEqual(started, [], 'entered guards this path exactly as it guards refresh()');
  lobby.stopPolling();
});
