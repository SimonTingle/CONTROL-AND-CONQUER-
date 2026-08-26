/**
 * The lockstep start barrier and turn-release rules.
 *
 * These decide whether a match is playable at all, and they are the code that
 * failed in the field: two real players spent a whole match each simulating a
 * private world on the same map, neither ever seeing the other's units. The
 * cases below are that match, reduced to the room object it happened inside.
 *
 * Deliberately dependency-free — no database, no sockets, no browser. The room
 * is a plain object and these are plain rules over it, so they can be checked
 * in milliseconds instead of by standing up two clients and playing.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// A plain static import of the rules themselves. These used to be reached
// through `ws/match.js`, whose route handler imports `db/pool.js` — so this
// suite transitively required `pg` to be installed and died on
// ERR_MODULE_NOT_FOUND before running a single assertion. The rules now live
// in their own module with no database in the chain (see matchRoom.js's
// header), so the DATABASE_URL placeholder this file used to need is gone too.
import {
  createRoom,
  maybeBegin,
  releaseReadyTurns,
  reapSilent,
  TICKS_PER_TURN,
  checkProtocolVersion,
  PROTOCOL_VERSION,
} from '../server/src/ws/matchRoom.js';

/** A socket that records what it was sent, instead of owning a network. */
function fakeSocket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

function addPlayer(room, userId, teamId) {
  const socket = fakeSocket();
  room.players.set(userId, {
    socket,
    teamId,
    displayName: `p${userId}`,
    lastSeen: Date.now(),
  });
  return socket;
}

const framesOfType = (socket, t) => socket.sent.filter((m) => m.t === t);

test('a short-rostered room never begins, however long it waits', () => {
  const room = createRoom('m1', 123, 2);
  const alone = addPlayer(room, 'a', 0);

  maybeBegin(room);
  assert.equal(room.started, false, 'must not begin with 1 of 2 present');

  // Any amount of waiting. This is the exact regression: the room used to
  // begin here, which handed this player a solo match on a shared map.
  room.firstJoinAt = Date.now() - 10 * 60 * 1000;
  maybeBegin(room);

  assert.equal(room.started, false, 'waiting longer must not start it short');
  assert.equal(framesOfType(alone, 'begin').length, 0, 'no begin frame');
});

test('waiting past the report threshold names what is missing', () => {
  const room = createRoom('m2', 123, 2);
  const alone = addPlayer(room, 'a', 0);

  maybeBegin(room);
  assert.equal(framesOfType(alone, 'waiting').length, 0, 'silent while still fresh');

  room.firstJoinAt = Date.now() - 60 * 1000;
  maybeBegin(room);

  const [waiting] = framesOfType(alone, 'waiting');
  assert.ok(waiting, 'reports once the wait looks like a problem');
  assert.equal(waiting.present, 1);
  assert.equal(waiting.expected, 2);
});

test('the room begins the moment the roster completes', () => {
  const room = createRoom('m3', 123, 2);
  const a = addPlayer(room, 'a', 0);
  maybeBegin(room);
  assert.equal(room.started, false);

  const b = addPlayer(room, 'b', 1);
  maybeBegin(room);

  assert.equal(room.started, true);
  assert.equal(framesOfType(a, 'begin').length, 1, 'both are told, together');
  assert.equal(framesOfType(b, 'begin').length, 1);
});

test('nothing is released before the match begins', () => {
  const room = createRoom('m4', 123, 2);
  const a = addPlayer(room, 'a', 0);
  room.pending.set(0, new Map([['a', []]]));

  releaseReadyTurns(room);

  assert.equal(room.released, -1, 'an unstarted room releases nothing');
  assert.equal(framesOfType(a, 'turn').length, 0);
});

test('a turn is released only once every player has reported it', () => {
  const room = createRoom('m5', 123, 2);
  const a = addPlayer(room, 'a', 0);
  const b = addPlayer(room, 'b', 1);
  maybeBegin(room);

  room.pending.set(0, new Map([['a', [{ t: 'move' }]]]));
  releaseReadyTurns(room);
  assert.equal(room.released, -1, 'one player reporting is not a quorum');

  room.pending.get(0).set('b', []);
  releaseReadyTurns(room);
  assert.equal(room.released, 0, 'released once both have reported');
  assert.equal(framesOfType(a, 'turn').length, 1);
  assert.equal(framesOfType(b, 'turn').length, 1);
});

test('released input is ordered by teamId, not by arrival', () => {
  const room = createRoom('m6', 123, 2);
  const a = addPlayer(room, 'a', 1); // team 1 reports first…
  const b = addPlayer(room, 'b', 0); // …team 0 second
  maybeBegin(room);

  room.pending.set(0, new Map([['a', [{ tag: 'from-team-1' }]], ['b', [{ tag: 'from-team-0' }]]]));
  releaseReadyTurns(room);

  const [turn] = framesOfType(a, 'turn');
  assert.deepEqual(
    turn.inputs.map((i) => i.teamId),
    [0, 1],
    'every client must apply an identically ordered batch'
  );
});

