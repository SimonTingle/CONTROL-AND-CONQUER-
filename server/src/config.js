/**
 * Every environment knob in one place, read once at boot.
 *
 * Deliberately fails loudly at startup for anything that has no safe default —
 * a server that boots with a missing DATABASE_URL and only discovers it on the
 * first request is much harder to diagnose than one that refuses to start.
 */

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `See server/.env.example for the full list.`
    );
  }
  return value;
}

// What @fastify/cookie actually accepts for sameSite. Validated at startup
// rather than passed straight through, so a typo in the env (COOKIE_SAMESITE
// is free-form, operator-supplied text) fails loudly at boot instead of
// producing silent, UA-dependent cookie behaviour discovered later as "why is
// nobody staying signed in".
const SAME_SITE_VALUES = ['lax', 'strict', 'none'];

function cookieSameSite() {
  const value = process.env.COOKIE_SAMESITE ?? 'lax';
  if (!SAME_SITE_VALUES.includes(value)) {
    throw new Error(
      `Invalid COOKIE_SAMESITE "${value}". Must be one of: ${SAME_SITE_VALUES.join(', ')}.`
    );
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';
const sameSite = cookieSameSite();

// CORS_ORIGIN is a comma-separated list so a second legitimate frontend (e.g.
// an itch.io build, served from a fixed but entirely different origin) can be
// allow-listed alongside the main site. A single origin with no comma still
// works exactly as before. The password-reset link always uses the first
// entry — a reset link should point at the canonical site, not whichever
// origin happens to be listed second.
const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Resend's shared sandbox sender. Needs no DNS setup at all, which makes it the
// right default for a first run — but it can only ever deliver to the address
// that owns the Resend account. Every other recipient is refused with a 403
// that, by design, never reaches the caller (/auth/forgot-password always
// answers { ok: true } so it can't be used to enumerate accounts). index.js
// warns at boot when this is still in use with a live API key.
const SANDBOX_EMAIL_FROM = 'Procedural Terrain <onboarding@resend.dev>';
const emailFrom = process.env.EMAIL_FROM ?? SANDBOX_EMAIL_FROM;

// SameSite=None without Secure is rejected outright by every modern browser —
// the cookie would simply never arrive, silently. isProduction is what gates
// Secure (see below), so this configuration can never work and should never
// be allowed to boot looking like it does.
if (sameSite === 'none' && !isProduction) {
  throw new Error(
    'COOKIE_SAMESITE=none requires a Secure cookie, which only happens when ' +
      'NODE_ENV=production. Browsers silently drop SameSite=None cookies that ' +
      "aren't also Secure, so this combination would boot but never actually " +
      'keep anyone signed in.'
  );
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // 0.0.0.0 rather than localhost: inside a container, binding to the loopback
  // interface makes the service unreachable from outside it.
  host: process.env.HOST ?? '0.0.0.0',

  databaseUrl: required('DATABASE_URL'),

  // Where the built frontend(s) are served from. CORS has to name each one
  // explicitly (not '*') because the session cookie is sent with credentials,
  // and browsers refuse wildcard origins on credentialed requests.
  corsOrigin: corsOrigins,

  // Session cookies are Secure in production, but a plain-HTTP localhost dev
  // server would then never receive them back.
  isProduction,

  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),

  // 'lax' is right for the normal CapRover layout, where the frontend and the
  // API are subdomains of one registrable domain and so count as same-site.
  // Only a genuinely cross-site deploy needs 'none', which also requires
  // Secure (and therefore HTTPS) or browsers will drop the cookie entirely —
  // validated above, at boot.
  cookieSameSite: sameSite,

  // Deliberately NOT required() — the server must still boot (and every
  // other feature must still work) with no email provider configured, the
  // same "optional, degrades" rule the frontend's api.isConfigured already
  // follows for the backend as a whole. /auth/forgot-password checks this
  // itself and logs a clear warning rather than silently pretending to send.
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  // Defaults to the sandbox sender described above; override once a real
  // sending domain is verified in Resend.
  emailFrom,
  // Substring rather than an exact match against SANDBOX_EMAIL_FROM: any
  // resend.dev address carries the same one-recipient restriction, not just
  // the particular default spelling above.
  usingSandboxSender: emailFrom.includes('resend.dev'),

  // Where the reset link points — the first CORS origin, since that's the
  // canonical frontend serving the page that reads the token out of the URL.
  // A second, alternate-distribution origin (see corsOrigins above) is never
  // the right target for a password-reset email.
  frontendUrl: corsOrigins[0],
};
