/**
 * Admin recovery: mint a password-reset link for an account and print it.
 *
 *   npm run reset-link -- someone@example.com
 *
 * Exists because password reset is the only way back into an account, and it
 * depends on email actually being deliverable — which it is not until a domain
 * is verified with the mail provider (an unverified Resend account can only
 * send to its own owner, and refuses everything else with a 403 the caller
 * never sees). Without this, a misconfigured sender means a locked-out account
 * with no recourse at all.
 *
 * Deliberately mints a *link* rather than setting a password directly:
 *
 *   - it reuses createPasswordReset(), which already returns the raw token
 *     exactly once by design, instead of duplicating password hashing here;
 *   - no password ever lands in shell history or the process list;
 *   - it keeps working after 005_hash_tokens.sql, where reading a usable token
 *     back out of the database stops being possible — which is precisely the
 *     situation this script is for.
 *
 * The printed link is a bearer credential with the same 30-minute, single-use
 * lifetime as an emailed one. Treat it like the email it stands in for.
 */

import { pool, query } from '../db/pool.js';
import { createPasswordReset } from '../auth/passwordResets.js';
import { config } from '../config.js';

export async function resetLinkFor(email) {
  const { rows } = await query('select id, email from users where email = $1', [email]);
  const user = rows[0];
  // Unlike /auth/forgot-password, this says plainly whether the account
  // exists. That endpoint stays uniform to deny an anonymous caller an
  // enumeration oracle; whoever is running this already holds the database
  // credentials, so there is nothing left to withhold — and silently printing
  // nothing for a typo'd address would be its own kind of failure.
  if (!user) throw new Error(`No account found for ${email}`);

  const reset = await createPasswordReset(user.id);
  return {
    email: user.email,
    url: `${config.frontendUrl}/?resetToken=${reset.token}`,
    expiresAt: reset.expires_at,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.argv[2]?.trim();
  if (!email) {
    console.error('Usage: npm run reset-link -- <email>');
    process.exit(1);
  }

  resetLinkFor(email)
    .then(async ({ url, expiresAt }) => {
      console.log(`\n${url}\n`);
      console.log(`Expires ${new Date(expiresAt).toISOString()} — single use.\n`);
      await pool.end();
    })
    .catch(async (err) => {
      console.error(err.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