test('a player who stops reporting input is never reaped for it — only a dead socket is', () => {
  // This used to be the opposite: a separate `lastInputAt` clock reaped anyone
  // who fell silent on turns, heartbeat or not. That was reaping the *symptom*
  // of a stall — `beginStep()` stops sending input the instant a turn is
  // missing, by design — so a peer correctly waiting on someone else looked
  // identical to a dead one and got dropped right along with it. Liveness
  // (`lastSeen`, refreshed by every message including the heartbeat) is the
  // only thing this file can actually observe from here.
  const room = createRoom('m7', 123, 2);
  const a = addPlayer(room, 'a', 0);
  addPlayer(room, 'b', 1);
  maybeBegin(room);

  // b has reported nothing for ages but is still answering heartbeats.
  room.players.get('b').lastSeen = Date.now();
  reapSilent(room);
  assert.equal(room.players.has('b'), true, 'a silent-but-connected peer is not reaped');
  assert.equal(framesOfType(a, 'playerLeft').length, 0);

  // Only a genuinely dead socket — no message of any kind in DROP_AFTER_MS —
  // is removed.
  room.players.get('b').lastSeen = Date.now() - 60 * 1000;
  reapSilent(room);
  assert.equal(room.players.has('b'), false, 'a truly dead socket is still reaped');
  const [left] = framesOfType(a, 'playerLeft');
  assert.equal(left.reason, 'timeout');
});

test('the whole roster is required regardless of session.started — reapSilent never releases a turn by itself', () => {
  const room = createRoom('m8', 123, 2);
  addPlayer(room, 'a', 0);
  room.players.get('a').lastSeen = Date.now();

  reapSilent(room);

  assert.equal(room.players.has('a'), true, 'a live, connected player is never reaped');
});

test('reaping a dead peer does NOT unblock the turns it was holding — the match pauses, it does not run ahead', () => {
  // The exact regression from the field report. `releaseReadyTurns` used to
  // gate on `room.players.size` — the connected count — so the instant the
  // stalled peer's ghost socket was reaped, the survivor alone satisfied a
  // now-smaller quorum and was released to simulate every subsequent turn on
  // its own, drifting further from the peer with every frame. Gating on
  // `expectedPlayers` instead means removing a dead socket changes nothing
  // about who the match is still waiting for.
  const room = createRoom('m9', 123, 2);
  const a = addPlayer(room, 'a', 0);
  addPlayer(room, 'b', 1);
  maybeBegin(room);

  room.pending.set(0, new Map([['a', []]]));
  releaseReadyTurns(room);
  assert.equal(room.released, -1, 'held while b has not reported');

  room.players.get('b').lastSeen = Date.now() - 60 * 1000;
  reapSilent(room);

  assert.equal(room.players.has('b'), false, 'the dead socket is gone');
  assert.equal(room.released, -1, 'but the match is still waiting for that roster seat — it did not advance');
  assert.equal(framesOfType(a, 'turn').length, 0, 'the survivor was never released to run alone');
});

test('a departed player leaves no stale hash behind to be wrongly compared later', () => {
  // room.hashes is never otherwise purged on departure (only aged out by turn
  // number), so a hash left behind by a dead connection could sit in its
  // turn's bucket and later be compared against a live peer's later report for
  // the same turn — a phantom desync between two clients that were never
  // describing the same running match.
  const room = createRoom('m10', 123, 2);
  addPlayer(room, 'a', 0);
  addPlayer(room, 'b', 1);
  room.hashes.set(10, new Map([['a', 'hash-a'], ['b', 'hash-b']]));

  room.players.get('b').lastSeen = Date.now() - 60 * 1000;
  reapSilent(room);

  assert.equal(room.hashes.get(10).has('b'), false, "b's stale hash is purged with them");
  assert.equal(room.hashes.get(10).has('a'), true, "a's own hash is untouched");
});

test('checkProtocolVersion accepts only a client declaring the server\'s exact version', () => {
  assert.equal(checkProtocolVersion(String(PROTOCOL_VERSION)).ok, true,
    'the query param arrives as a string; a matching numeric value must still pass');
  assert.equal(checkProtocolVersion(PROTOCOL_VERSION).ok, true);
});

test('checkProtocolVersion rejects a numeric mismatch and reports the client\'s version', () => {
  const result = checkProtocolVersion(String(PROTOCOL_VERSION + 1));
  assert.equal(result.ok, false);
  assert.equal(result.clientVersion, PROTOCOL_VERSION + 1);
});

test('checkProtocolVersion rejects a missing version exactly like a mismatched one', () => {
  // An old client — one built before this handshake existed — never sends the
  // query param at all. That must fail closed, not be treated as compatible
  // by default, or every pre-handshake build would sail through unversioned.
  const missing = checkProtocolVersion(undefined);
  assert.equal(missing.ok, false);
  assert.equal(missing.clientVersion, null, 'nothing parseable to report back');

  const malformed = checkProtocolVersion('not-a-number');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.clientVersion, null);
});

test('TICKS_PER_TURN is the value the diagnostic arithmetic relies on', () => {
  // Both uploaded saves were read through this constant: 11118 = 1853 * 6
  // (a client stalled on a turn boundary) versus 14084 = 2347 * 6 + 2 (a client
  // running ungated). Changing it silently would invalidate that reasoning and
  // the regression check built on it.
  assert.equal(TICKS_PER_TURN, 6);
});
