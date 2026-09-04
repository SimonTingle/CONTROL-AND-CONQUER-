/**
 * WebSocket transport for a lockstep match.
 *
 * Deliberately thin: it owns the socket and the message vocabulary, and hands
 * everything else to callbacks. The turn logic lives in lockstep.js and the
 * simulation knows nothing about either — which is what lets the lockstep rules
 * be reasoned about (and tested) without a socket in the picture.
 */

import { getSessionToken } from './api.js';

/** Same origin the REST client uses; baked in at build time by Vite. */
const API_BASE = typeof __API_URL__ === 'string' ? __API_URL__ : '';

/**
 * Wire protocol version this client build understands. Sent as a query param
 * on connect so a server with a different one — see
 * `server/src/ws/match.js`'s `PROTOCOL_VERSION` — can reject the connection
 * before it is trusted with anything, and cross-checked against the value the
 * server echoes back in `welcome` so an *old* server (one that predates that
 * check and never rejects the query param) is still caught, from this side.
 *
 * Bump alongside the server's constant whenever the wire format changes in a
 * way an older or newer peer would misinterpret.
 */
// v2 added `customDefs` to the `welcome` frame — the match's author-built
// vehicle set. A v1 client joining a v2 match would ignore the array and
// resolve none of those defIds, which is precisely the silent divergence the
// version check exists to prevent, so this is exactly the kind of change that
// must bump it rather than ride along as an additive field.
// v3 does not change the wire format at all — it bumps because the
// *simulation behind it* did. Between v2 and v3, src/ gained travelling
// projectiles, craters, bounty coins and veterancy (SCHEMA_VERSION 2 -> 3),
// while the itch.io fork stayed on hitscan combat and none of those modules.
// Both still declared v2, so the handshake passed and the two builds joined
// the same match and diverged on the first shot fired — one resolving damage
// instantly, the other flying a shell.
//
// That is the case this constant exists to catch and structurally could not:
// it guards the shape of the frames, but what actually has to match is the
// simulation reading them. So the rule is wider than the comment above
// implies — bump when the wire format changes, *and* when a change lands that
// two peers would simulate differently. A stale deployed bundle then fails
// loudly at the handshake instead of silently playing a different game.
// See docs/plans/itch-fork-silent-split-brain.md.
//
// v4 is that wider rule applied deliberately rather than in hindsight: the
// frames are unchanged again, but harvesters now consult team-shared danger
// zones when choosing a field (harvesterAI.js) and the AI commander's army
// budget no longer counts scouts (aiCommander.js). Both decide where units
// drive, so two peers straddling this bump diverge within seconds.
//
// v5 changes what `hashState` covers: structure positions and def ids, plus a
// digest of the generated island. This is the bump the wider rule exists for —
// a real match was played to completion with each player unable to find the
// other's base while the desync check reported agreement throughout, because a
// structure could stand anywhere on either client and still hash equal. Two
// peers on either side of this bump compute different hashes for the identical
// world, which would desync permanently; refusing the connection is the honest
// answer. See docs/plans/split-brain-invisible-to-the-hash.md.
export const PROTOCOL_VERSION = 5;

// Exported so the query-string construction can be checked directly without a
// browser `location` global — see matchClient-protocol.test.mjs, which sets
// `__API_URL__` before importing this module for exactly that reason.
export function socketUrl(matchId) {
  // The session cookie rides the upgrade request, so the socket must go to the
  // same origin the cookie was set for — hence deriving it from the API base
  // rather than from location.
  const base = API_BASE || `${location.protocol}//${location.host}`;
  return `${base.replace(/^http/, 'ws')}/ws/match/${matchId}?protocolVersion=${PROTOCOL_VERSION}`;
}

/**
 * Subprotocols for the upgrade: none normally, `['ptg-bearer', <token>]` when
 * this build carries its session as a token rather than a cookie.
 *
 * The browser WebSocket API has no way to set an Authorization header, and the
 * alternative — the token as a query parameter — would write a live credential
 * into every access log the request passes through. The subprotocol list is
 * the one client-settable handshake header, so the token goes there.
 *
 * Exported for the same reason `socketUrl` is: so the handshake can be checked
 * without a browser WebSocket.
 */
