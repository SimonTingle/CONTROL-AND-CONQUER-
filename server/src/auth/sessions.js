/**
 * Server-side sessions.
 *
 * See 001_accounts.sql for why these are database rows rather than JWTs. The
 * token is the row's primary key — an opaque uuid v4, which carries no
 * information and cannot be forged without guessing 122 bits of randomness.
 */

import { query } from '../db/pool.js';
import { config } from '../config.js';

export const SESSION_COOKIE = 'ptg_session';

export async function createSession(userId) {
  const { rows } = await query(
    `insert into sessions (user_id, expires_at)
     values ($1, now() + ($2 || ' days')::interval)
     returning token, expires_at`,
    [userId, config.sessionTtlDays]
  );
  return rows[0];
}

/**
 * The user behind a session token, or null.
 *
 * Expiry and revocation are checked in SQL rather than in JS so there is no
 * window where the row is read, judged valid, and then acted on — and so a
 * caller cannot forget to check.
 */
export async function userForToken(token) {
  if (!token) return null;

  // A malformed token would make Postgres throw a type error on the uuid cast
  // rather than simply not matching, so screen it first.
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;

  const { rows } = await query(
    `select u.id, u.email, u.display_name, u.created_at
       from sessions s
       join users u on u.id = s.user_id
      where s.token = $1
        and s.revoked_at is null
        and s.expires_at > now()`,
    [token]
  );
  return rows[0] ?? null;
}

export async function revokeSession(token) {
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return;
  await query(
    `update sessions set revoked_at = now()
      where token = $1 and revoked_at is null`,
    [token]
  );
}

/** Cookie attributes, shared by login (set) and logout (clear) so they cannot drift apart. */
export function sessionCookieOptions() {
  return {
    httpOnly: true, // page JS cannot read it, so an XSS bug cannot exfiltrate the session
    secure: config.isProduction, // a plain-HTTP localhost dev server would never get a Secure cookie back
    // 'lax' covers the normal CapRover layout, where the frontend and API are
    // subdomains of one registrable domain and therefore same-site. A genuinely
    // cross-site deploy would need 'none' + Secure.
    sameSite: config.cookieSameSite,
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
  };
}
