/**
 * Thin client for the API server (accounts, cloud saves, and later the match
 * relay).
 *
 * The governing rule: **the game must work with no backend at all.** Sandbox
 * and Multiplayer-AI are the modes people actually play today, and neither
 * needs a server. So `__API_URL__` defaults to empty (see vite.config.js),
 * `isConfigured` is false, and every call here fails soft rather than throwing
 * something the caller has to defend against. Callers check `isConfigured`
 * and fall back to local behaviour.
 */

const BASE = __API_URL__;

/** False when this build has no API server — cloud features hide themselves. */
export const isConfigured = Boolean(BASE);

/**
 * Carry the session as a bearer token instead of a cookie.
 *
 * Off for the main site, which is same-site with the API and keeps its session
 * in an httpOnly cookie page JS cannot read — strictly the safer arrangement,
 * and there is no reason to give that up where cookies work.
 *
 * On for the itch.io build, which browsers serve from a third-party iframe on
 * an entirely different registrable domain. Safari's ITP blocks that cookie
 * outright and Chrome is phasing third-party cookies out the same way;
 * `SameSite=None` does not exempt it. There the cookie is silently dropped,
 * every request after sign-in looks anonymous, and a token the page holds
 * itself is the only thing that survives.
 *
 * The cost is real and worth naming: this token lives in localStorage, so page
 * JS can read it and an XSS bug could exfiltrate it — exactly what httpOnly
 * prevents. That is why this is opt-in per build rather than on everywhere.
 */
// `typeof` guarded like matchClient.js's __API_URL__: these are Vite
// build-time globals, and a plain-Node test importing this module has no
// define step to supply them.
const USE_BEARER_AUTH = typeof __USE_BEARER_AUTH__ !== 'undefined' && __USE_BEARER_AUTH__;

const TOKEN_KEY = 'ptg_session_token';

/** Wrapped: Safari in private mode throws on localStorage access rather than failing soft. */
function readStoredToken() {
  if (!USE_BEARER_AUTH) return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token) {
  if (!USE_BEARER_AUTH) return;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode, storage disabled). The session then
    // lasts only as long as the page, which is worse than persisting but far
    // better than throwing on every request.
  }
}

let sessionToken = readStoredToken();

/**
 * The session token, for transports that cannot send an Authorization header.
 * Null unless this build uses bearer auth and somebody is signed in.
 * @see src/net/matchClient.js, which passes it as a WebSocket subprotocol.
 */
export function getSessionToken() {
  return sessionToken;
}

/** Thrown for a request the server refused, carrying the machine-readable code. */
export class ApiError extends Error {
  constructor(status, code, details) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// The server mints this on /auth/me (see routes/auth.js) — one token, cached
// for the page's lifetime and echoed back on every state-changing request.
// It's derived from a secret the server holds in its own httpOnly cookie, so
// this value is safe to keep in ordinary JS memory: on its own, without that
// cookie riding along, it authorises nothing.
let csrfToken = null;

async function request(path, { method = 'GET', body } = {}) {
  if (!isConfigured) {
    throw new ApiError(0, 'no_backend_configured');
  }

  const headers = body ? { 'content-type': 'application/json' } : {};
  // GET/HEAD are exempt server-side too (CSRF only threatens state changes);
  // sending the header on every request would work but this matches what the
  // server actually checks.
  if (csrfToken && method !== 'GET' && method !== 'HEAD') {
    headers['x-csrf-token'] = csrfToken;
  }
  // The server treats a bearer request as CSRF-immune and skips the token
  // check for it, which is what makes this work at all where the `_csrf`
  // cookie is dropped alongside the session one.
  if (sessionToken) {
    headers.authorization = `Bearer ${sessionToken}`;
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      // The session lives in an httpOnly cookie, which is only sent when
      // credentials are explicitly included on a cross-origin request.
      credentials: 'include',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Offline, DNS failure, CORS rejection — all indistinguishable from here,
    // and all mean the same thing to a caller: the server isn't reachable.
    throw new ApiError(0, 'network_unreachable', { cause: String(err) });
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, payload?.error ?? 'request_failed', payload?.details);
  }
  if (payload?.csrfToken) csrfToken = payload.csrfToken;
  // Login and register both mint one. Ignored entirely unless this build uses
  // bearer auth, so the main site never puts a session token in storage.
  if (payload?.sessionToken && USE_BEARER_AUTH) {
    sessionToken = payload.sessionToken;
    writeStoredToken(sessionToken);
  }
  return payload;
}

export const api = {
  isConfigured,

  register: (email, password, displayName) =>
    request('/auth/register', { method: 'POST', body: { email, password, displayName } }),

  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: { email, password } }),

  // Drop the local token whatever the server said. A failed revoke leaves the
  // token live server-side until it expires, but keeping it here would leave
  // the player looking signed in with no way to clear it — and the next
  // request would 401 anyway once the revoke did land.
  logout: async () => {
    try {
      return await request('/auth/logout', { method: 'POST' });
    } finally {
      sessionToken = null;
      writeStoredToken(null);
    }
  },

  // Always resolves { ok: true } on the server's side regardless of whether
  // the email has an account — see server/src/routes/auth.js. Still surfaced
  // as a real request here (not hidden behind a fire-and-forget) so a
  // genuine network failure can tell the user to check their connection,
  // just never "does this email exist".
  forgotPassword: (email) => request('/auth/forgot-password', { method: 'POST', body: { email } }),

  resetPassword: (token, password) =>
    request('/auth/reset-password', { method: 'POST', body: { token, password } }),

  /**
   * The signed-in user, or null.
   *
   * Never throws for the ordinary cases — signed out, no backend configured,
   * server unreachable — because this runs on every page load and none of
   * those is an error worth interrupting the game for. It just means "play
   * signed out".
   */
  async me() {
    if (!isConfigured) return null;
    try {
      const { user } = await request('/auth/me');
      // A stored token that the server no longer honours (expired, revoked,
      // or minted by a since-reset database) would otherwise sit in storage
      // forever, re-sent on every request and rejected every time. This call
      // runs on every page load, so it is the natural place to notice.
      if (!user && sessionToken) {
        sessionToken = null;
        writeStoredToken(null);
      }
      return user;
    } catch {
      return null;
    }
  },

  // Cloud saves — each throws ApiError on failure; callers decide how to
  // surface that, since "no backend" and "not signed in" and "save too big"
  // all want different messages.
  // Multiplayer lobbies. The match itself runs over a websocket
  // (net/matchClient.js); these only get a player in and out of a lobby.
  listMatches: () => request('/matches').then((r) => r.matches),
  getMatch: (id) => request(`/matches/${id}`),
  createMatch: (body) => request('/matches', { method: 'POST', body }).then((r) => r.match),
  // No body: the server assigns the team, so there is nothing for a client to
  // ask for. Re-joining returns the seat already held rather than erroring.
  joinMatch: (id) => request(`/matches/${id}/join`, { method: 'POST' }),
  startMatch: (id) => request(`/matches/${id}/start`, { method: 'POST' }).then((r) => r.match),
  leaveMatch: (id) => request(`/matches/${id}/leave`, { method: 'POST' }),

  listSaves: () => request('/saves').then((r) => r.saves),
  getSave: (id) => request(`/saves/${id}`).then((r) => r.save),
  putSave: (name, mode, schemaVersion, payload) =>
    request('/saves', { method: 'POST', body: { name, mode, schemaVersion, payload } }),
  deleteSave: (id) => request(`/saves/${id}`, { method: 'DELETE' }),
};
