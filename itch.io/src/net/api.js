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
  return payload;
}

export const api = {
  isConfigured,

  register: (email, password, displayName) =>
    request('/auth/register', { method: 'POST', body: { email, password, displayName } }),

  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: { email, password } }),

  logout: () => request('/auth/logout', { method: 'POST' }),

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
