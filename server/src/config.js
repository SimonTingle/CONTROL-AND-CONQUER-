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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // 0.0.0.0 rather than localhost: inside a container, binding to the loopback
  // interface makes the service unreachable from outside it.
  host: process.env.HOST ?? '0.0.0.0',

  databaseUrl: required('DATABASE_URL'),

  // Where the built frontend is served from. CORS has to name it explicitly
  // (not '*') because the session cookie is sent with credentials, and
  // browsers refuse wildcard origins on credentialed requests.
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',

  // Session cookies are Secure in production, but a plain-HTTP localhost dev
  // server would then never receive them back.
  isProduction: process.env.NODE_ENV === 'production',

  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),

  // 'lax' is right for the normal CapRover layout, where the frontend and the
  // API are subdomains of one registrable domain and so count as same-site.
  // Only a genuinely cross-site deploy needs 'none', which also requires
  // Secure (and therefore HTTPS) or browsers will drop the cookie entirely.
  cookieSameSite: process.env.COOKIE_SAMESITE ?? 'lax',

  // Deliberately NOT required() — the server must still boot (and every
  // other feature must still work) with no email provider configured, the
  // same "optional, degrades" rule the frontend's api.isConfigured already
  // follows for the backend as a whole. /auth/forgot-password checks this
  // itself and logs a clear warning rather than silently pretending to send.
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  // Resend's shared sending domain — works with no DNS/domain verification,
  // the right default to get password reset working before anyone has set
  // up a verified sending domain. Override once one exists.
  emailFrom: process.env.EMAIL_FROM ?? 'Procedural Terrain <onboarding@resend.dev>',

  // Where the reset link points — the same origin CORS is already locked to,
  // since that origin *is* the frontend serving the page that reads the
  // token out of the URL.
  frontendUrl: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
};
