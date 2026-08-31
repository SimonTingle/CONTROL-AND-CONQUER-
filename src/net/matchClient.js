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
export const PROTOCOL_VERSION = 4;

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
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
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

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return; // a malformed frame is the server's problem, not a crash here
        }
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
              if (!settled) { settled = true; reject(err); }
              return;
            }
            this.info = msg;
            this.handlers.onWelcome?.(msg);
            if (!settled) { settled = true; resolve(msg); }
            return;
          case 'begin':
            // The roster is complete. Until this lands the client must not
            // report input — see the start barrier in server/src/ws/match.js.
            // `resuming` marks the copy sent directly to a socket that joined
            // an already-running match, which must resync rather than start
            // simulating from turn 0.
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
            if (!settled) {
              settled = true;
              reject(new Error(
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
      });

      ws.addEventListener('close', (ev) => {
        this.connected = false;
        clearInterval(this.heartbeat);
        this.heartbeat = null;
        console.log(
          `[matchClient] socket closed: code=${ev.code} reason=${ev.reason || '(none)'} ` +
          `wasClean=${ev.wasClean} lastPongAt=${this.lastPongAt ?? '(never)'}`
        );
        if (!settled) { settled = true; reject(new Error(`socket closed: ${ev.code}`)); }
        this.handlers.onClose?.(ev);
      });

      ws.addEventListener('error', () => {
        // The browser deliberately does not expose the HTTP status of a failed
        // handshake, so this is all we can ever know locally — say what it
        // usually means rather than the bare "socket error" the event gives us.
        console.log('[matchClient] socket error event fired');
        if (!settled) {
          settled = true;
          reject(new Error(
            'the server refused the WebSocket connection (it may be down, or a ' +
            'proxy in front of it may not be forwarding WebSocket upgrades)'
          ));
        }
      });
    });
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

  close() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }
}
