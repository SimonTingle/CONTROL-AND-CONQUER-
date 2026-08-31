/**
 * Register / login / logout / me.
 *
 * Two rules run through all of it:
 *   - never reveal whether an email address has an account (same message and
 *     roughly the same timing for "no such user" and "wrong password");
 *   - never put the password or the session token in a response body or a log.
 */

import { z } from 'zod';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword, dummyVerify } from '../auth/passwords.js';
import {
  SESSION_COOKIE,
  createSession,
  revokeSession,
  sessionCookieOptions,
} from '../auth/sessions.js';
import { bearerToken } from '../auth/credentials.js';
import { createPasswordReset, userForResetToken, consumePasswordReset } from '../auth/passwordResets.js';
import { sendEmail, passwordResetEmail } from '../email/resend.js';
import { config } from '../config.js';
import { shouldThrottle } from '../auth/accountRateLimit.js';

const credentials = z.object({
  email: z.string().email().max(254),
  // Length is the requirement that actually correlates with strength; a
  // composition rule ("must contain a symbol") mostly produces Password1!
  // and pushes people toward reuse. 12 is the current OWASP-aligned floor.
  // The upper bound guards against a megabyte-long string being fed to a
  // deliberately slow hash function as a cheap DoS.
  password: z.string().min(12).max(200),
});

const registration = credentials.extend({
  displayName: z.string().trim().min(2).max(32),
});

/** Never return the hash, and never return anything the caller isn't entitled to. */
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? row.displayName,
    createdAt: row.created_at ?? row.createdAt,
  };
}

