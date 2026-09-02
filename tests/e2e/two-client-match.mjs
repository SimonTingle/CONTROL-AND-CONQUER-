// Two real clients, the real relay, a real database.
//
// Reproduces the match from the field report end to end: one player connects,
// waits, and the second arrives late. Asserts that the first is NEVER released
// to simulate alone, and that both run in genuine lockstep once the roster
// completes.
//
// This is the only check in the repository that can observe a split-brain at
// all. The unit tests cover the rules; `window.__determinismCheck` replays a
// single client against itself and is structurally blind to two clients
// disagreeing. Nothing caught the original bug because nothing was looking at
// two clients at once.
//
// Not part of `npm test`, which is deliberately dependency-free. This one needs
// a database and a running API server:
//
//   initdb -D /var/tmp/ccpg -U cc -A trust
//   pg_ctl -D /var/tmp/ccpg -o '-p 55432 -k /var/tmp' start
//   createdb -h /var/tmp -p 55432 -U cc ccdev
//   cd server && DATABASE_URL=postgres://cc@127.0.0.1:55432/ccdev \
//     CORS_ORIGIN=http://localhost:5178 NODE_ENV=development PORT=3999 \
//     MATCH_START_REPORT_MS=1000 node src/index.js
//   node tests/e2e/two-client-match.mjs
//
// MATCH_START_REPORT_MS is lowered only so the "what am I waiting for" frame
// arrives inside the test's patience; the barrier itself has no timeout to tune.
// `ws` is now a declared dependency of server/package.json (it used to be
// reachable only transitively through @fastify/websocket, which meant the
// exact version this test ran against was whatever that package happened to
// pull in, undeclared anywhere). This path still reaches into the server
// package's own node_modules rather than a bare `import 'ws'`, because this
// file has no node_modules of its own for Node's resolver to find a
// same-named package in — but the dependency it reaches for is now pinned
// and visible in server/package.json instead of merely hoped for.
import wsPkg from '../../server/node_modules/ws/index.js';
const { WebSocket } = wsPkg;
import { LockstepSession } from '../../src/net/lockstep.js';

// The real relay this harness talks to, so "what version does a real client
// declare" and "what version does the real server require" can never drift
// apart from what this test asserts — importing the constant beats copying
// its value in by hand. From matchRoom.js rather than ws/match.js: the latter's
// route handler imports db/pool.js, which is why this file used to need a
// DATABASE_URL placeholder just to read one integer.
const { PROTOCOL_VERSION } = await import('../../server/src/ws/matchRoom.js');

const API = process.env.E2E_API ?? 'http://127.0.0.1:3999';
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A logged-in API caller that carries its own cookie jar and CSRF token. */
async function makeUser(tag) {
  // A real jar, merged per name: /auth/me sets the CSRF cookie alongside the
  // session one, and simply replacing the header would drop the session.
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (path, opts = {}) => {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(jar.size ? { cookie: cookieHeader() } : {}),
        ...(opts.headers ?? {}),
      },
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [name, ...rest] = raw.split(';')[0].split('=');
      jar.set(name, rest.join('='));
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
    return body;
  };

  const email = `${tag}-${Date.now()}@example.test`;
  await call('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-horse-battery', displayName: tag }),
  });
  const me = await call('/auth/me');
  const csrf = me.csrfToken;
  const write = (path, body) =>
    call(path, { method: 'POST', headers: { 'x-csrf-token': csrf }, body: JSON.stringify(body ?? {}) });

  return { tag, call, write, cookie: cookieHeader, userId: me.user.id };
}

/**
 * One client's socket + lockstep session, recording what it saw.
 *
 * `onResyncNeeded`/`onSnapshot` mirror the two frames a real host and a real
 * rejoiner exchange (`main.js`'s `onResyncNeeded`/`onSnapshot` handlers) —
 * this harness has no game world to actually serialize, so the host side
 * responds with a marker payload rather than a real snapshot. What this
 * proves is the wire path itself: does `resyncNeeded` reach the host, and
 * does the relayed `snapshot` reach the rejoiner. That path had a real,
 * shipped bug — `matchClient.js`'s message switch had no `case
 * 'resyncNeeded'` at all, so the handler `main.js` already had written for it
 * was simply never called.
 */
