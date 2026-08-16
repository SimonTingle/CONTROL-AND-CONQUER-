/**
 * The client half of lockstep: when it may step, and how it rejoins.
 *
 * The rejoin path is the one that failed in the field. A client connecting to a
 * match already in progress was never told it had begun, so it never started
 * reporting input — it sat on "waiting for players" forever while its silence
 * stalled everybody else. These cases pin the corrected behaviour.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LockstepSession } from '../src/net/lockstep.js';

/** A session wired to record what it sends, with a hand-fed input stream. */
function makeSession({ ticksPerTurn = 6, inputDelayTurns = 2 } = {}) {
  const sent = [];
  const applied = [];
  const session = new LockstepSession({
    ticksPerTurn,
    inputDelayTurns,
    queue: { drain: () => [] },
    send: (turn, inputs) => sent.push({ turn, inputs }),
    onTurn: (inputs, turn) => applied.push(turn),
  });
  return { session, sent, applied };
}

test('a fresh session primes the input-delay window and nothing more', () => {
  const { session, sent } = makeSession();
  session.start();
  assert.deepEqual(sent.map((s) => s.turn), [0, 1], 'reports turns 0..DELAY-1');
});

test('start() is idempotent', () => {
  const { session, sent } = makeSession();
  session.start();
  session.start();
  assert.equal(sent.length, 2, 'a repeated begin frame must not re-report');
});

test('a session stalls rather than simulating ahead of its input', () => {
  const { session, applied } = makeSession();
  session.start();

  assert.equal(session.beginStep(), false, 'no input for turn 0 yet');
  assert.equal(session.stalled, true);
  assert.deepEqual(applied, [], 'nothing applied while stalled');

  session.receiveTurn(0, []);
  assert.equal(session.beginStep(), true);
  assert.equal(session.stalled, false);
  assert.deepEqual(applied, [0]);
});

test('a turn is exactly ticksPerTurn steps long', () => {
  const { session } = makeSession({ ticksPerTurn: 6 });
  session.start();
  session.receiveTurn(0, []);

  for (let i = 0; i < 6; i++) {
    assert.equal(session.beginStep(), true, `step ${i} of turn 0`);
    session.endStep();
  }
  assert.equal(session.turn, 1, 'six steps advances exactly one turn');
  assert.equal(session.tickInTurn, 0, 'and lands on a boundary');
});

test('rejoining resumes at the first unreleased turn, not turn 0', () => {
  const { session, sent } = makeSession();

  // The server released through turn 500 before this client connected.
  session.resumeAt(501);

  assert.equal(session.turn, 501, 'picks up where the match actually is');
  assert.deepEqual(sent, [], 'and does NOT report turns 0..DELAY-1');
  assert.equal(session.started, true, 'counts as started');
});

test('a rejoining session reports input immediately, so it cannot stall the match', () => {
  const { session, sent } = makeSession({ inputDelayTurns: 2 });
  session.resumeAt(501);

  session.receiveTurn(501, []);
  assert.equal(session.beginStep(), true);

  // Reporting has to begin at once even though this client's world is still
  // stale: the other players' turns are gated on it, and staying quiet until a
  // snapshot arrived would stall the host before it could ever send one.
  assert.deepEqual(sent.map((s) => s.turn), [503], 'reports turn + DELAY');
});

test('start() after resumeAt does not re-prime turn 0', () => {
  const { session, sent } = makeSession();
  session.resumeAt(501);
  session.start();
  assert.deepEqual(sent, [], 'a late begin frame must not rewind the cursor');
  assert.equal(session.turn, 501);
});

test('resumeAt discards buffered turns from before the resume point', () => {
  const { session, applied } = makeSession();
  session.receiveTurn(10, []);
  session.receiveTurn(600, []);

  session.resumeAt(501);

  assert.equal(session.received.has(10), false, 'stale turns dropped');
  assert.equal(session.received.has(600), true, 'future turns kept');

  session.receiveTurn(501, []);
  session.beginStep();
  assert.deepEqual(applied, [501], 'resumes cleanly at the right turn');
});
