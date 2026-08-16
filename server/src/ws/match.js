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

/** Sim ticks per network turn. 6 at 60Hz = 10 turns/sec. */
export const TICKS_PER_TURN = 6;
/** Input issued in turn N runs at turn N+2 — ~200ms of cover for the round trip. */
export const INPUT_DELAY_TURNS = 2;
/** A player silent this long is dropped so the rest of the match can continue. */
const DROP_AFTER_MS = 15000;
/**
 * How long the first arrival waits before the room starts *saying* who it is
 * still missing. This is a reporting threshold, not a start trigger.
 *
 * It used to be the latter — the match began without the absentees once this
 * expired, on the reasoning that somebody who closed their tab must not hang
 * everyone else. That trade was a bad one: a short-rostered start does not
 * degrade gracefully, it produces a match that cannot work. The first client
 * runs alone (see `releaseReadyTurns`, which gates on who is *connected*), the
 * late arrival can never catch up to turns broadcast before it existed, and
 * neither player is told any of this. Two real players spent a match that way,
 * each building a private world on the same map.
 *
 * Waiting forever is the honest failure: the client shows who is missing and
 * offers to leave, so the human decides rather than the timer deciding badly.
 */
const START_REPORT_AFTER_MS = Number(process.env.MATCH_START_REPORT_MS ?? 30000);
/**
 * How many turns of state digests to keep. A bucket is only needed until every
 * client has reported that turn; a few turns of slack covers ordinary jitter.
 */
const HASH_HISTORY_TURNS = 40;
/** Guard against a client flooding the relay; a turn's input is tiny. */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Live matches, keyed by match id. Purely in-memory: a restart ends matches. */
const rooms = new Map();

/**
 * A fresh room. Exported so the barrier and release rules can be tested
 * directly — they are the part of this file that decides whether a match is
 * playable, and they are worth checking without standing up a database and two
 * browsers to do it.
 */
export function createRoom(matchId, seed, expectedPlayers) {
  // A missing or malformed roster count must not become an unsatisfiable
  // barrier: `players.size >= NaN` is false forever, which would leave the
  // match waiting forever with no indication why. Fall back to "just me", so
  // the worst case is a solo room that begins rather than one that never can.
  if (!Number.isFinite(expectedPlayers) || expectedPlayers < 1) expectedPlayers = 1;
  return {
    matchId,
    seed,
    /**
     * How many players the roster says to wait for. The turn clock must not
     * start until they are all here — see `maybeBegin`.
     */
    expectedPlayers,
    /** Set once the match has begun; nothing is released before it. */
    started: false,
    /** When the first client connected, for the waiting-report threshold. */
    firstJoinAt: Date.now(),
    /** userId -> { socket, teamId, displayName, lastSeen } */
    players: new Map(),
    /** turn -> Map(userId -> input[]) */
    pending: new Map(),
    /** Highest turn already broadcast. Clients may not run past it. */
    released: -1,
    /** turn -> Map(userId -> hash), for desync detection (4D). */
    hashes: new Map(),
  };
}

function roomFor(matchId, seed, expectedPlayers) {
  let room = rooms.get(matchId);
  if (!room) {
    room = createRoom(matchId, seed, expectedPlayers);
    rooms.set(matchId, room);
  }
  return room;
}


/**
 * Start the match once the whole roster is present — and not before, whatever
 * the wait.
 *
 * This barrier is not a nicety, it is what makes lockstep work at all. Without
 * it the first client to connect reports turns 0..DELAY and the server, seeing
 * only one connected player, releases them immediately; the client simulates
 * away. When the second client arrives its own turn 0 is already behind
 * `released`, so it is rejected and it waits forever for a broadcast that has
 * already happened — while the first client waits for input from a peer that
 * will never begin a turn. A mutual deadlock, and the reason both machines
 * rendered a frozen world on the first real two-player match.
 *
 * A timeout that starts anyway does not avoid that failure, it *causes* it:
 * see START_REPORT_AFTER_MS.
 */
export function maybeBegin(room) {
  if (room.started) return;
  if (room.players.size < room.expectedPlayers) {
    reportWaiting(room);
    return;
  }

  room.started = true;
  broadcast(room, { t: 'begin', players: rosterOf(room) });
  releaseReadyTurns(room);
}

/**
 * Tell a still-incomplete room what it is waiting for, once the wait has gone
 * on long enough to look like a problem rather than a page load.
 *
 * Sent repeatedly (the reaper calls `maybeBegin` every 5s) because it is the
 * only thing distinguishing "still connecting" from "never coming" — and the
 * client needs the difference to offer a sensible way out.
 */