function connectClient(user, matchId) {
  const seen = {
    begin: null, waiting: [], turns: [], welcome: null, resyncNeeded: [], snapshot: null,
    activeVehicle: [],
  };
  const ws = new WebSocket(`ws://127.0.0.1:3999/ws/match/${matchId}?protocolVersion=${PROTOCOL_VERSION}`, {
    headers: { cookie: user.cookie() },
  });
  let session = null;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'welcome') {
      seen.welcome = msg;
      session = new LockstepSession({
        ticksPerTurn: msg.ticksPerTurn,
        inputDelayTurns: msg.inputDelayTurns,
        queue: { drain: () => [] },
        send: (turn, inputs) => ws.send(JSON.stringify({ t: 'input', turn, inputs })),
        onTurn: () => {},
      });
    } else if (msg.t === 'begin') {
      seen.begin = msg;
      if (msg.resuming) session.resumeAt((seen.welcome.releasedTurn ?? -1) + 1);
      else session.start();
    } else if (msg.t === 'waiting') {
      seen.waiting.push(msg);
    } else if (msg.t === 'turn') {
      seen.turns.push(msg.turn);
      session.receiveTurn(msg.turn, msg.inputs);
    } else if (msg.t === 'resyncNeeded') {
      seen.resyncNeeded.push(msg);
    } else if (msg.t === 'snapshot') {
      seen.snapshot = msg;
    } else if (msg.t === 'activeVehicle') {
      seen.activeVehicle.push(msg);
    }
  });

  return {
    user,
    seen,
    ws,
    ready: new Promise((res) => ws.on('open', res)),
    /** Stand in for the frame loop: step as far as lockstep allows. */
    pump(steps = 600) {
      if (!session) return 0;
      let done = 0;
      for (let i = 0; i < steps; i++) {
        if (!session.beginStep()) break;
        session.endStep();
        done++;
      }
      return done;
    },
    session: () => session,
    send(msg) { ws.send(JSON.stringify(msg)); },
  };
}

// ------------------------------------------------- the build-version handshake --
//
// Checked before any user, match, or roster exists — the version check runs
// first in handleMatchSocket, ahead of authentication, precisely so a build
// mismatch never needs real credentials or a real match to be caught. No
// database row backs this matchId at all; if the check ran after the DB
// lookup this would fail for the wrong reason (not_a_member) instead of the
// one under test.
{
  const wrongVersion = new WebSocket(
    `ws://127.0.0.1:3999/ws/match/protocol-check?protocolVersion=${PROTOCOL_VERSION + 1}`
  );
  const msg = await new Promise((resolve) => wrongVersion.on('message', (raw) => resolve(JSON.parse(raw.toString()))));
  ok('a peer declaring a different protocol version is rejected by name, not silently',
     msg.t === 'error' && msg.error === 'protocol_version_mismatch',
     JSON.stringify(msg));
  ok('the rejection names both versions, so the mismatch is diagnosable rather than opaque',
     msg.serverVersion === PROTOCOL_VERSION && msg.clientVersion === PROTOCOL_VERSION + 1,
     JSON.stringify(msg));
  await new Promise((resolve) => wrongVersion.on('close', resolve));
}
{
  // An old build — from before this handshake existed — never sends the query
  // param at all. That must fail exactly like a numeric mismatch, not be
  // waved through as compatible by default.
  const noVersion = new WebSocket('ws://127.0.0.1:3999/ws/match/protocol-check');
  const msg = await new Promise((resolve) => noVersion.on('message', (raw) => resolve(JSON.parse(raw.toString()))));
  ok('a peer that never declares a protocol version is rejected the same way, not treated as compatible',
     msg.t === 'error' && msg.error === 'protocol_version_mismatch' && msg.clientVersion === null,
     JSON.stringify(msg));
  await new Promise((resolve) => noVersion.on('close', resolve));
}

// ---------------------------------------------------------------- the match --
const host = await makeUser('host');
const joiner = await makeUser('joiner');

