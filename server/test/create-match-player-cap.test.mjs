/**
 * `POST /matches`'s `maxPlayers` bound — raised from 4 to 20.
 *
 * Requested directly: bigger online matches, up to 20 players. The
 * simulation side (`findTeamSpawnPoints`, `createTeams`, `beginMatch`) was
 * already generic over team count — see tests/team-spawn-points.test.mjs's
 * 20-player equal-spacing test — so the only real limits were this route's
 * zod schema and the `matches` table's check constraint
 * (007_max_players_20.sql). This exercises the route end to end against a
 * real database, which the zod schema alone would not: the migration
 * actually running is what this test would catch a mismatch in.
 *
 * A real Postgres integration test, not a mock — same pattern as
 * matches-mine.test.mjs. Uses bearer auth (`Authorization: Bearer <token>`)
 * rather than the cookie, since that path skips CSRF (see
 * auth/plugin.js's `csrfUnlessBearer`) without needing to drive the full
 * cookie+token CSRF handshake csrf-hook.test.mjs exists to test directly.
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
    [id, `player-cap-test-${label}-${id}@example.com`, `Test ${label}`]
  );
  return id;
}

async function makeSession(userId) {
  const { token } = await createSession(userId);
  return token;
}

async function cleanup(ids) {
  if (ids.matches.length) {
    await query('delete from matches where id = any($1)', [ids.matches]);
  }
  if (ids.users.length) {
    await query('delete from users where id = any($1)', [ids.users]);
  }
}

test('a 20-player match can be created', async () => {
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const hostId = await makeUser('host20'); created.users.push(hostId);
    const token = await makeSession(hostId);

    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Big Skirmish', maxPlayers: 20, aiCount: 0, difficultyId: 'normal' },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.match.maxPlayers, 20);
    created.matches.push(body.match.id);
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test('a 21-player match is rejected', async () => {
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const hostId = await makeUser('host21'); created.users.push(hostId);
    const token = await makeSession(hostId);

    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Too Big', maxPlayers: 21, aiCount: 0, difficultyId: 'normal' },
    });

    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test.after(async () => {
  await pool.end();
});
