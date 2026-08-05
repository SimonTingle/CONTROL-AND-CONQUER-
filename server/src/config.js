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
};
