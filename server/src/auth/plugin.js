/**
 * Resolves `req.user` from the session cookie on every request, and exposes
 * `app.requireAuth` for routes that must not run without one.
 *
 * Attaching the user in a global hook (rather than per route) means a route
 * can never accidentally read a stale or unset `req.user`; requiring auth
 * stays explicit and opt-in, so adding a route cannot silently expose data.
 */

import fp from 'fastify-plugin';
import { SESSION_COOKIE, userForToken } from './sessions.js';

async function authPlugin(app) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.user = await userForToken(req.cookies?.[SESSION_COOKIE]);
  });

  /** Use as `{ onRequest: app.requireAuth }` on any route that needs a signed-in user. */
  app.decorate('requireAuth', async (req, reply) => {
    if (!req.user) {
      return reply.code(401).send({ error: 'authentication_required' });
    }
  });
}

// fastify-plugin stops Fastify from encapsulating this: without it, the
// decorators and hook would only exist inside this plugin's own scope and be
// invisible to the routes registered alongside it.
export default fp(authPlugin);
