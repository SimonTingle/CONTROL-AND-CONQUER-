/**
 * Lockstep relay.
 *
 * The server does not simulate the game. It collects each player's input for a
 * turn and, once every connected player has reported, broadcasts the complete
 * set so all clients apply an identical ordered batch. That is the whole
 * protocol — no positions, no health, no authority over the world.
 *
 * ## Turns, and why they are not ticks
 *
 * The simulation runs at 60Hz, but exchanging input 60 times a second would be
 * wasteful and pointless: a player cannot express 60 distinct intentions per
 * second. So input is batched into **turns of TICKS_PER_TURN sim ticks**
 * (10 turns/sec), and input issued during turn N is executed at the start of
 * turn **N + INPUT_DELAY_TURNS** — the classic RTS arrangement. The delay is
 * what buys time for the round trip without stalling: by the time a client
 * needs turn N+2's inputs, they were sent two turns ago.
 *
 * ## Why the server holds the clock
 *
 * A turn is only released when every player has reported for it. That makes the
 * slowest player the pacer (real lockstep), and it is why a disconnect must be
 * handled explicitly rather than ignored — a vanished player would otherwise
 * stall everyone forever. Past DROP_AFTER_MS a silent player is dropped and
 * clients hand their team to the AI commander.
 *
 * ## Trust
 *
 * A client may only ever submit input for its **own** team; `teamId` comes from
 * the match roster, never from the message. That does not make the game
 * cheat-proof — in lockstep every client simulates everything, so a modified
 * client can always see more than it should — but it does stop one player
 * issuing orders to another's units, which is the difference between a cheat
 * and a griefing tool.
 */

import { userForToken, SESSION_COOKIE } from '../auth/sessions.js';
import { query } from '../db/pool.js';

/** Sim ticks per network turn. 6 at 60Hz = 10 turns/sec. */
export const TICKS_PER_TURN = 6;
/** Input issued in turn N runs at turn N+2 — ~200ms of cover for the round trip. */
export const INPUT_DELAY_TURNS = 2;
/** A player silent this long is dropped so the rest of the match can continue. */
const DROP_AFTER_MS = 15000;
/** Guard against a client flooding the relay; a turn's input is tiny. */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Live matches, keyed by match id. Purely in-memory: a restart ends matches. */
const rooms = new Map();

function roomFor(matchId, seed) {
  let room = rooms.get(matchId);
  if (!room) {
    room = {
      matchId,
      seed,
      /** userId -> { socket, teamId, displayName, lastSeen } */
      players: new Map(),
      /** turn -> Map(userId -> input[]) */
      pending: new Map(),
      /** Highest turn already broadcast. Clients may not run past it. */
      released: -1,
      /** Latest state hash reported per user, for desync detection (4D). */
      hashes: new Map(),
    };
    rooms.set(matchId, room);
  }
  return room;
}

function send(socket, msg) {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptUserId = null) {
  for (const [userId, p] of room.players) {
    if (userId !== exceptUserId) send(p.socket, msg);
  }
}

function rosterOf(room) {
  return [...room.players.entries()].map(([userId, p]) => ({
    userId,
    teamId: p.teamId,
    displayName: p.displayName,
  }));
}

/**
 * Release every turn that now has input from all connected players.
 *
 * Ordering is the subtle part: inputs are sorted by teamId so every client
 * applies the batch in the same sequence. Two orders issued in the same turn
 * that interact (both buying the last affordable unit, say) must resolve the
 * same way everywhere, and arrival order at the server is not something clients
 * can agree on.
 */
function releaseReadyTurns(room) {
  for (;;) {
    const turn = room.released + 1;
    const reported = room.pending.get(turn);
    // Nobody connected yet: nothing to release, and releasing an empty turn
    // would let a lone client run away from a peer still connecting.
    if (!room.players.size) return;
    if (!reported || reported.size < room.players.size) return;

    const inputs = [];
    for (const [userId, list] of reported) {
      const p = room.players.get(userId);
      if (!p) continue;
      for (const input of list) inputs.push({ teamId: p.teamId, ...input });
    }
    inputs.sort((a, b) => a.teamId - b.teamId);

    room.released = turn;
    room.pending.delete(turn);
    broadcast(room, { t: 'turn', turn, inputs });
  }
}

/** Drop players who have gone quiet, so their silence cannot stall the match. */
function reapSilent(room) {
  const now = Date.now();
  for (const [userId, p] of room.players) {
    if (now - p.lastSeen <= DROP_AFTER_MS) continue;
    try { p.socket.close(4008, 'timed out'); } catch { /* already gone */ }
    room.players.delete(userId);
    broadcast(room, { t: 'playerLeft', userId, teamId: p.teamId, reason: 'timeout' });
  }
  // Their absence may be exactly what several pending turns were waiting on.
  releaseReadyTurns(room);
}