const created = await host.write('/matches', { name: 'e2e', maxPlayers: 2, aiCount: 0 });
const matchId = created.match.id;
await joiner.write(`/matches/${matchId}/join`);
await host.write(`/matches/${matchId}/start`);
console.log(`  match ${matchId}, seed ${created.match.seed}\n`);

// ---- 1. the host connects ALONE and must never be released to simulate ----
const a = connectClient(host, matchId);
await a.ready;
await sleep(7000); // past the threshold AND the 5s reaper sweep that reports it

ok('a lone client is not told the match began',
   a.seen.begin === null, `begin=${JSON.stringify(a.seen.begin)}`);
ok('a lone client is told what it is waiting for',
   a.seen.waiting.length > 0 && a.seen.waiting[0].expected === 2 && a.seen.waiting[0].present === 1,
   JSON.stringify(a.seen.waiting[0]));

const steppedAlone = a.pump();
ok('a lone client simulates nothing at all',
   steppedAlone === 0 && a.seen.turns.length === 0,
   `stepped=${steppedAlone} turns=${a.seen.turns.length}`);

// ---- 2. the second player arrives; both must begin together ----
const b = connectClient(joiner, matchId);
await b.ready;
await sleep(500);

ok('both clients are told the match began, together',
   a.seen.begin !== null && b.seen.begin !== null,
   `host=${!!a.seen.begin} joiner=${!!b.seen.begin}`);
ok('neither was told it started short-rostered',
   !a.seen.begin?.resuming && !b.seen.begin?.resuming);

// ---- 3. drive both, as two frame loops would ----
for (let round = 0; round < 40; round++) {
  a.pump(6);
  b.pump(6);
  await sleep(20);
}
await sleep(300);

const turnA = a.session().turn;
const turnB = b.session().turn;
ok('both clients actually advanced', turnA > 3 && turnB > 3, `A=${turnA} B=${turnB}`);
ok('both clients are on the same turn — real lockstep, not two private games',
   turnA === turnB, `A=${turnA} B=${turnB}`);
ok('both received an identical turn stream',
   JSON.stringify(a.seen.turns) === JSON.stringify(b.seen.turns),
   `A got ${a.seen.turns.length}, B got ${b.seen.turns.length}`);

// ---- 4. the diagnostic signature from the uploaded saves ----
// A stalls only on a turn boundary; a free-running client stops anywhere. Both
// clients being boundary-aligned and equal is the inverse of what the two saves
// showed (11118 = 1853*6 exactly, versus 14084 = 2347*6 + 2).
const tickA = turnA * a.session().ticksPerTurn + a.session().tickInTurn;
const tickB = turnB * b.session().ticksPerTurn + b.session().tickInTurn;
ok('neither client is ahead of the other in sim ticks',
   tickA === tickB, `tickA=${tickA} tickB=${tickB}`);

// ---- 4B. headlight sync: which vehicle a peer is driving is relayed to
//          everyone else, but not echoed back to the sender ----
//
// Reported alongside the time-of-day sync bug: only the locally-piloted
// vehicle ever cast a real light, because no client had any way to know
// *which* vehicle a remote peer was driving. `activeVehicle` (main.js's
// sendActiveVehicle, server/src/ws/match.js's relay) is the fix — presence
// info, deliberately outside the turn/lockstep system entirely, so this
// checks it works over a real server rather than trusting the relay code
// was correct by inspection alone.
a.send({ t: 'activeVehicle', vehicleId: 42 });
await sleep(200);
ok('a peer\'s active-vehicle change reaches the other client',
   b.seen.activeVehicle.at(-1)?.vehicleId === 42,
   JSON.stringify(b.seen.activeVehicle));
ok('the teamId is attached server-side from the roster, not trusted from the sender',
   b.seen.activeVehicle.at(-1)?.teamId === 0, // host is always team 0
   JSON.stringify(b.seen.activeVehicle));
ok('the sender does not get its own activeVehicle message echoed back',
   a.seen.activeVehicle.length === 0,
   JSON.stringify(a.seen.activeVehicle));

