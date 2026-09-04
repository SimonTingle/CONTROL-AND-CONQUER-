/**
 * A lobby with more seats than players: what the server says the roster is,
 * versus what the lobby row says its capacity is.
 *
 * The client used to size its team roster — and therefore the number of base
 * stations it spawns — from `match.maxPlayers`, the lobby's *capacity*. Every
 * other multiplayer test in this repo creates a match with `maxPlayers: 2` and
 * joins it with exactly two players, so capacity and roster are numerically
 * identical in all of them and the mistake is invisible. This is the case none
 * of them covered: six seats, two players.
 *
 * With the old formula that match built six teams and spawned six base
 * stations. Four belonged to a seat nobody sat in and, because unfilled *human*
 * seats are still flagged human, got no AI commander either — inert bases a
 * player can find, attack and destroy with no opponent behind them. Every
 * client built the identical phantoms, so nothing reported a desync.
 *
 * The fix reads `welcome.expectedPlayers`, which the server has always sent.
 * This test's job is to prove, against a real server and database, that the
 * number is there and that it is the roster rather than the capacity.
 *
 * Prerequisites are the same as two-client-match.mjs — see
 * docs/plans/e2e-harness.md. Start Postgres and the API, then:
 *
 *     node tests/e2e/underfilled-lobby.mjs
 */
// CommonJS, so default-import then destructure — same as two-client-match.mjs.
import wsPkg from '../../server/node_modules/ws/index.js';
const { WebSocket } = wsPkg;
import { PROTOCOL_VERSION } from '../../server/src/ws/matchRoom.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3999';

let failed = 0;
function ok(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!pass) failed++;
}

async function makeUser(tag) {
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

/** Connect and resolve the `welcome` frame. */
function welcomeFor(user, matchId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${API.replace('http', 'ws')}/ws/match/${matchId}?protocolVersion=${PROTOCOL_VERSION}`,
      { headers: { cookie: user.cookie() } }
    );
    const timer = setTimeout(() => reject(new Error(`${user.tag}: no welcome`)), 8000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'welcome') {
        clearTimeout(timer);
        resolve({ welcome: msg, ws });
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const SEATS = 6;

const host = await makeUser('underfill-host');
const joiner = await makeUser('underfill-joiner');

const { match } = await host.write('/matches', { name: 'underfilled', maxPlayers: SEATS, aiCount: 0 });
await joiner.write(`/matches/${match.id}/join`);
await host.write(`/matches/${match.id}/start`);

const fetched = await host.call(`/matches/${match.id}`);
ok(
  'the lobby row really does have more seats than players',
  fetched.match.maxPlayers === SEATS && fetched.players.length === 2,
  `maxPlayers=${fetched.match.maxPlayers} players=${fetched.players.length}`
);

const a = await welcomeFor(host, match.id);
const b = await welcomeFor(joiner, match.id);

ok(
  'the server reports the roster, not the capacity',
  a.welcome.expectedPlayers === 2,
  `expectedPlayers=${a.welcome.expectedPlayers}, maxPlayers=${fetched.match.maxPlayers}`
);

ok(
  'both clients are told the same number, so they build the same world',
  a.welcome.expectedPlayers === b.welcome.expectedPlayers,
  `host=${a.welcome.expectedPlayers} joiner=${b.welcome.expectedPlayers}`
);

ok(
  'the roster and the capacity genuinely disagree — this is the case no other test covers',
  a.welcome.expectedPlayers !== fetched.match.maxPlayers,
  `${a.welcome.expectedPlayers} !== ${fetched.match.maxPlayers}`
);

// Team ids are packed from 0 with no holes, so every seat that exists is
// occupied. This is what makes sizing from the roster safe: no player can hold
// a team id the fixed roster would not have created.
const teamIds = [a.welcome.teamId, b.welcome.teamId].sort();
ok(
  'every assigned team id is within the roster-sized team count',
  teamIds.every((id) => id < a.welcome.expectedPlayers),
  `teamIds=${JSON.stringify(teamIds)} expectedPlayers=${a.welcome.expectedPlayers}`
);

ok('team ids are packed from zero, leaving no unoccupied seat below them', teamIds[0] === 0 && teamIds[1] === 1, JSON.stringify(teamIds));

// What the client now computes from those numbers. Mirrors src/main.js's
// online path exactly; tests/online-match-shape.test.mjs holds the arithmetic
// itself, this confirms the inputs it is fed are real.
const humanSeats = a.welcome.expectedPlayers ?? fetched.match.maxPlayers;
const totalTeams = humanSeats + fetched.match.aiCount;
ok(
  'the client would build one team per actual player, and no phantoms',
  totalTeams === 2,
  `totalTeams=${totalTeams} (was ${fetched.match.maxPlayers + fetched.match.aiCount} before the fix)`
);

a.ws.close();
b.ws.close();

console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}`);
process.exit(failed ? 1 : 0);