export function socketProtocols() {
  const token = getSessionToken();
  return token ? ['ptg-bearer', token] : undefined;
}

/**
 * Turn a `welcome`/`error` frame's version fields into a message worth
 * showing a player. Exported so the wording can be checked directly, without
 * a real socket (matchClient.js otherwise needs a browser WebSocket to do
 * anything).
 */
export function versionMismatchMessage({ serverVersion, clientVersion }) {
  return (
    `protocol version mismatch: this client speaks v${clientVersion ?? PROTOCOL_VERSION}, ` +
    `the match server speaks v${serverVersion ?? 'an older, unversioned build'} — ` +
    'one side of this match needs to redeploy before it can be joined.'
  );
}

/**
 * Close codes this client must never retry behind: each is the server (or
 * this client itself, mirroring the server's own code back) deliberately
 * ending the connection for a reason a reconnect cannot fix.
 *   4001 authentication_required, 4003 not_a_member, 4008 timed out
 *   (matchRoom.js's reapSilent — this socket was silent past DROP_AFTER_MS),
 *   4009 replaced by a new connection (this exact client reconnecting
 *   elsewhere), 4010 protocol version mismatch.
 *
 * Belt-and-suspenders alongside the `wasClean` check below: every one of
 * these is an explicit `socket.close(code, reason)` from the server, which
 * should already report `wasClean: true`, but this list is what actually
 * decides "never retry" rather than trusting a browser's `wasClean` in every
 * case.
 */
const TERMINAL_CLOSE_CODES = new Set([4001, 4003, 4008, 4009, 4010]);

/** How many times to retry an abnormal mid-match close before giving up. */
const RECONNECT_ATTEMPTS = 3;
/** Backoff base — attempt N waits N times this, so 1s/2s/3s. */
const RECONNECT_BASE_DELAY_MS = 1000;

