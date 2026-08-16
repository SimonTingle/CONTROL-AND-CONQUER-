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

// The rules under test touch neither the database nor a socket, but they live
// in a module whose import chain reaches server/src/config.js, which refuses to
// load without a connection string. `pg` connects lazily, so a placeholder is
// enough to import the module and never opens anything. Set before the dynamic
// import below, since a static import would be hoisted above it.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { createRoom, maybeBegin, releaseReadyTurns, reapSilent, TICKS_PER_TURN } =
  await import('../server/src/ws/match.js');

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
    lastInputAt: Date.now(),
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

test('a player who pings but never reports input is dropped, not tolerated', () => {
  const room = createRoom('m7', 123, 2);
  const a = addPlayer(room, 'a', 0);
  const mute = addPlayer(room, 'b', 1);
  maybeBegin(room);

  // The heartbeat keeps this one looking perfectly healthy while it reports
  // nothing. That is exactly how one real match froze: the quorum counted a
  // client that was never going to speak, so the other player stalled forever.
  room.players.get('b').lastSeen = Date.now();
  room.players.get('b').lastInputAt = Date.now() - 60 * 1000;

  reapSilent(room);

  assert.equal(room.players.has('b'), false, 'a mute peer is reaped');
  const [left] = framesOfType(a, 'playerLeft');
  assert.ok(left, 'survivors are told');
  assert.equal(left.reason, 'not_reporting', 'and told which kind of silence it was');
  assert.equal(mute.sent.some((m) => m.t === 'turn'), false);
});

test('input silence is not held against anyone before the match begins', () => {
  const room = createRoom('m8', 123, 2);
  addPlayer(room, 'a', 0);
  room.players.get('a').lastInputAt = Date.now() - 60 * 1000;

  reapSilent(room);

  assert.equal(room.players.has('a'), true, 'nobody owes input before begin');
});

test('reaping a stalled peer unblocks the turns it was holding', () => {
  const room = createRoom('m9', 123, 2);
  const a = addPlayer(room, 'a', 0);
  addPlayer(room, 'b', 1);
  maybeBegin(room);

  room.pending.set(0, new Map([['a', []]]));
  releaseReadyTurns(room);
  assert.equal(room.released, -1, 'held while b is still counted');

  room.players.get('b').lastInputAt = Date.now() - 60 * 1000;
  reapSilent(room);

  assert.equal(room.released, 0, 'the survivor carries on once b is gone');
  assert.equal(framesOfType(a, 'turn').length, 1);
});

test('TICKS_PER_TURN is the value the diagnostic arithmetic relies on', () => {
  // Both uploaded saves were read through this constant: 11118 = 1853 * 6
  // (a client stalled on a turn boundary) versus 14084 = 2347 * 6 + 2 (a client
  // running ungated). Changing it silently would invalidate that reasoning and
  // the regression check built on it.
  assert.equal(TICKS_PER_TURN, 6);
});
