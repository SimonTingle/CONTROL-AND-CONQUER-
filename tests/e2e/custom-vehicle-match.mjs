/**
 * Author-built vehicles reaching an online match, end to end.
 *
 * The claim this exists to check is narrow and is the whole basis of the
 * feature: **every peer in a match receives the identical vehicle set.** Not
 * "the host's vehicle arrives" — that a def travels at all is easy. The thing
 * that makes it safe is that both clients resolve a given `defId` to the same
 * bytes, because only `defId` strings cross the wire during play and a peer
 * that cannot resolve one drops the unit in silence.
 *
 * Also pins the two filters, which are the difference between a shared vehicle
 * set and a shared vehicle set someone can abuse: drafts never travel, and a
 * def outside the editor's own stat bounds is refused by the server rather
 * than relayed.
 *
 * Needs real infrastructure — see tests/e2e/two-client-match.mjs's header for
 * the Postgres + API setup, then:
 *   node tests/e2e/custom-vehicle-match.mjs
 */
import WebSocket from '../../server/node_modules/ws/index.js';
import { blankDef, syncId } from '../../src/builder/vehicleDraft.js';

const API = process.env.API_URL ?? 'http://127.0.0.1:3999';
// Imported, not copied. This was a hand-written `= 2` while its sibling
// two-client-match.mjs deliberately imports the constant — so the copy here
// would have gone silently stale on the next bump, which is exactly the drift
// tests/match-client-protocol.test.mjs exists to prevent.
const { PROTOCOL_VERSION } = await import('../../server/src/ws/matchRoom.js');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
}

/** A signed-in browser-ish client: keeps its cookie and CSRF token. */
async function signUp(label) {
  const email = `cv-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  // Every cookie, not just the session one: CSRF is double-submit, so the
  // server keeps its own secret in a second httpOnly cookie and the token in
  // the body is only half of the pair. Dropping that cookie makes every write
  // 403 in a way that looks like an auth bug and is not.
  const jar = new Map();
  const session = { csrf: '', get cookie() {
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  } };

  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = session.cookie;
    if (session.csrf && method !== 'GET') headers['x-csrf-token'] = session.csrf;
    const res = await fetch(`${API}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const json = await res.json().catch(() => null);
    if (json?.csrfToken) session.csrf = json.csrfToken;
    return { status: res.status, json };
  };

  await call('/auth/register', {
    method: 'POST',
    body: { email, password: 'hunter2hunter2', displayName: label },
  });
  await call('/auth/me'); // mints the CSRF token
  return { label, session, call };
}

/** Connect a websocket and resolve with its `welcome` frame. */
function welcomeFor(client, matchId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws/match/${matchId}?protocolVersion=${PROTOCOL_VERSION}`, {
      headers: { Cookie: client.session.cookie },
    });
    const timer = setTimeout(() => { ws.close(); reject(new Error('timed out waiting for welcome')); }, 10000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.error)); return; }
      if (msg.t !== 'welcome') return;
      clearTimeout(timer);
      resolve({ welcome: msg, close: () => ws.close() });
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---- the host authors three vehicles: one good, one cheaty, one unfinished ----
const host = await signUp('host');
const joiner = await signUp('joiner');

const good = blankDef('Shared Tank');
const cheaty = syncId(Object.assign(blankDef('Cheaty Tank'), { speed: 999999 }));
const draft = blankDef('Unfinished');

for (const [name, def, isDraft] of [
  ['Shared Tank', good, false],
  ['Cheaty Tank', cheaty, false],
  ['Unfinished', draft, true],
]) {
  const { status } = await host.call('/saves', {
    method: 'POST',
    body: { name, mode: 'vehicle-def', schemaVersion: 1, payload: { draft: isDraft, def } },
  });
  if (status !== 201) throw new Error(`saving ${name} failed with ${status}`);
}

// ---- the host opens a lobby; their loadout is snapshotted into it ----
const created = await host.call('/matches', {
  method: 'POST',
  body: { name: 'Custom vehicle match', maxPlayers: 2 },
});
if (created.status !== 201) throw new Error(`match creation failed with ${created.status}`);
const matchId = created.json.match.id;
const summary = created.json.customVehicles;

ok('only the finished, in-bounds vehicle is pinned into the match',
   summary.included === 1, JSON.stringify(summary));
ok('the out-of-bounds vehicle is refused, and says why',
   summary.rejected.length === 1 &&
   summary.rejected[0].name === 'Cheaty Tank' &&
   summary.rejected[0].problems[0].includes('speed'),
   JSON.stringify(summary.rejected));
ok('a draft is neither included nor reported as an error — it is simply unfinished',
   !summary.rejected.some((r) => r.name === 'Unfinished'));

await joiner.call(`/matches/${matchId}/join`, { method: 'POST' });

// ---- both peers connect and must be handed the same vehicle set ----
const a = await welcomeFor(host, matchId);
const b = await welcomeFor(joiner, matchId);

ok('both peers negotiated protocol v2', a.welcome.protocolVersion === 2 && b.welcome.protocolVersion === 2);
ok('the host receives the match vehicle set', a.welcome.customDefs?.length === 1,
   JSON.stringify(a.welcome.customDefs?.map((d) => d.name)));
ok('the joiner — who authored nothing — receives it too', b.welcome.customDefs?.length === 1,
   JSON.stringify(b.welcome.customDefs?.map((d) => d.name)));

// The load-bearing assertion. Byte equality, not "both have one vehicle":
// resolving the same defId to different bytes is exactly the divergence that
// kept custom vehicles offline in the first place.
ok('both peers received byte-identical vehicle sets',
   JSON.stringify(a.welcome.customDefs) === JSON.stringify(b.welcome.customDefs));
ok('the shared vehicle kept its content-addressed id',
   a.welcome.customDefs[0].id === good.id,
   `${a.welcome.customDefs[0].id} === ${good.id}`);

a.close();
b.close();

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
