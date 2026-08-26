/**
 * Lockstep relay.
 *
 * The server does not simulate the game. It collects each player's input for a
 * turn and, once the **whole roster** has reported, broadcasts the complete set
 * so all clients apply an identical ordered batch. That is the whole protocol —
 * no positions, no health, no authority over the world.
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
 * ## Why the server holds the clock, and why the quorum is the roster
 *
 * A turn is only released once every **rostered** player has reported it —
 * `expectedPlayers`, not however many sockets happen to be open. That makes the
 * slowest player the pacer (real lockstep). It used to gate on the connected
 * count instead, on the reasoning that a vanished player should not stall
 * everyone forever. That reasoning was backwards: the moment one socket closed,
 * the survivor alone satisfied the (now smaller) quorum and free-ran at frame
 * rate, while the other player's session — behind by however many turns it
 * missed — could never catch up. Two real players spent a match exactly that
 * way: one at turn 14, the other still at turn 2, each in a world the other had
 * no way to reach. A drop now pauses the match for everyone until the missing
 * player returns (see `maybeBegin` for the identical rule at match start) or a
 * player chooses to leave, which is a client-side decision, not something this
 * file grants unilaterally by shrinking who it is willing to wait for.
 *
 * `DROP_AFTER_MS`/`reapSilent` still exist, but only to garbage-collect a
 * socket that has gone genuinely silent (no heartbeat, nothing) — removing it
 * tidies the roster display and lets a reconnect claim a clean seat. It does
 * **not** change `expectedPlayers`, so it cannot let the match run ahead
 * without the player it just removed.
 *
 * ## The start barrier
 *
 * Nothing is released until the whole roster has connected (see `maybeBegin`).
 * Releasing turns to whoever arrives first is not a smaller version of working
 * — it deadlocks the match outright, because a later arrival can never catch up
 * to turns that were broadcast before it existed.
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
/**
 * The room rules live in their own module so they can be imported without a
 * database — this file's route handler needs `db/pool.js`, and that made the
 * rules untestable. See matchRoom.js's header for the full reasoning.
 */
import {
  TICKS_PER_TURN,
  INPUT_DELAY_TURNS,
  PROTOCOL_VERSION,
  HASH_HISTORY_TURNS,
  MAX_MESSAGE_BYTES,
  rooms,
  createRoom,
  checkProtocolVersion,
  maybeBegin,
  releaseReadyTurns,
  reapSilent,
  dropPlayer,
  roomFor,
  send,
  broadcast,
  rosterOf,
} from './matchRoom.js';

/**
 * Re-exported so existing importers (and the two test suites) keep working
 * against the same path they always used. New code should prefer importing
 * from `matchRoom.js` directly when it only needs the rules — that is the
 * import that does not drag in Postgres.
 */
export {
  TICKS_PER_TURN,
  INPUT_DELAY_TURNS,
  PROTOCOL_VERSION,
  createRoom,
  checkProtocolVersion,
  maybeBegin,
  releaseReadyTurns,
  reapSilent,
};

export async function matchSocket(app) {
  // One sweep for every room rather than a timer per connection.
  const reaper = setInterval(() => {
    for (const room of rooms.values()) {
      // Begin first: a room still waiting on an absent player has no live
      // players to reap, and the grace window is what unblocks it.
      maybeBegin(room);
      reapSilent(room);
    }
  }, 5000);
  app.addHook('onClose', async () => clearInterval(reaper));

  // Declared as `wsHandler` + `handler` rather than the shorter
  // `{ websocket: true }` form, purely so a non-upgrade request gets a useful
  // answer. `websocket: true` makes @fastify/websocket install its own HTTP
  // fallback of `reply.code(404).send()` — a bare, bodyless 404 — which is
  // indistinguishable from the route not existing at all. That cost real
  // debugging time once: a reverse proxy that silently drops the
  // Upgrade/Connection headers turns every connection attempt into exactly
  // that 404, and nothing anywhere says so.
  app.get('/ws/match/:id', {
    handler: (req, reply) =>
      reply.code(426).send({
        error: 'websocket_upgrade_required',
        hint:
          'This endpoint only serves WebSocket connections. Seeing this from a ' +
          'browser or curl means the request arrived without Upgrade/Connection ' +
          'headers — usually a reverse proxy in front of the API that is not ' +
          'configured to forward WebSocket upgrades (on CapRover: enable ' +
          '"Websocket Support" in the app\'s HTTP Settings).',
      }),
    wsHandler: (socket, req) => handleMatchSocket(socket, req),
  });
}

/**
 * One player's socket, for the lifetime of their connection to a match.
 *
 * Split out of the route declaration so the route can carry both a wsHandler
 * and an HTTP fallback without burying either in the other's indentation.
 */
