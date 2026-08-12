/**
 * Password reset tokens. Same shape and reasoning as sessions.js's tokens —
 * see 003_password_resets.sql and 005_hash_tokens.sql.
 */

import { query, transaction } from '../db/pool.js';
import { newToken, hashToken, isWellFormedToken } from './tokens.js';

const RESET_TTL_MINUTES = 30; // short-lived on purpose: a reset link is a bearer credential mailed in plaintext

export async function createPasswordReset(userId) {
  const { token, hash } = newToken();
  const { rows } = await query(
    `insert into password_resets (user_id, token_hash, expires_at)
     values ($1, $2, now() + ($3 || ' minutes')::interval)
     returning expires_at`,
    [userId, hash, RESET_TTL_MINUTES]
  );
  return { token, expires_at: rows[0].expires_at };
}

/**
 * The user a reset token is valid for, or null. Checked in SQL — same
 * reasoning as sessions.js's userForToken — so there's no window between
 * "read the row" and "act on it" where a second request could race a consume.
 */
export async function userForResetToken(token) {
  if (!isWellFormedToken(token)) return null;

  const { rows } = await query(
    `select u.id, u.email, u.display_name
       from password_resets r
       join users u on u.id = r.user_id
      where r.token_hash = $1
        and r.used_at is null
        and r.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] ?? null;
}

/**
 * Marks the token used, sets the new password hash, and revokes every
 * existing session for the account — all in one transaction. Resetting a
 * password is a strong signal the old credential (and anything authenticated
 * with it) should no longer be trusted; a session that survived the reset
 * would defeat the point of resetting in the first place.
 *
 * Returns false (does nothing) if the token was already invalid — checked
 * again inside the transaction, not just by the caller, so a token consumed
 * a moment ago by a concurrent request can't be spent twice.
 */
export async function consumePasswordReset(token, userId, newPasswordHash) {
  return transaction(async (client) => {
    const { rowCount } = await client.query(
      `update password_resets set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()`,
      [hashToken(token)]
    );
    if (rowCount === 0) return false;

    await client.query('update users set password_hash = $1 where id = $2', [
      newPasswordHash,
      userId,
    ]);
    await client.query(
      `update sessions set revoked_at = now()
        where user_id = $1 and revoked_at is null`,
      [userId]
    );
    return true;
  });
}
