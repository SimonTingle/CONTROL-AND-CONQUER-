/**
 * The client half of the build-version handshake: the query param it sends on
 * connect, and how it reads a version disagreement back out of the wire.
 *
 * Deliberately does not exercise MatchClient's `connect()` — that needs a real
 * (or at least a real-shaped) WebSocket, which is what tests/e2e/two-client-
 * match.mjs's mismatch case covers end to end. This checks the two pieces that
 * are plain functions: the URL matchClient.js actually opens, and the message
 * it produces for a player when the two builds disagree.
 *
 * `__API_URL__` is a Vite build-time global; matchClient.js falls back to
 * `location` (a browser-only global) when it is unset, so it must be defined
 * before the module is imported here under plain Node.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__API_URL__ = 'http://api.example.test';

// server/src/ws/match.js's import chain reaches server/src/config.js, which
// refuses to load without a connection string, even though nothing exercised
// here touches the database — see match-room.test.mjs for the same guard.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { PROTOCOL_VERSION, socketUrl, versionMismatchMessage } =
  await import('../src/net/matchClient.js');

const { PROTOCOL_VERSION: SERVER_PROTOCOL_VERSION } = await import('../server/src/ws/match.js');

test('client and server agree on the protocol version constant', () => {
  // The two files can't share a module — they ship as separate deployables —
  // so nothing but this test catches one side being bumped without the other.
  assert.equal(PROTOCOL_VERSION, SERVER_PROTOCOL_VERSION);
});

test('the match socket URL declares this build\'s protocol version', () => {
  const url = socketUrl('abc123');
  assert.equal(url, `ws://api.example.test/ws/match/abc123?protocolVersion=${PROTOCOL_VERSION}`);
});

test('versionMismatchMessage names both versions when the server sent one', () => {
  const msg = versionMismatchMessage({ serverVersion: 7, clientVersion: PROTOCOL_VERSION });
  assert.match(msg, new RegExp(`v${PROTOCOL_VERSION}`));
  assert.match(msg, /v7/);
});

test('versionMismatchMessage still reads clearly against an unversioned old server', () => {
  // `welcome.protocolVersion` is `undefined` from a server that predates this
  // handshake entirely — the failure this whole feature exists to name instead
  // of leaving the two clients to desync silently.
  const msg = versionMismatchMessage({ serverVersion: undefined, clientVersion: PROTOCOL_VERSION });
  assert.match(msg, /older, unversioned build/);
});
