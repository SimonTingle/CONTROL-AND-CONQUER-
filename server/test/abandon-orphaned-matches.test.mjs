/**
 * `abandonOrphanedMatches` — marking every `open`/`running` match dead at boot.
 *
 * Found from a real production report: two accounts each went straight into
 * a match instead of the lobby, and turned out to be two *different*
 * matches — one fresh and waiting for a second player, the other a match
 * from an earlier test session, stuck at `status='running'` since before a
 * deploy days earlier. `matchRoom.js`'s `rooms` map is purely in-memory, so
 * that deploy's restart silently ended the match without ever telling the
 * database. `/matches/mine` (see matches-mine.test.mjs) then kept returning
 * that stale row on every subsequent lobby visit — the process had a fresh,
 * empty `rooms` map, so a "reconnect" to it built a brand-new solo room
 * (`expectedPlayers=1`) rather than actually resuming anything, and
 * permanently hijacked that account away from ever reaching the lobby
 * normally again.
 *
 * A real Postgres integration test, not a mock — the value here is the SQL
 * itself. Uses the same real (local, disposable) database as
 * matches-mine.test.mjs; every row this file creates is deleted in a
 * `finally` so a failed run cannot poison later ones.
 *
 * Run: node --test server/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { abandonOrphanedMatches } from '../src/routes/matches.js';
import { query, pool } from '../src/db/pool.js';

async function makeUser(label) {
  const id = randomUUID();
  await query(
    `insert into users (id, email, password_hash, display_name)
     values ($1, $2, 'x', $3)`,
    [id, `orphan-test-${label}-${id}@example.com`, `Test ${label}`]
  );
  return id;
}

async function makeMatch({ hostId, status }) {
  const id = randomUUID();
  await query(
    `insert into matches (id, host_user_id, name, seed, status, max_players)
     values ($1, $2, 'Test Match', 12345, $3, 2)`,
    [id, hostId, status]
  );
  return id;
}

async function statusOf(matchId) {
  const { rows } = await query('select status from matches where id = $1', [matchId]);
  return rows[0]?.status;
}

async function cleanup(ids) {
  if (ids.matches.length) {
    await query('delete from matches where id = any($1)', [ids.matches]);
  }
  if (ids.users.length) {
    await query('delete from users where id = any($1)', [ids.users]);
  }
}

test('abandons a running match left over from before this boot', async () => {
  const created = { matches: [], users: [] };
  try {
    const hostId = await makeUser('running-host'); created.users.push(hostId);
    const matchId = await makeMatch({ hostId, status: 'running' }); created.matches.push(matchId);

    const count = await abandonOrphanedMatches();

    assert.ok(count >= 1, 'must report at least the one match it abandoned');
    assert.equal(await statusOf(matchId), 'abandoned');
  } finally {
    await cleanup(created);
  }
});

test('abandons an open (never-started) match too', async () => {
  const created = { matches: [], users: [] };
  try {
    const hostId = await makeUser('open-host'); created.users.push(hostId);
    const matchId = await makeMatch({ hostId, status: 'open' }); created.matches.push(matchId);

    await abandonOrphanedMatches();

    assert.equal(await statusOf(matchId), 'abandoned');
  } finally {
    await cleanup(created);
  }
});

test('leaves an already-finished match untouched', async () => {
  const created = { matches: [], users: [] };
  try {
    const hostId = await makeUser('finished-host'); created.users.push(hostId);
    const matchId = await makeMatch({ hostId, status: 'finished' }); created.matches.push(matchId);

    await abandonOrphanedMatches();

    assert.equal(await statusOf(matchId), 'finished', 'a legitimately finished match must not be touched');
  } finally {
    await cleanup(created);
  }
});

test('leaves an already-abandoned match untouched', async () => {
  const created = { matches: [], users: [] };
  try {
    const hostId = await makeUser('abandoned-host'); created.users.push(hostId);
    const matchId = await makeMatch({ hostId, status: 'abandoned' }); created.matches.push(matchId);

    await abandonOrphanedMatches();

    assert.equal(await statusOf(matchId), 'abandoned');
  } finally {
    await cleanup(created);
  }
});

test.after(async () => {
  await pool.end();
});
