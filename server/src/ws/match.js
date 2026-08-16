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
 * stall everyone forever. Past DROP_AFTER_MS a silent player is dropped so the
 * remaining players can carry on. Their team then simply idles: handing it to
 * an AI commander mid-match is a sensible follow-up but is not implemented.
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
    /** userId -> { socket, teamId, displayName, lastSeen, lastInputAt } */
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
 * Release every turn that now has input from all connected players.
 *
 * Ordering is the subtle part: inputs are sorted by teamId so every client
 * applies the batch in the same sequence. Two orders issued in the same turn
 * that interact (both buying the last affordable unit, say) must resolve the
 * same way everywhere, and arrival order at the server is not something clients
 * can agree on.
 */
export function releaseReadyTurns(room) {
  for (;;) {
    const turn = room.released + 1;
    const reported = room.pending.get(turn);
    // The barrier: until the match has begun, nothing is released at all. This
    // is what stops the first client to connect from advancing the turn clock
    // on its own and leaving every later arrival permanently behind it.
    if (!room.started || !room.players.size) return;
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

/**
 * Drop players who have gone quiet, so their silence cannot stall the match.
 *
 * "Quiet" means two different things and both have to be checked. A socket that
 * has stopped sending anything is the obvious case. The subtler one is a client
 * that faithfully answers the 5s heartbeat while never reporting a single turn
 * of input: `lastSeen` says it is healthy, `releaseReadyTurns` counts it in the
 * quorum, and every other player stalls forever waiting on a peer that is never
 * going to speak. That is not hypothetical — it is precisely how one real match
 * froze, and why participation is timed separately from liveness.
 *
 * Input silence only counts once the match has begun: before `begin` nobody is
 * expected to have reported anything yet.
 */
export function reapSilent(room) {
  const now = Date.now();
  for (const [userId, p] of room.players) {
    const gone = now - p.lastSeen > DROP_AFTER_MS;
    const mute = room.started && now - p.lastInputAt > DROP_AFTER_MS;
    if (!gone && !mute) continue;
    try { p.socket.close(4008, 'timed out'); } catch { /* already gone */ }
    room.players.delete(userId);
    broadcast(room, {
      t: 'playerLeft',
      userId,
      teamId: p.teamId,
      reason: gone ? 'timeout' : 'not_reporting',
    });
  }
  // Their absence may be exactly what several pending turns were waiting on.
  releaseReadyTurns(room);
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
    // Tracked separately from `lastSeen` on purpose — see `reapSilent`. The
    // heartbeat keeps `lastSeen` fresh whether or not the client is actually
    // participating, so it cannot answer "is this player still playing?".
    lastInputAt: Date.now(),
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
        player.lastInputAt = Date.now();
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
    room.players.delete(user.id);
    broadcast(room, { t: 'playerLeft', userId: user.id, teamId, reason: 'closed' });
    if (room.players.size === 0) rooms.delete(matchId);
    else releaseReadyTurns(room); // they may have been the turn we waited on
  });
}
