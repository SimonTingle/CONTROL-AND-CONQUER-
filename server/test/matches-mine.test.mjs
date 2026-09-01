/**
 * `GET /matches/mine` — how a signed-in client finds its way back into a
 * match after a reload.
 *
 * Found during a multiplayer pressure test: `GET /matches` (the plain browse
 * list) only ever lists `status = 'open'`, correctly — a running match should
 * not look joinable to a stranger — but that left *no* route back for anyone
 * already in one. A match's id lived only in the browser's in-page JS state,
 * which any reload wipes. Confirmed directly: reload a connected host's tab
 * mid-match and the guest's session stalls (the roster-quorum design in
 * `ws/match.js` pauses rather than shrinks) with no way for either side to
 * find the match again.
 *
 * A real Postgres integration test, not a mock — the value here is the SQL
 * join and status filter, which a stubbed `query()` would not exercise. Uses
 * the app's real `build()` and a real (local, disposable) database, the same
 * way csrf-hook.test.mjs and health-commit.test.mjs do. Every row this file
 * creates is deleted in a `finally` so a failed run cannot poison later ones.
 *
 * Run: node --test server/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from '../src/index.js';
import { query, pool } from '../src/db/pool.js';
import { createSession } from '../src/auth/sessions.js';

async function makeUser(label) {
  const id = randomUUID();
  await query(
    `insert into users (id, email, password_hash, display_name)
     values ($1, $2, 'x', $3)`,
    [id, `mine-test-${label}-${id}@example.com`, `Test ${label}`]
  );
  return id;
}

// Reuses the real session creation (hashed-token storage, see 005_hash_tokens
// — sessions.token was dropped, so an ad-hoc insert here would need to
// duplicate the hashing scheme and silently drift from it) rather than
// hand-rolling a row shape this file would then own keeping in sync.
async function makeSession(userId) {
  const { token } = await createSession(userId);
  return token;
}

async function makeMatch({ hostId, status }) {
  const id = randomUUID();
  await query(
    `insert into matches (id, host_user_id, name, seed, status, max_players)
     values ($1, $2, 'Test Match', 12345, $3, 2)`,
    [id, hostId, status]
  );
  await query(`insert into match_players (match_id, user_id, team_id) values ($1, $2, 0)`, [
    id,
    hostId,
  ]);
  return id;
}

// Sessions and match_players both cascade off users/matches (`on delete
// cascade`), so deleting matches then users is enough — nothing here needs to
// touch the hashed session rows directly.
async function cleanup(ids) {
  if (ids.matches.length) {
    await query('delete from matches where id = any($1)', [ids.matches]);
  }
  if (ids.users.length) {
    await query('delete from users where id = any($1)', [ids.users]);
  }
}

test('returns the caller\'s running match', async () => {
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const hostId = await makeUser('host'); created.users.push(hostId);
    const token = await makeSession(hostId);
    const matchId = await makeMatch({ hostId, status: 'running' }); created.matches.push(matchId);

    const res = await app.inject({
      method: 'GET',
      url: '/matches/mine',
      headers: { cookie: `ptg_session=${token}` },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.match.id, matchId);
    assert.equal(body.match.status, 'running');
    assert.equal(body.match.hostUserId, hostId);
    assert.equal(body.players.length, 1);
    assert.equal(body.players[0].userId, hostId);
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test('returns null when the caller has no open-or-running match', async () => {
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const userId = await makeUser('lonely'); created.users.push(userId);
    const token = await makeSession(userId);

    const res = await app.inject({
      method: 'GET',
      url: '/matches/mine',
      headers: { cookie: `ptg_session=${token}` },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().match, null);
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test('a finished or abandoned match of the caller\'s is not offered back', async () => {
  // The whole point is rejoining something still live — a match that legally
  // ended must not keep resurfacing as "yours to go back to".
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const hostId = await makeUser('done-host'); created.users.push(hostId);
    const token = await makeSession(hostId);
    const abandonedId = await makeMatch({ hostId, status: 'abandoned' }); created.matches.push(abandonedId);
    const finishedId = await makeMatch({ hostId, status: 'finished' }); created.matches.push(finishedId);

    const res = await app.inject({
      method: 'GET',
      url: '/matches/mine',
      headers: { cookie: `ptg_session=${token}` },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().match, null, 'neither abandoned nor finished should be offered as a rejoin');
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test('a match this user is not a member of is not returned', async () => {
  // The join in the SQL is what enforces this — a bug there would leak
  // someone else's match id to a caller who was never part of it.
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const hostId = await makeUser('other-host'); created.users.push(hostId);
    const bystanderId = await makeUser('bystander'); created.users.push(bystanderId);
    const token = await makeSession(bystanderId);
    const matchId = await makeMatch({ hostId, status: 'running' }); created.matches.push(matchId);

    const res = await app.inject({
      method: 'GET',
      url: '/matches/mine',
      headers: { cookie: `ptg_session=${token}` },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().match, null);
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test('requires authentication', async () => {
  const app = await build();
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/matches/mine' });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test.after(async () => {
  await pool.end();
});
