/**
 * The lockstep room: the rules that decide whether a match is playable.
 *
 * Split out of `match.js` for one reason — **so it can be imported without a
 * database.** These rules are the part of the relay worth testing directly:
 * the start barrier, the turn-release quorum, the protocol check, the silent-
 * player reap. None of them touch Postgres. But they used to live alongside
 * `matchSocket`, whose route handler imports `db/pool.js`, and an ES module
 * import pulls in the whole file — so `tests/match-room.test.mjs` and
 * `tests/match-client-protocol.test.mjs` transitively required `pg` to be
 * installed just to read `PROTOCOL_VERSION`.
 *
 * It wasn't, so both suites died on `ERR_MODULE_NOT_FOUND` before running a
 * single assertion, and had done for months. That mattered more than a red
 * tick: `match-client-protocol.test.mjs` exists *specifically* to catch the
 * client and server disagreeing about `PROTOCOL_VERSION`, and a guard that
 * cannot import is not guarding anything. See
 * `docs/plans/reviving-the-dead-protocol-guard.md`.
 *
 * The fix is this file rather than installing `pg` at the root, because
 * CLAUDE.md requires `npm test` to stay dependency-free — no database, no
 * browser, no network. Installing the driver would have satisfied the test
 * runner while leaving that rule broken.
 *
 * `Date.now()` and `process.env` are used freely here. This is the *relay*,
 * not the simulation — the determinism rules in CLAUDE.md govern `src/`, where
 * every client must compute identical state from a shared seed. The server
 * holds a wall clock on purpose.
 */

/** Sim ticks per network turn. 6 at 60Hz = 10 turns/sec. */
export const TICKS_PER_TURN = 6;
/** Input issued in turn N runs at turn N+2 — ~200ms of cover for the round trip. */
export const INPUT_DELAY_TURNS = 2;
/**
 * Wire protocol version. Bump this whenever a message shape or the meaning of
 * an existing field changes in a way an older or newer peer would silently
 * misinterpret it — a new `Intent.command` field, `resumeAt` sending
 * differently, a new frame either side must react to (`waiting`,
 * `resyncNeeded`). PR #62 and the running-match quorum fix both changed wire
 * behavior without bumping anything, because there was nothing to bump; two
 * players on different builds during that deploy would have failed in
 * whatever undocumented way the mismatch happened to produce, rather than
 * being told plainly that their builds disagree.
 *
 * Checked in both directions: the client sends its own value as a query
 * param on connect, checked here before the socket is trusted with anything
 * (`clientProtocolVersion` below); and the server's value rides the
 * `welcome` frame for `src/net/matchClient.js` to check against its own,
 * which is what catches an *old* server that predates this file's check
 * entirely and so never rejects the query param at all.
 */
export const PROTOCOL_VERSION = 2;
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
export const HASH_HISTORY_TURNS = 40;
/** Guard against a client flooding the relay; a turn's input is tiny. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Live matches, keyed by match id. Purely in-memory: a restart ends matches. */
export const rooms = new Map();

/**
 * A fresh room. Exported so the barrier and release rules can be tested
 * directly — they are the part of this file that decides whether a match is
 * playable, and they are worth checking without standing up a database and two
 * browsers to do it.
 */
export function createRoom(matchId, seed, expectedPlayers, customDefs = []) {
  // A missing or malformed roster count must not become an unsatisfiable
  // barrier: `players.size >= NaN` is false forever, which would leave the
  // match waiting forever with no indication why. Fall back to "just me", so
  // the worst case is a solo room that begins rather than one that never can.
  if (!Number.isFinite(expectedPlayers) || expectedPlayers < 1) expectedPlayers = 1;
  return {
    matchId,
    seed,
    /**
     * The match's vehicle set, snapshotted from the host's loadout when the
     * lobby was created (see routes/matches.js). Relayed verbatim in `welcome`
     * so every peer resolves the same `defId` to the same vehicle — without it
     * a custom def is a silent divergence, which is why custom vehicles were
     * offline-only before this existed.
     */
    customDefs,
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

/**
 * Validate the client's declared protocol version before anything else about
 * the connection is trusted. Exported so the rejection rule can be checked
 * directly — the same way the barrier and release rules are (see
 * match-room.test.mjs) — without standing up a socket and a database to do
 * it. A missing or non-numeric version (an old client, which never sent the
 * query param at all) is rejected exactly like a numeric one that disagrees.
 */
export function checkProtocolVersion(rawVersion) {
  const clientVersion = Number(rawVersion);
  if (Number.isInteger(clientVersion) && clientVersion === PROTOCOL_VERSION) return { ok: true };
  return { ok: false, clientVersion: Number.isInteger(clientVersion) ? clientVersion : null };
}

function roomFor(matchId, seed, expectedPlayers, customDefs) {
  let room = rooms.get(matchId);
  if (!room) {
    // Diagnostic only: rooms are in-memory and per-process (see the module
    // header). A player landing here for a matchId this process has never
    // seen — while another player is already mid-match on the same id — is
    // exactly what a split-across-processes deploy looks like from inside
    // one process; it has no way to see the other room. This log is the only
    // trace of that ever left behind.
    console.log(`[match] new room for ${matchId}: seed=${seed} expectedPlayers=${expectedPlayers}`);
    room = createRoom(matchId, seed, expectedPlayers, customDefs);
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
    console.log(`[match] reaping ${userId} from ${room.matchId}: silent for ${now - p.lastSeen}ms`);
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
export function dropPlayer(room, userId) {
  room.players.delete(userId);
  for (const bucket of room.hashes.values()) bucket.delete(userId);
}