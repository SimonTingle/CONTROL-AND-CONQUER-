/**
 * Cross-site bearer auth: the credential parsers on both ends.
 *
 * The reason this exists is in docs/plans/itch-io-cross-site-session.md — the
 * itch.io build is served third-party, browsers drop its session cookie
 * whatever SameSite says, and the session has to travel as a token instead.
 *
 * Deliberately unit-scope. Both functions under test are plain string parsers
 * with no database and no socket, which is exactly what `npm test` is allowed
 * to cover (see CLAUDE.md). Whether a real Safari actually keeps the token is
 * not a claim any test here can make, and is recorded as unverified in the
 * plan instead.
 *
 * Run: node --test tests/bearer-auth.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { bearerToken, subprotocolToken, WS_BEARER_PROTOCOL } = await import(
  '../server/src/auth/credentials.js'
);

test('bearerToken reads a well-formed Authorization header', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
});

test('bearerToken ignores anything that is not a Bearer credential', () => {
  // Basic auth must not be mistaken for a session token: the value after the
  // scheme is a base64 password, and accepting it would send it to
  // userForToken as if it were one.
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc123' } }), null);
  assert.equal(bearerToken({ headers: { authorization: 'Bearer' } }), null);
  assert.equal(bearerToken({ headers: {} }), null);
  assert.equal(bearerToken({}), null);
});

test('bearerToken keeps a token containing spaces intact', () => {
  // The regex is greedy on purpose. A non-greedy or split-on-space parse would
  // silently truncate a token to its first word and produce a puzzling 401
  // rather than an obvious parse failure.
  assert.equal(bearerToken({ headers: { authorization: 'Bearer a b c' } }), 'a b c');
});

test('subprotocolToken reads the token a browser WebSocket smuggled as a subprotocol', () => {
  const req = { headers: { 'sec-websocket-protocol': `${WS_BEARER_PROTOCOL}, tok123` } };
  assert.equal(subprotocolToken(req), 'tok123');
});

test('subprotocolToken ignores a subprotocol list that is not ours', () => {
  // A same-site client sends no subprotocol at all and must be unaffected —
  // it authenticates by cookie and this parser has to stay out of its way.
  assert.equal(subprotocolToken({ headers: {} }), null);
  assert.equal(subprotocolToken({ headers: { 'sec-websocket-protocol': 'graphql-ws' } }), null);
  // The marker with nothing after it is not a credential.
  assert.equal(
    subprotocolToken({ headers: { 'sec-websocket-protocol': WS_BEARER_PROTOCOL } }),
    null
  );
});

test('subprotocolToken requires the marker, not merely a second list entry', () => {
  // The marker check is the whole guard, and it is easy to write a parser that
  // just takes the second element — which would read an arbitrary subprotocol
  // negotiated by some unrelated client as a session token and hand it to
  // userForToken. Reaching for the second entry without checking the first is
  // the specific mistake this pins.
  assert.equal(
    subprotocolToken({ headers: { 'sec-websocket-protocol': 'graphql-ws, soap' } }),
    null
  );
});
