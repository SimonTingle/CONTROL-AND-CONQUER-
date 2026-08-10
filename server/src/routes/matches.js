/**
 * Multiplayer lobbies.
 *
 * The server is a matchmaker and (over the websocket) a clock — it never
 * simulates the game. These routes only answer "which matches exist, and who is
 * in them"; everything about the world itself is derived on the clients from
 * the seed stored here.
 *
 * Same authorisation stance as saves.js: membership is enforced in SQL rather
 * than checked in JS after the fact.
 */

import { z } from 'zod';
import { query, transaction } from '../db/pool.js';

const uuid = z.string().uuid();

const createBody = z.object({
  name: z.string().trim().min(1).max(64),
  maxPlayers: z.number().int().min(2).max(4).default(2),
  aiCount: z.number().int().min(0).max(3).default(0),
  difficultyId: z.string().max(32).default('normal'),
  // Optional so a client can pin a seed for testing; otherwise the server
  // picks, which keeps it out of the hands of a client that might want to
  // scout the map before anyone else joins.
  seed: z.number().int().nullish(),
});

function randomSeed() {
  // Positive and comfortably inside both Postgres bigint and JS safe-integer
  // range; the game's own seed handling treats this as an opaque number.
  return Math.floor(Math.random() * 2 ** 31);
}

/** Row -> API shape, so the wire format never leaks snake_case column names. */
function toMatch(r) {
  return {
    id: r.id,
    name: r.name,
    hostUserId: r.host_user_id,
    hostName: r.host_name ?? null,
    seed: Number(r.seed),
    status: r.status,
    maxPlayers: r.max_players,
    aiCount: r.ai_count,
    difficultyId: r.difficulty_id,
    playerCount: r.player_count != null ? Number(r.player_count) : undefined,
    createdAt: r.created_at,
  };
}

export async function matchRoutes(app) {
  const auth = { onRequest: app.requireAuth };

  /** Open lobbies, newest first. */
  app.get('/matches', auth, async () => {
    const { rows } = await query(
      `select m.*, u.display_name as host_name,
              (select count(*) from match_players p where p.match_id = m.id) as player_count
         from matches m
         join users u on u.id = m.host_user_id
        where m.status = 'open'
        order by m.created_at desc
        limit 50`
    );
    return { matches: rows.map(toMatch) };
  });

  /** One match, with its roster — what the lobby screen polls while waiting. */
  app.get('/matches/:id', auth, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const { rows } = await query(
      `select m.*, u.display_name as host_name
         from matches m join users u on u.id = m.host_user_id
        where m.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });

    const players = await query(
      `select p.user_id, p.team_id, u.display_name
         from match_players p join users u on u.id = p.user_id
        where p.match_id = $1
        order by p.team_id`,
      [req.params.id]
    );
    return {
      match: toMatch(rows[0]),
      players: players.rows.map((p) => ({
        userId: p.user_id,
        teamId: p.team_id,
        displayName: p.display_name,
      })),
    };
  });

  /** Create a lobby. The host takes team 0 in the same transaction. */
  app.post('/matches', auth, async (req, reply) => {
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    const { name, maxPlayers, aiCount, difficultyId } = parsed.data;
    const seed = parsed.data.seed ?? randomSeed();

    const match = await transaction(async (client) => {
      const { rows } = await client.query(
        `insert into matches (host_user_id, name, seed, max_players, ai_count, difficulty_id)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [req.user.id, name, seed, maxPlayers, aiCount, difficultyId]
      );
      await client.query(
        'insert into match_players (match_id, user_id, team_id) values ($1, $2, 0)',
        [rows[0].id, req.user.id]
      );
      return rows[0];
    });

    return reply.code(201).send({ match: toMatch(match) });
  });

  /**
   * Join a lobby. Team assignment happens inside a transaction that locks the
   * match row: two players hitting Join at the same instant would otherwise
   * both read "3 players, next team is 3" and collide. The unique constraint on
   * (match_id, team_id) is the backstop if that ever slips.
   */
  app.post('/matches/:id/join', auth, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    try {
      const result = await transaction(async (client) => {
        const { rows } = await client.query(
          'select * from matches where id = $1 for update',
          [req.params.id]
        );
        if (!rows.length) return { error: 'not_found', code: 404 };
        const match = rows[0];
        if (match.status !== 'open') return { error: 'match_not_open', code: 409 };

        const existing = await client.query(
          'select team_id from match_players where match_id = $1 and user_id = $2',
          [match.id, req.user.id]
        );
        // Re-joining is not an error — a player who reloaded should get their
        // own team back rather than a second slot or a rejection.
        if (existing.rows.length) {
          return { match, teamId: existing.rows[0].team_id };
        }

        const taken = await client.query(
          'select team_id from match_players where match_id = $1 order by team_id',
          [match.id]
        );
        if (taken.rows.length >= match.max_players) {
          return { error: 'match_full', code: 409 };
        }
        // Lowest free team id, so a player leaving does not leave a permanent
        // hole in the team numbering.
        const used = new Set(taken.rows.map((r) => r.team_id));
        let teamId = 0;
        while (used.has(teamId)) teamId++;

        await client.query(
          'insert into match_players (match_id, user_id, team_id) values ($1, $2, $3)',
          [match.id, req.user.id, teamId]
        );
        return { match, teamId };
      });

      if (result.error) return reply.code(result.code).send({ error: result.error });
      return { match: toMatch(result.match), teamId: result.teamId };
    } catch (err) {
      req.log.error({ err }, 'match join failed');
      return reply.code(500).send({ error: 'join_failed' });
    }
  });

  /** Host starts the match; after this the lobby stops accepting joins. */
  app.post('/matches/:id/start', auth, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const { rows } = await query(
      `update matches set status = 'running', started_at = now()
        where id = $1 and host_user_id = $2 and status = 'open'
        returning *`,
      [req.params.id, req.user.id]
    );
    // Scoped to host_user_id in the UPDATE itself: a non-host gets the same
    // "nothing to start" answer as a stranger, with no row ever touched.
    if (!rows.length) return reply.code(404).send({ error: 'not_found_or_not_host' });
    return { match: toMatch(rows[0]) };
  });

  /** Leave a lobby. The host leaving abandons the match for everyone. */
  app.post('/matches/:id/leave', auth, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    await transaction(async (client) => {
      await client.query(
        'delete from match_players where match_id = $1 and user_id = $2',
        [req.params.id, req.user.id]
      );
      await client.query(
        `update matches set status = 'abandoned'
          where id = $1 and host_user_id = $2 and status = 'open'`,
        [req.params.id, req.user.id]
      );
    });
    return { ok: true };
  });
}