async function handleMatchSocket(socket, req) {
  // Checked before anything else — including authentication — so a build
  // mismatch is never confused with a credentials problem, and so a mismatched
  // client never gets far enough to be handed a `welcome` it would misread.
  const versionCheck = checkProtocolVersion(req.query?.protocolVersion);
  if (!versionCheck.ok) {
    send(socket, {
      t: 'error',
      error: 'protocol_version_mismatch',
      serverVersion: PROTOCOL_VERSION,
      clientVersion: versionCheck.clientVersion,
    });
    socket.close(4010, 'protocol version mismatch');
    return;
  }

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
    `select m.seed, m.status, m.host_user_id, m.custom_defs, p.team_id,
            (select count(*) from match_players mp where mp.match_id = m.id) as roster_size
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
  const {
    seed, team_id: teamId, host_user_id: hostUserId, roster_size: rosterSize,
    custom_defs: customDefs,
  } = rows[0];
  const room = roomFor(matchId, Number(seed), Number(rosterSize), customDefs ?? []);

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
    // Rides here too, not just the connect-time query check, so a *client*
    // ahead of an old server (one that predates checkProtocolVersion and so
    // never rejected the query param) still has something to compare against
    // and can refuse to proceed rather than trusting an unversioned peer.
    protocolVersion: PROTOCOL_VERSION,
    seed: room.seed,
    // The match's vehicle set. Read from the room rather than this socket's
    // own row so every peer is handed the same array even if the match row
    // were somehow edited after the first player connected — the room is the
    // snapshot, and it is written once.
    customDefs: room.customDefs,
    teamId,
    userId: user.id,
    // Who supplies the snapshot when someone diverges. The host is simply the
    // designated source of truth for a resync — it has no other authority,
    // and does not simulate on anyone else's behalf.
    hostUserId,
    isHost: user.id === hostUserId,
    // The client holds off reporting input until `begin`; this lets it say
    // what it is waiting for instead of showing a motionless world.
    expectedPlayers: room.expectedPlayers,
    started: room.started,
    ticksPerTurn: TICKS_PER_TURN,
    inputDelayTurns: INPUT_DELAY_TURNS,
    // Where the match already is, so a reconnecting client knows it must
    // catch up rather than start from turn 0.
    releasedTurn: room.released,
    players: rosterOf(room),
  });
  broadcast(room, { t: 'playerJoined', userId: user.id, teamId, displayName: user.display_name }, user.id);

  if (room.started) {
    // `begin` is broadcast once, at the moment the roster completes. A socket
    // arriving after that — a reload reclaiming its seat, per the replacement
    // logic above — would otherwise never receive it, never call
    // `session.start()`, and so never report input: it sits on "waiting for
    // players" forever while its silence stalls everybody else. Sending it
    // directly is what lets the client resync to `releasedTurn` and rejoin.
    send(socket, { t: 'begin', players: rosterOf(room), resuming: true });
    // Its world is whatever it had when it dropped, or nothing at all. Ask the
    // host for a snapshot through the same path a desync uses — the host is
    // already the designated source of truth for exactly this.
    const host = room.players.get(hostUserId);
    if (host && host.socket !== socket) {
      send(host.socket, { t: 'resyncNeeded', users: [user.id] });
    }
  } else {
    // This arrival may have been the one everyone was waiting for.
    maybeBegin(room);
  }

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
        const turn = Number(msg.turn);
        if (!Number.isInteger(turn)) return;

        // Bucketed by turn, not by user. Keeping only each user's latest hash
        // (as this did) means a peer reporting turn 10 then 20 before the other
        // reports turn 10 destroys the only value the comparison needed — the
        // set ends up with one member, nothing is compared, and the match is
        // declared healthy on the strength of a check that never ran.
        let bucket = room.hashes.get(turn);
        if (!bucket) {
          bucket = new Map();
          room.hashes.set(turn, bucket);
        }
        bucket.set(user.id, msg.hash);

        // A single report proves nothing; only compare once two clients have
        // described the same simulated moment.
        if (bucket.size >= 2) {
          const groups = new Map();
          for (const [uid, hash] of bucket) {
            groups.set(hash, [...(groups.get(hash) ?? []), uid]);
          }
          if (groups.size > 1) {
            console.log(`[match] desync in ${matchId} at turn ${turn}: ${groups.size} distinct hashes among ${bucket.size} reports`);
            broadcast(room, {
              t: 'desync',
              turn,
              groups: [...groups.entries()].map(([hash, users]) => ({ hash, users })),
            });
          } else {
            // Say so explicitly. "No desync reported" and "verified agreement"
            // are different claims and the readout must not conflate them.
            console.log(`[match] agreed in ${matchId} at turn ${turn}: ${bucket.size} peers`);
            broadcast(room, { t: 'agreed', turn, peers: bucket.size });
          }
        }

        // Buckets are only useful until compared; drop anything well behind the
        // newest turn so a long match cannot grow this without bound.
        for (const t of room.hashes.keys()) {
          if (t < turn - HASH_HISTORY_TURNS) room.hashes.delete(t);
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

  socket.on('close', (code, reason) => {
    const current = room.players.get(user.id);
    // Only clear the seat if this socket still owns it — otherwise a
    // just-replaced connection's close event would evict its replacement.
    if (current?.socket !== socket) return;
    console.log(`[match] ${user.id} socket closed on ${matchId}: code=${code} reason=${reason?.toString?.() || '(none)'}`);
    dropPlayer(room, user.id);
    broadcast(room, { t: 'playerLeft', userId: user.id, teamId, reason: 'closed' });
    // `expectedPlayers` is unchanged by this — the room now waits for this
    // player to come back rather than releasing turns without them (see the
    // file header). Emptying the room entirely is the one case with nobody
    // left to wait for.
    if (room.players.size === 0) rooms.delete(matchId);
  });
}