export class MatchClient {
  /**
   * @param {string} matchId
   * @param {object} handlers `onWelcome, onBegin, onTurn, onAgreed, onDesync,
   *   onSnapshot, onPlayerJoined, onPlayerLeft, onError, onClose`
   */
  constructor(matchId, handlers = {}) {
    this.matchId = matchId;
    this.handlers = handlers;
    this.socket = null;
    this.connected = false;
    /** Populated from the server's welcome — the match's ground truth. */
    this.info = null;
    this.heartbeat = null;
    /** Diagnostic only: last time a 'pong' was actually received back. */
    this.lastPongAt = null;
    /** Set once `connect()`'s first welcome/error/close has settled it. */
    this._connectSettle = null;
    /**
     * True once any welcome has ever landed. Reconnection only makes sense
     * past this point — a close before it is a handshake failure (server
     * down, upgrade not forwarded), which `connect()`'s own rejection already
     * reports; retrying that silently would just repeat it.
     */
    this._everConnected = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._connectSettle = { resolve, reject, settled: false };
      this._openSocket();
    });
  }

  /**
   * Open one WebSocket and wire it up. Split out of `connect()` so a mid-match
   * reconnect (see `_handleClose`) can call it again on a fresh socket without
   * re-running `connect()`'s promise machinery — `_connectSettle` stays
   * pointed at the *original* call, already resolved by then.
   */
  _openSocket() {
    const ws = new WebSocket(socketUrl(this.matchId), socketProtocols());
    this.socket = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      // Liveness has to be independent of the simulation. The server drops a
      // client that has gone quiet, and a client's input is its only other
      // traffic — so a client that is *stalled waiting for a peer* sends
      // nothing and looks identical to one that crashed. Without this, any
      // genuine stall would end with the server reaping both players, which
      // is precisely the situation lockstep is supposed to survive.
      this.heartbeat = setInterval(() => this._send({ t: 'ping', at: Date.now() }), 5000);
    });

    ws.addEventListener('message', (ev) => this._handleMessage(ev));
    ws.addEventListener('close', (ev) => this._handleClose(ev));
    ws.addEventListener('error', () => this._handleError());
  }

  _handleMessage(ev) {
    const ws = this.socket;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // a malformed frame is the server's problem, not a crash here
    }
    const settle = this._connectSettle;
    switch (msg.t) {
      case 'welcome':
        // A server that predates PROTOCOL_VERSION never rejects the query
        // param this client sent (it doesn't know to look for one) and
        // proceeds straight to a welcome with no `protocolVersion` field
        // at all — `undefined !== 1` catches that case exactly like a
        // numeric mismatch does. Caught here, before anything about the
        // match is trusted, rather than desyncing on whatever wire shape
        // the two builds disagree about.
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          const err = new Error(
            versionMismatchMessage({ serverVersion: msg.protocolVersion, clientVersion: PROTOCOL_VERSION })
          );
          err.code = 'protocol_version_mismatch';
          ws.close(4010, 'protocol version mismatch');
          if (settle && !settle.settled) { settle.settled = true; settle.reject(err); }
          return;
        }
        this.info = msg;
        this._everConnected = true;
        this._reconnectAttempt = 0; // a fresh welcome means the reconnect, if any, worked
        // Fires again on every reconnect, not just the first connection —
        // `onWelcome` handlers must be safe to call more than once (see
        // main.js's, which only refreshes `match.releasedTurn`).
        this.handlers.onWelcome?.(msg);
        if (settle && !settle.settled) { settle.settled = true; settle.resolve(msg); }
        return;
      case 'begin':
        // The roster is complete. Until this lands the client must not
        // report input — see the start barrier in server/src/ws/match.js.
        // `resuming` marks the copy sent directly to a socket that joined
        // an already-running match, which must resync rather than start
        // simulating from turn 0 — the same frame a mid-match reconnect
        // receives, which is what makes reconnecting resume play instead of
        // just quietly re-opening a socket nothing then uses.
        return void this.handlers.onBegin?.(msg);
      case 'waiting':
        // The roster is still short and the wait has gone on long enough to
        // be worth naming. Repeats every few seconds until it resolves.
        return void this.handlers.onWaiting?.(msg);
      case 'turn':
        return void this.handlers.onTurn?.(msg.turn, msg.inputs);
      case 'agreed':
        // A positive verdict from a real comparison — distinct from the
        // server merely not having complained.
        return void this.handlers.onAgreed?.(msg);
      case 'desync':
        return void this.handlers.onDesync?.(msg);
      case 'snapshot':
        return void this.handlers.onSnapshot?.(msg);
      case 'playerJoined':
        return void this.handlers.onPlayerJoined?.(msg);
      case 'playerLeft':
        return void this.handlers.onPlayerLeft?.(msg);
      case 'activeVehicle':
        // Presence, not sim state — see server/src/ws/match.js's own case
        // for why this rides outside the turn/lockstep system entirely.
        return void this.handlers.onActiveVehicle?.(msg);
      case 'pong':
        // Diagnostic only: confirms this socket's inbound leg is actually
        // alive, not just the outbound ping that keeps the server's
        // reaper from firing. A ping that keeps sending while no pong
        // ever comes back is a half-open socket the server can't see.
        this.lastPongAt = Date.now();
        return;
      case 'resyncNeeded':
        // The host's own cue that some other player just rejoined stale or
        // empty — the same signal a hash mismatch produces, on a different
        // trigger. Handled identically: schedule a snapshot at a turn the
        // host can promise to reach.
        return void this.handlers.onResyncNeeded?.(msg);
      case 'error':
        // An error before the welcome means we never got in at all — reject
        // rather than leave the caller waiting on a connection that failed.
        // `protocol_version_mismatch` gets a message worth showing a
        // player instead of the bare error code the others fall back to —
        // the server rejected the query param before this client got far
        // enough to have a `welcome` to compare against on its own.
        if (settle && !settle.settled) {
          settle.settled = true;
          settle.reject(new Error(
            msg.error === 'protocol_version_mismatch'
              ? versionMismatchMessage(msg)
              : msg.error
          ));
        }
        // The full frame, not just the string — `turn_already_released`
        // carries the turn that was rejected, and a handler needs it to
        // tell "stale input, ignorable" from "this session can never
        // rejoin the turn stream" (see onError in main.js).
        return void this.handlers.onError?.(msg);
      default:
        return;
    }
  }

  _handleClose(ev) {
    this.connected = false;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    console.log(
      `[matchClient] socket closed: code=${ev.code} reason=${ev.reason || '(none)'} ` +
      `wasClean=${ev.wasClean} lastPongAt=${this.lastPongAt ?? '(never)'}`
    );

    const settle = this._connectSettle;
    if (settle && !settle.settled) {
      // The very first connection never got as far as a welcome — a
      // handshake failure (wrong URL, server down, proxy not forwarding the
      // upgrade), not a mid-match drop. Nothing about retrying silently would
      // fix that; report it the way `connect()`'s caller already expects.
      settle.settled = true;
      settle.reject(new Error(`socket closed: ${ev.code}`));
      return;
    }

    // Reported live in production: two real players' sockets, both already
    // past `agreed`, closing with code 1006 (abnormal — no close frame, the
    // connection itself was cut) within seconds of each other. That is
    // exactly the shape of a transient network or proxy hiccup, and it used
    // to be fatal instantly — `onClose` fired immediately and ended the
    // match with no attempt to get back in. `wasClean`/`TERMINAL_CLOSE_CODES`
    // are what keep this from retrying a close that was never going to
    // resolve differently: the server's own deliberate codes, and a normal
    // page-driven close (1000/1001, both "clean").
    const retryable =
      this._everConnected &&
      !ev.wasClean &&
      !TERMINAL_CLOSE_CODES.has(ev.code) &&
      this._reconnectAttempt < RECONNECT_ATTEMPTS;

    if (retryable) {
      this._reconnectAttempt++;
      const delay = RECONNECT_BASE_DELAY_MS * this._reconnectAttempt;
      console.log(
        `[matchClient] abnormal close (code=${ev.code}); reconnect attempt ` +
        `${this._reconnectAttempt}/${RECONNECT_ATTEMPTS} in ${delay}ms`
      );
      this._reconnectTimer = setTimeout(() => this._openSocket(), delay);
      return;
    }

    this.handlers.onClose?.(ev);
  }

  _handleError() {
    // The browser deliberately does not expose the HTTP status of a failed
    // handshake, so this is all we can ever know locally — say what it
    // usually means rather than the bare "socket error" the event gives us.
    console.log('[matchClient] socket error event fired');
    const settle = this._connectSettle;
    if (settle && !settle.settled) {
      settle.settled = true;
      settle.reject(new Error(
        'the server refused the WebSocket connection (it may be down, or a ' +
        'proxy in front of it may not be forwarding WebSocket upgrades)'
      ));
    }
    // Past the first connection, `error` carries nothing `close` doesn't
    // also fire — the retry/give-up decision lives entirely in
    // `_handleClose`, which always follows.
  }

  _send(msg) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  /** Report this client's input for a turn. */
  sendInput(turn, inputs) {
    this._send({ t: 'input', turn, inputs });
  }

  /** Report a state digest so the server can spot a divergence. */
  sendHash(turn, hash) {
    this._send({ t: 'hash', turn, hash });
  }

  /** Host only: hand a full snapshot to a client that has diverged. */
  sendSnapshot(toUserId, turn, payload) {
    this._send({ t: 'snapshot', toUserId, turn, payload });
  }

  /**
   * Tell peers which vehicle this client is currently piloting, or `null`
   * when nothing is (e.g. between deaths). Presence info for
   * headlightPool.js's real-light candidate list, not sim state — see
   * server/src/ws/match.js's `activeVehicle` case for why it never touches
   * the turn/lockstep system.
   */
  sendActiveVehicle(vehicleId) {
    this._send({ t: 'activeVehicle', vehicleId });
  }

  close() {
    // Without this, a reconnect scheduled just before a deliberate close
    // (the player quitting, `endOnlineMatch` reloading) would still fire —
    // opening a brand new socket on a page already on its way out.
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }
}