function reportWaiting(room) {
  if (Date.now() - room.firstJoinAt < START_REPORT_AFTER_MS) return;
  broadcast(room, {
    t: 'waiting',
    present: room.players.size,
    expected: room.expectedPlayers,
    players: rosterOf(room),
  });
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
 * Release every turn that now has input from the **whole roster**.
 *
 * Deliberately `room.expectedPlayers`, not `room.players.size`. Gating on who
 * is currently connected is what let a lone survivor free-run past a dropped
 * peer — see the file header. Gating on the roster means a drop pauses the
 * clock for everyone, symmetrically with the start barrier in `maybeBegin`:
 * neither one ever releases a turn on behalf of a player who has not actually
 * reported it, whether that player has never connected yet or has stopped.
 *
 * Ordering is the other subtle part: inputs are sorted by teamId so every
 * client applies the batch in the same sequence. Two orders issued in the same
 * turn that interact (both buying the last affordable unit, say) must resolve
 * the same way everywhere, and arrival order at the server is not something
 * clients can agree on.
 */
export function releaseReadyTurns(room) {
  for (;;) {
    const turn = room.released + 1;
    const reported = room.pending.get(turn);
    // The barrier: until the match has begun, nothing is released at all. This
    // is what stops the first client to connect from advancing the turn clock
    // on its own and leaving every later arrival permanently behind it.
    if (!room.started) return;
    if (!reported || reported.size < room.expectedPlayers) return;

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

/**
 * Drop a socket that has gone genuinely silent — no message of any kind,
 * including the heartbeat, for `DROP_AFTER_MS`.
 *
 * This used to also reap a client that kept answering the heartbeat while
 * never reporting a turn of input, on the theory that such a client was dead
 * in every way that mattered. It was not: that is the *normal* appearance of a
 * client correctly waiting on a stalled peer — `beginStep()` stops sending
 * input the instant a turn is missing, by design, so "reporting nothing" and
 * "participating correctly" look identical from here. Reaping on it meant a
 * legitimate stall ejected both players within one sweep of each other, which
 * is not a recovery, it is the failure with extra steps.
 *
 * So this only ever removes a socket that is actually gone. It does not touch
 * `expectedPlayers`, so it cannot let the match run ahead of a player it just
 * removed — see the file header. Its only effect is to tidy the roster display
 * and free the seat for a genuine reconnect.
 */
export function reapSilent(room) {
  const now = Date.now();
  for (const [userId, p] of room.players) {
    if (now - p.lastSeen <= DROP_AFTER_MS) continue;
    try { p.socket.close(4008, 'timed out'); } catch { /* already gone */ }
    dropPlayer(room, userId);
    broadcast(room, { t: 'playerLeft', userId, teamId: p.teamId, reason: 'timeout' });
  }
}

/**
 * Remove a player's bookkeeping, wherever it lives.
 *
 * `room.hashes` matters most: it is never otherwise purged on departure (only
 * aged out by turn number), so a hash left behind by a dead connection would
 * sit in its turn's bucket and later get compared against a live peer's report
 * for that same turn — a phantom desync, since the two were never describing
 * the same running match. Shared by both places a player can leave (an
 * explicit socket close, and this file's own silent-socket reap) so neither one
 * can forget it.
 */
function dropPlayer(room, userId) {
  room.players.delete(userId);
  for (const bucket of room.hashes.values()) bucket.delete(userId);
}

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
    `select m.seed, m.status, m.host_user_id, p.team_id,
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
  const { seed, team_id: teamId, host_user_id: hostUserId, roster_size: rosterSize } = rows[0];
  const room = roomFor(matchId, Number(seed), Number(rosterSize));

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
            broadcast(room, {
              t: 'desync',
              turn,
              groups: [...groups.entries()].map(([hash, users]) => ({ hash, users })),
            });
          } else {
            // Say so explicitly. "No desync reported" and "verified agreement"
            // are different claims and the readout must not conflate them.
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

  socket.on('close', () => {
    const current = room.players.get(user.id);
    // Only clear the seat if this socket still owns it — otherwise a
    // just-replaced connection's close event would evict its replacement.
    if (current?.socket !== socket) return;
    dropPlayer(room, user.id);
    broadcast(room, { t: 'playerLeft', userId: user.id, teamId, reason: 'closed' });
    // `expectedPlayers` is unchanged by this — the room now waits for this
    // player to come back rather than releasing turns without them (see the
    // file header). Emptying the room entirely is the one case with nobody
    // left to wait for.
    if (room.players.size === 0) rooms.delete(matchId);
  });
}
