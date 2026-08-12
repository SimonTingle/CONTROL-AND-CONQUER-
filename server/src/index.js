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

  await app.register(cors, {
    origin: config.corsOrigin,
    // The session cookie only travels on credentialed requests, which in turn
    // require a named origin rather than '*' (see config.corsOrigin).
    credentials: true,
  });

  await app.register(cookie);

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
  await app.register(websocket);
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