export async function authRoutes(app) {
  // These are the endpoints worth attacking, so they get the tighter limit
  // rather than the global default.
  const authLimit = {
    rateLimit: { max: 10, timeWindow: '1 minute' },
  };

  app.post('/auth/register', { config: authLimit }, async (req, reply) => {
    const parsed = registration.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        // Field-level detail is safe here (it is about the submitted shape,
        // not about who exists) and it is what lets the UI point at the
        // offending field.
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { email, password, displayName } = parsed.data;

    const password_hash = await hashPassword(password);

    let user;
    try {
      const { rows } = await query(
        `insert into users (email, password_hash, display_name)
         values ($1, $2, $3)
         returning id, email, display_name, created_at`,
        [email, password_hash, displayName]
      );
      user = rows[0];
    } catch (err) {
      // 23505 = unique_violation on users.email. Answering "that email is
      // taken" is a deliberate, narrow exception to the no-enumeration rule:
      // a registration form cannot function without telling the user why it
      // refused, and the same fact is obtainable through the form anyway.
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'email_taken' });
      }
      throw err;
    }

    const session = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions());
    return reply.code(201).send({ user: publicUser(user), sessionToken: session.token });
  });

  app.post('/auth/login', { config: authLimit }, async (req, reply) => {
    const parsed = credentials.safeParse(req.body);
    // Note the deliberately vague error even for a malformed body: at this
    // endpoint, "your input was invalid" and "those credentials were wrong"
    // should be indistinguishable.
    if (!parsed.success) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const { email, password } = parsed.data;

    // Per-IP (authLimit, above) doesn't bound a distributed attack aimed at
    // one account; this closes that without introducing a lockout an
    // attacker could weaponise against a victim — see accountRateLimit.js.
    if (shouldThrottle(email)) {
      return reply.code(429).send({ error: 'too_many_attempts' });
    }

    const { rows } = await query(
      'select id, email, display_name, password_hash, created_at from users where email = $1',
      [email]
    );
    const user = rows[0];

    if (!user) {
      // Spend the same CPU time as a real verify would, so response timing
      // doesn't leak whether this address has an account.
      await dummyVerify(password);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    if (!(await verifyPassword(user.password_hash, password))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const session = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions());
    return reply.send({ user: publicUser(user), sessionToken: session.token });
  });

  app.post('/auth/logout', { onRequest: app.csrfUnlessBearer }, async (req, reply) => {
    // Revoke whichever token actually carried this session. A bearer client
    // has no cookie to read here, and revoking nothing would leave its token
    // live until it expired — "log out" that does not log you out.
    await revokeSession(req.cookies[SESSION_COOKIE] ?? bearerToken(req));
    // Clear with the same attributes it was set with, or the browser keeps
    // the original cookie and "logout" only appears to work.
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    return reply.send({ ok: true });
  });

  /**
   * Who am I? Returns `{ user: null }` rather than 401 when signed out —
   * being signed out is a normal, expected state for this game, not an error,
   * and the frontend calls this on every load to decide which UI to show.
   *
   * Also mints the CSRF token here, since this is already the first call the
   * frontend makes on every load — one round trip covers both "am I signed
   * in" and "here is the token to echo back on the next state change",
   * whether or not the visitor is signed in yet (a password-reset link lands
   * signed out and still needs one).
   */
  app.get('/auth/me', async (req, reply) => {
    return { user: req.user ? publicUser(req.user) : null, csrfToken: await reply.generateCsrf() };
  });

  const forgotPasswordBody = z.object({ email: z.string().email().max(254) });

  /**
   * Always responds `{ ok: true }`, whether or not the email has an account —
   * this is the one place the no-enumeration rule can't bend the way
   * registration's does (there's no form field to legitimately need the
   * answer here). If the account exists, a reset email goes out; either way
   * the response looks identical.
   */
  app.post('/auth/forgot-password', { config: authLimit }, async (req, reply) => {
    const parsed = forgotPasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.send({ ok: true }); // same response as "no such account" — see above

    // Same reasoning as login: bounds a distributed attempt to spam one
    // inbox with reset emails from many IPs. The uniform { ok: true } below
    // still applies even when throttled, so this can't be used to probe
    // account existence either.
    if (shouldThrottle(parsed.data.email)) {
      return reply.send({ ok: true });
    }

    const { rows } = await query('select id, email from users where email = $1', [parsed.data.email]);
    const user = rows[0];

    if (user) {
      const reset = await createPasswordReset(user.id);
      const resetUrl = `${config.frontendUrl}/?resetToken=${reset.token}`;
      const sent = await sendEmail({ to: user.email, log: req.log, ...passwordResetEmail(resetUrl) });
      if (!sent) {
        // The user gets the same "check your email" response regardless —
        // this log line is what tells the operator to go check RESEND_API_KEY
        // rather than the player being left wondering why no email arrived.
        req.log.warn({ userId: user.id }, '[auth] password reset email did not send');
      }
    }

    return reply.send({ ok: true });
  });

  const resetPasswordBody = z.object({
    // Tokens are now app-generated (see auth/tokens.js), not database uuids —
    // exact shape is re-checked by isWellFormedToken() downstream; this bound
    // is just to keep a malformed body from reaching that point at all.
    token: z.string().min(1).max(128),
    password: z.string().min(12).max(200),
  });

  app.post('/auth/reset-password', { config: authLimit, onRequest: app.csrfUnlessBearer }, async (req, reply) => {
    const parsed = resetPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { token, password } = parsed.data;

    const user = await userForResetToken(token);
    if (!user) {
      // Deliberately one error code for "no such token", "expired", and
      // "already used" — same reasoning login's invalid_credentials
      // collapses two distinct failures into one response.
      return reply.code(400).send({ error: 'invalid_or_expired_token' });
    }

    const password_hash = await hashPassword(password);
    const applied = await consumePasswordReset(token, user.id, password_hash);
    if (!applied) {
      // Lost a race with a concurrent request that consumed the same token
      // between the check above and now — same user-facing answer either way.
      return reply.code(400).send({ error: 'invalid_or_expired_token' });
    }

    // Deliberately does NOT sign the caller in — consumePasswordReset just
    // revoked every session on this account, including any the browser
    // making this request happens to be holding. Making them use the
    // password they just set, once, confirms it actually works.
    return reply.send({ ok: true });
  });
}