export async function matchSocket(app) {
  // One sweep for every room rather than a timer per connection.
  const reaper = setInterval(() => {
    for (const room of rooms.values()) reapSilent(room);
  }, 5000);
  app.addHook('onClose', async () => clearInterval(reaper));

  app.get('/ws/match/:id', { websocket: true }, async (socket, req) => {
    // `onRequest` already resolved the session cookie for this upgrade, but fall
    // back to reading it directly so this does not silently depend on plugin
    // ordering — an unauthenticated socket is the one failure worth being loud
    // about.
    const user = req.user ?? (await userForToken(req.cookies?.[SESSION_COOKIE]));
    if (!user) {
      send(socket, { t: 'error', error: 'authentication_required' });
      socket.close(4001, 'authentication required');
      return;
    }

    const matchId = req.params.id;
    const { rows } = await query(
      `select m.seed, m.status, p.team_id
         from matches m
         join match_players p on p.match_id = m.id and p.user_id = $2
        where m.id = $1`,
      [matchId, user.id]
    );
    // Membership decides access, and it is a join in SQL — a non-member cannot
    // open a socket to a match at all, whatever id they supply.
    if (!rows.length) {
      send(socket, { t: 'error', error: 'not_a_member' });
      socket.close(4003, 'not a member');
      return;
    }
    const { seed, team_id: teamId } = rows[0];
    const room = roomFor(matchId, Number(seed));

    // A second socket for the same user replaces the first — a reload should
    // reclaim the seat rather than leave a ghost the match waits on forever.
    const previous = room.players.get(user.id);
    if (previous) {
      try { previous.socket.close(4009, 'replaced by a new connection'); } catch { /* gone */ }
    }
    room.players.set(user.id, {
      socket,
      teamId,
      displayName: user.display_name,
      lastSeen: Date.now(),
    });

    send(socket, {
      t: 'welcome',
      matchId,
      seed: room.seed,
      teamId,
      ticksPerTurn: TICKS_PER_TURN,
      inputDelayTurns: INPUT_DELAY_TURNS,
      // Where the match already is, so a reconnecting client knows it must
      // catch up rather than start from turn 0.
      releasedTurn: room.released,
      players: rosterOf(room),
    });
    broadcast(room, { t: 'playerJoined', userId: user.id, teamId, displayName: user.display_name }, user.id);

    socket.on('message', (raw) => {
      const player = room.players.get(user.id);
      if (!player || player.socket !== socket) return; // superseded connection
      if (raw.length > MAX_MESSAGE_BYTES) {
        send(socket, { t: 'error', error: 'message_too_large' });
        return;
      }
      player.lastSeen = Date.now();

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(socket, { t: 'error', error: 'malformed_message' });
        return;
      }

      switch (msg.t) {
        case 'input': {
          const turn = Number(msg.turn);
          // A turn already broadcast cannot be amended — accepting late input
          // would mean some clients had simulated it and others had not.
          if (!Number.isInteger(turn) || turn <= room.released) {
            send(socket, { t: 'error', error: 'turn_already_released', turn });
            return;
          }
          if (!room.pending.has(turn)) room.pending.set(turn, new Map());
          // teamId is attached at release time from the roster, so anything the
          // client claims about ownership here is ignored by construction.
          room.pending.get(turn).set(user.id, Array.isArray(msg.inputs) ? msg.inputs : []);
          releaseReadyTurns(room);
          return;
        }
        case 'hash': {
          // Desync detection (4D). Recorded per turn; a disagreement is
          // reported to everyone so the host can offer a resync.
          room.hashes.set(user.id, { turn: msg.turn, hash: msg.hash });
          const seen = new Map();
          for (const [uid, h] of room.hashes) {
            if (h.turn !== msg.turn) continue;
            seen.set(h.hash, [...(seen.get(h.hash) ?? []), uid]);
          }
          if (seen.size > 1) {
            broadcast(room, {
              t: 'desync',
              turn: msg.turn,
              groups: [...seen.entries()].map(([hash, users]) => ({ hash, users })),
            });
          }
          return;
        }
        case 'snapshot': {
          // The host answering a resync request: relayed verbatim to the one
          // client that needs it. The server never inspects or stores it.
          const target = room.players.get(msg.toUserId);
          if (target) send(target.socket, { t: 'snapshot', payload: msg.payload, turn: msg.turn });
          return;
        }
        case 'ping':
          send(socket, { t: 'pong', at: msg.at });
          return;
        default:
          send(socket, { t: 'error', error: 'unknown_message_type' });
      }
    });

    socket.on('close', () => {
      const current = room.players.get(user.id);
      // Only clear the seat if this socket still owns it — otherwise a
      // just-replaced connection's close event would evict its replacement.
      if (current?.socket !== socket) return;
      room.players.delete(user.id);
      broadcast(room, { t: 'playerLeft', userId: user.id, teamId, reason: 'closed' });
      if (room.players.size === 0) rooms.delete(matchId);
      else releaseReadyTurns(room); // they may have been the turn we waited on
    });
  });
}