// ---- 5. b drops. a must PAUSE, not run ahead alone ----
//
// The primary bug this round: `releaseReadyTurns` used to gate on
// `room.players.size` — the connected count — so the moment b's socket
// closed, a alone satisfied the (now smaller) quorum and was released to
// simulate every subsequent turn on its own. That produced exactly the two
// diagnostic saves this round started from: one client at turn 14, the other
// still at turn 2, neither reachable by the other.
b.ws.close();
await sleep(300); // let the server's close handler run and any turns already
                   // in flight from before the drop finish landing on a — the
                   // invariant under test is that release STOPS once b is
                   // gone, not that it stops at the exact instant .close() was
                   // called (a couple of turns both sides had already fully
                   // reported can legitimately land just after).
a.pump(600);
const turnBeforeDrop = a.session().turn;
const releasedBeforeDrop = a.seen.turns.length;

for (let round = 0; round < 20; round++) {
  a.pump(6);
  await sleep(20);
}

ok('a alone after b drops does NOT advance — the match pauses, it does not run ahead',
   a.session().turn === turnBeforeDrop && a.seen.turns.length === releasedBeforeDrop,
   `turn settled at=${turnBeforeDrop}, stayed at=${a.session().turn}; ` +
     `turns received settled at=${releasedBeforeDrop}, stayed at=${a.seen.turns.length}`);

// ---- 6. b reconnects. It must be told the match began (resuming), and must
//         actually be able to rejoin the turn stream — not deadlock on it ----
const b2 = connectClient(joiner, matchId);
await b2.ready;
await sleep(300);

ok('the rejoining socket is told the match already began, and that it is resuming',
   b2.seen.begin !== null && b2.seen.begin.resuming === true,
   `begin=${JSON.stringify(b2.seen.begin)}`);

ok('the host is asked to resync the rejoining player',
   a.seen.resyncNeeded.length > 0 && a.seen.resyncNeeded.at(-1).users.includes(joiner.userId),
   JSON.stringify(a.seen.resyncNeeded));

// Stand in for main.js's host-side snapshot response — this harness has no
// game world to serialize, so a marker payload exercises the same wire path
// a real snapshot would (server/src/ws/match.js's 'snapshot' relay), which is
// the part that had no route to the client at all before this fix.
if (a.seen.resyncNeeded.length) {
  const req = a.seen.resyncNeeded.at(-1);
  a.send({ t: 'snapshot', toUserId: req.users[0], turn: a.session().turn, payload: { marker: 'resync' } });
}
await sleep(200);

ok('the rejoiner actually receives the relayed snapshot',
   b2.seen.snapshot?.payload?.marker === 'resync', JSON.stringify(b2.seen.snapshot));

// ---- 7. both clients advance together again — the actual proof the rejoin
//         worked, not just that the frames arrived ----
for (let round = 0; round < 40; round++) {
  a.pump(6);
  b2.pump(6);
  await sleep(20);
}
await sleep(300);

const finalA = a.session().turn;
const finalB = b2.session().turn;
ok('both clients advanced past where the drop paused them',
   finalA > turnBeforeDrop && finalB > turnBeforeDrop,
   `A: ${turnBeforeDrop} -> ${finalA}; B (rejoined): -> ${finalB}`);
ok('after rejoining, both clients are on the same turn again',
   finalA === finalB, `A=${finalA} B2=${finalB}`);

a.ws.close();
b2.ws.close();
await sleep(200);

// ---- 8. the match ends when its last player leaves, not just at the next
//         server restart — see server/src/ws/match.js's close handler and
//         docs/plans/match-ends-when-empty.md. Both sockets just closed
//         above; this checks the one side effect only a real server process
//         can produce: matches.status actually leaving 'running' in the
//         database, read back through the ordinary GET /matches/:id route
//         (no direct DB access from this harness, on purpose — the same
//         path a client would use). server/test/leave-empties-match.test.mjs
//         covers the deliberate-leave route directly; this is the only place
//         that can observe the socket-close path, since it needs a real
//         relay actually noticing both sockets are gone.
const afterClose = await host.call(`/matches/${matchId}`);
ok('the match is no longer running once both sockets have closed',
   afterClose.match.status !== 'running',
   `status=${afterClose.match.status}`);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
