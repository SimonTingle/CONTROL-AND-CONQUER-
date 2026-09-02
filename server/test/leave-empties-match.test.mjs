/**
 * `POST /matches/:id/leave` — closing the "match stays running forever after
 * everyone leaves" gap.
 *
 * Reported directly: after all players left a match, it stayed `running` in
 * the database, and the next player to open the lobby (or start a new match)
 * got auto-rejoined into that stale match via `GET /matches/mine` — same
 * mechanism, and same practical symptom, as the orphaned-match bug fixed by
 * `abandonOrphanedMatches()` (see matches-mine.test.mjs and
 * abandon-orphaned-matches.test.mjs). That fix only runs at server boot,
 * because it can only be *sure* a room is dead once the process that ran it
 * is a genuinely fresh one. It does nothing for a match that empties out
 * while the server keeps running — by far the more common way a match ends.
 *
 * The `leave` route used to only ever mark a match `abandoned` when the
 * *leaving user was the host* and the match was still `status = 'open'` — a
 * non-host leaving a running match, or the host leaving one, never ended it
 * even as the last player out. Fixed: after deleting the leaving player's
 * row, if the roster is now empty, the match is marked `finished`
 * regardless of status or who left.
 *
 * A real Postgres integration test, not a mock — same pattern as
 * matches-mine.test.mjs and create-match-player-cap.test.mjs. Bearer auth
 * to skip CSRF, same as create-match-player-cap.test.mjs.
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
    [id, `leave-empty-test-${label}-${id}@example.com`, `Test ${label}`]
  );
  return id;
}

async function makeSession(userId) {
  const { token } = await createSession(userId);
  return token;
}

/** A running match with two players already seated: host on team 0, guest on team 1. */
async function makeRunningMatchWithTwoPlayers(hostId, guestId) {
  const id = randomUUID();
  await query(
    `insert into matches (id, host_user_id, name, seed, status, max_players)
     values ($1, $2, 'Test Match', 12345, 'running', 2)`,
    [id, hostId]
  );
  await query(`insert into match_players (match_id, user_id, team_id) values ($1, $2, 0)`, [id, hostId]);
  await query(`insert into match_players (match_id, user_id, team_id) values ($1, $2, 1)`, [id, guestId]);
  return id;
}

async function statusOf(matchId) {
  const { rows } = await query('select status from matches where id = $1', [matchId]);
  return rows[0]?.status;
}

async function cleanup(ids) {
  if (ids.matches.length) await query('delete from matches where id = any($1)', [ids.matches]);
  if (ids.users.length) await query('delete from users where id = any($1)', [ids.users]);
}

test('a running match stays running while one of two players leaves', async () => {
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const hostId = await makeUser('host-a'); created.users.push(hostId);
    const guestId = await makeUser('guest-a'); created.users.push(guestId);
    const hostToken = await makeSession(hostId);
    const matchId = await makeRunningMatchWithTwoPlayers(hostId, guestId); created.matches.push(matchId);

    const res = await app.inject({
      method: 'POST',
      url: `/matches/${matchId}/leave`,
      headers: { authorization: `Bearer ${hostToken}` },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(await statusOf(matchId), 'running', 'one remaining player means the match is still live');
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test('a running match is marked finished once the last player leaves', async () => {
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const hostId = await makeUser('host-b'); created.users.push(hostId);
    const guestId = await makeUser('guest-b'); created.users.push(guestId);
    const hostToken = await makeSession(hostId);
    const guestToken = await makeSession(guestId);
    const matchId = await makeRunningMatchWithTwoPlayers(hostId, guestId); created.matches.push(matchId);

    await app.inject({
      method: 'POST',
      url: `/matches/${matchId}/leave`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    assert.equal(await statusOf(matchId), 'running', 'sanity: still one player left after the first leave');

    const res = await app.inject({
      method: 'POST',
      url: `/matches/${matchId}/leave`,
      headers: { authorization: `Bearer ${guestToken}` },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(
      await statusOf(matchId),
      'finished',
      'the roster is empty now -- the match must not stay running forever'
    );
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test('/matches/mine stops offering the match back once it empties', async () => {
  const created = { matches: [], users: [] };
  const app = await build();
  await app.ready();
  try {
    const hostId = await makeUser('host-c'); created.users.push(hostId);
    const guestId = await makeUser('guest-c'); created.users.push(guestId);
    const hostToken = await makeSession(hostId);
    const guestToken = await makeSession(guestId);
    const matchId = await makeRunningMatchWithTwoPlayers(hostId, guestId); created.matches.push(matchId);

    await app.inject({ method: 'POST', url: `/matches/${matchId}/leave`, headers: { authorization: `Bearer ${hostToken}` } });
    await app.inject({ method: 'POST', url: `/matches/${matchId}/leave`, headers: { authorization: `Bearer ${guestToken}` } });

    // A third, unrelated player opening the lobby next must not be able to
    // find this match via /matches/mine even if they somehow shared a
    // session — but more directly, neither the host nor guest should be
    // offered it back either, which is the actual reported symptom.
    const res = await app.inject({
      method: 'GET',
      url: '/matches/mine',
      headers: { authorization: `Bearer ${hostToken}` },
    });
    assert.equal(res.json().match, null);
  } finally {
    await cleanup(created);
    await app.close();
  }
});

test.after(async () => {
  await pool.end();
});
