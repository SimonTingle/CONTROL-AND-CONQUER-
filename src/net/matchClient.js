/**
 * WebSocket transport for a lockstep match.
 *
 * Deliberately thin: it owns the socket and the message vocabulary, and hands
 * everything else to callbacks. The turn logic lives in lockstep.js and the
 * simulation knows nothing about either — which is what lets the lockstep rules
 * be reasoned about (and tested) without a socket in the picture.
 */

/** Same origin the REST client uses; baked in at build time by Vite. */
const API_BASE = typeof __API_URL__ === 'string' ? __API_URL__ : '';

function socketUrl(matchId) {
  // The session cookie rides the upgrade request, so the socket must go to the
  // same origin the cookie was set for — hence deriving it from the API base
  // rather than from location.
  const base = API_BASE || `${location.protocol}//${location.host}`;
  return `${base.replace(/^http/, 'ws')}/ws/match/${matchId}`;
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
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(socketUrl(this.matchId));
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
          case 'resyncNeeded':
            // The host's own cue that some other player just rejoined stale or
            // empty — the same signal a hash mismatch produces, on a different
            // trigger. Handled identically: schedule a snapshot at a turn the
            // host can promise to reach.
            return void this.handlers.onResyncNeeded?.(msg);
          case 'error':
            // An error before the welcome means we never got in at all — reject
            // rather than leave the caller waiting on a connection that failed.
            if (!settled) { settled = true; reject(new Error(msg.error)); }
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
        if (!settled) { settled = true; reject(new Error(`socket closed: ${ev.code}`)); }
        this.handlers.onClose?.(ev);
      });

      ws.addEventListener('error', () => {
        // The browser deliberately does not expose the HTTP status of a failed
        // handshake, so this is all we can ever know locally — say what it
        // usually means rather than the bare "socket error" the event gives us.
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
