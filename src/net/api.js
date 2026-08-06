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

async function request(path, { method = 'GET', body } = {}) {
  if (!isConfigured) {
    throw new ApiError(0, 'no_backend_configured');
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      // The session lives in an httpOnly cookie, which is only sent when
      // credentials are explicitly included on a cross-origin request.
      credentials: 'include',
      headers: body ? { 'content-type': 'application/json' } : undefined,
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
  return payload;
}

export const api = {
  isConfigured,

  register: (email, password, displayName) =>
    request('/auth/register', { method: 'POST', body: { email, password, displayName } }),

  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: { email, password } }),

  logout: () => request('/auth/logout', { method: 'POST' }),

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
  listSaves: () => request('/saves').then((r) => r.saves),
  getSave: (id) => request(`/saves/${id}`).then((r) => r.save),
  putSave: (name, mode, schemaVersion, payload) =>
    request('/saves', { method: 'POST', body: { name, mode, schemaVersion, payload } }),
  deleteSave: (id) => request(`/saves/${id}`, { method: 'DELETE' }),
};
