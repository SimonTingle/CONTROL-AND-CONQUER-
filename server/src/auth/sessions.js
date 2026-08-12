/**
 * Server-side sessions.
 *
 * See 001_accounts.sql for why these are database rows rather than JWTs, and
 * 005_hash_tokens.sql for why the database stores a hash of the token rather
 * than the token itself — the raw token lives only in the cookie and briefly
 * in memory per request, never in a row a database read could expose.
 */

import { query } from '../db/pool.js';
import { config } from '../config.js';
import { newToken, hashToken, isWellFormedToken } from './tokens.js';

export const SESSION_COOKIE = 'ptg_session';

export async function createSession(userId) {
  const { token, hash } = newToken();
  const { rows } = await query(
    `insert into sessions (user_id, token_hash, expires_at)
     values ($1, $2, now() + ($3 || ' days')::interval)
     returning expires_at`,
    [userId, hash, config.sessionTtlDays]
  );
  return { token, expires_at: rows[0].expires_at };
}

/**
 * The user behind a session token, or null.
 *
 * Expiry and revocation are checked in SQL rather than in JS so there is no
 * window where the row is read, judged valid, and then acted on — and so a
 * caller cannot forget to check.
 */
export async function userForToken(token) {
  if (!isWellFormedToken(token)) return null;

  const { rows } = await query(
    `select u.id, u.email, u.display_name, u.created_at
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] ?? null;
}

export async function revokeSession(token) {
  if (!isWellFormedToken(token)) return;
  await query(
    `update sessions set revoked_at = now()
      where token_hash = $1 and revoked_at is null`,
    [hashToken(token)]
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
