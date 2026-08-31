/**
 * API server for accounts, cloud saves, and (later) the match relay.
 *
 * Deployed as its own CapRover app, separate from the static frontend image —
 * the frontend stays a pure nginx-served build with no app server in it.
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import csrfProtection from '@fastify/csrf-protection';

import { config } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import authPlugin from './auth/plugin.js';
import { authRoutes } from './routes/auth.js';
import { saveRoutes } from './routes/saves.js';
import websocket from '@fastify/websocket';
import { matchRoutes } from './routes/matches.js';
import { matchSocket } from './ws/match.js';

export async function build() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Never let a password or session token reach the log.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password'],
    },
    trustProxy: true, // CapRover terminates TLS and proxies; without this every client IP reads as the proxy's
    // World snapshots are the largest thing this server accepts. Fastify's
    // default is 1 MiB, which is *below* the 8 MiB cap routes/saves.js declares
    // and enforces — so that cap was unreachable and an oversized save died as
    // an opaque FST_ERR_CTP_BODY_TOO_LARGE before the route ever ran. Set
    // slightly above the route's cap so the route stays the real policy and can
    // answer with its own clean 413 payload_too_large.
    bodyLimit: 9 * 1024 * 1024,
  });

  // A live API key plus the sandbox sender is the one combination that looks
  // like working email and isn't: Resend accepts the key, then refuses every
  // recipient except the account owner with a 403. Nothing downstream can say
  // so — /auth/forgot-password always answers { ok: true } on purpose, so the
  // browser cannot tell, and the rejection only ever surfaced as one line
  // buried in the request log. Say it once, loudly, at boot.
  if (config.resendApiKey && config.usingSandboxSender) {
    app.log.warn(
      `[email] EMAIL_FROM is still Resend's sandbox sender (${config.emailFrom}). ` +
        'Password reset mail can only reach the Resend account owner; every other ' +
        'recipient is rejected with a 403. Verify a domain at resend.com/domains ' +
        'and set EMAIL_FROM to an address on it.'
    );
  }

  await app.register(cors, {
    origin: (origin, callback) => {
      // If no origin header, allow it (same-origin requests don't send one).
      // If the origin is in the allow-list, allow it. Otherwise reject.
      if (!origin || config.corsOrigin.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS policy violation'));
      }
    },
    // The session cookie only travels on credentialed requests, which in turn
    // require a named origin rather than '*' (see config.corsOrigin).
    credentials: true,
    // The CSRF token this server issues has to be readable by the browser's
    // fetch() call so it can be echoed back as a header on the next request.
    exposedHeaders: ['x-csrf-token'],
  });

  // Standard response headers (X-Content-Type-Options, X-Frame-Options,
  // Referrer-Policy, HSTS once isProduction, etc). CSP is switched off: this
  // is a JSON API with no HTML to protect — the frontend that actually
  // renders a page is a separate nginx-served static build (see the header
  // comment above) — and a default CSP tuned for nothing in particular would
  // just be a header nobody reads and nothing enforces correctly.
  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cookie);

  // Double-submit CSRF protection: the server holds a secret in its own
  // httpOnly cookie and hands the frontend a derived token (see
  // routes/auth.js's /auth/me) to echo back as a header on state-changing
  // requests. Cookie attributes mirror the session cookie's — same reasoning,
  // same deploy modes (see sessionCookieOptions in auth/sessions.js) — so a
  // cross-site deploy that needs SameSite=None gets it here too rather than
  // silently keeping SameSite=Strict and having this cookie stop arriving.
  await app.register(csrfProtection, {
    cookieOpts: {
      path: '/',
      httpOnly: true,
      secure: config.isProduction,
      sameSite: config.cookieSameSite,
      maxAge: config.sessionTtlDays * 24 * 60 * 60,
    },
  });

  await app.register(rateLimit, {
    global: false, // opt in per route; the auth routes are what actually need it
    max: 100,
    timeWindow: '1 minute',
  });

  /**
   * Liveness: is the process up and serving?
   *
   * Deliberately does NOT check the database. This is the endpoint an
   * orchestrator polls, and coupling it to a dependency means a brief database
   * blip gets escalated into "kill and recreate the container" — which is how
   * you turn a 10-second outage into a restart loop. Readiness below is where
   * dependency checks belong.
   */
  app.get('/health', async () => ({ status: 'ok' }));

  /** Readiness: can this instance actually serve requests that need data? */
  app.get('/health/ready', async (req, reply) => {
    try {
      await pool.query('select 1');
      return { status: 'ready', database: 'up' };
    } catch (err) {
      req.log.error({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'not-ready', database: 'down' });
    }
  });

  // Resolves req.user from the session cookie; must be registered before any
  // route that reads it.
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(saveRoutes);
  await app.register(matchRoutes);
  // Websocket last: matchSocket's route needs authPlugin's onRequest hook to
  // have already run on the upgrade request.
  await app.register(websocket, {
    options: {
      /**
       * A cross-site client carries its session token as a WebSocket
       * subprotocol, because the browser WebSocket API cannot set an
       * Authorization header (see ws/match.js's subprotocolToken).
       *
       * This must select and echo one back: RFC 6455 requires a client that
       * offered subprotocols to fail the connection if the server's response
       * names none of them, so without this the token-carrying handshake would
       * be rejected by the browser before any frame was read. Echo only the
       * marker, never the token itself — the response header is as loggable as
       * a URL. A client offering nothing (the same-site cookie path) gets
       * `false`, which is the "no subprotocol" answer and leaves it untouched.
       */
      handleProtocols: (protocols) => (protocols.has('ptg-bearer') ? 'ptg-bearer' : false),
    },
  });
  await app.register(matchSocket);

  return app;
}

async function start() {
  const app = await build();

  // Migrations run before the server accepts traffic, so a fresh deploy can
  // never briefly serve requests against an old schema. The advisory lock in
  // the runner makes this safe with several replicas starting at once.
  await migrate({ log: app.log });

  await app.listen({ port: config.port, host: config.host });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
