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
import { bearerToken } from './credentials.js';

async function authPlugin(app) {
  app.decorateRequest('user', null);
  // Whether this request authenticated by bearer token rather than by cookie.
  // Read by the CSRF guard below — see there for why the distinction matters.
  app.decorateRequest('authViaBearer', false);

  app.addHook('onRequest', async (req) => {
    // Cookie first: it stays the mechanism for the main site, where it works
    // and is httpOnly. The bearer header is the fallback for cross-site
    // embeds where the browser refuses to keep the cookie at all (see
    // credentials.js).
    const cookieToken = req.cookies?.[SESSION_COOKIE];
    const headerToken = cookieToken ? null : bearerToken(req);
    req.authViaBearer = Boolean(headerToken);
    req.user = await userForToken(cookieToken ?? headerToken);
  });

  /** Use as `{ onRequest: app.requireAuth }` on any route that needs a signed-in user. */
  app.decorate('requireAuth', async (req, reply) => {
    if (!req.user) {
      return reply.code(401).send({ error: 'authentication_required' });
    }
  });

  /**
   * CSRF protection for state-changing routes, skipped for bearer-authenticated
   * requests.
   *
   * CSRF exists because a browser attaches cookies to cross-site requests on
   * its own, so a hostile page can make an authenticated request without ever
   * reading anything. A bearer token is the opposite: it only travels if the
   * page's own JS reads it out of same-origin storage and sets the header, and
   * a hostile origin can do neither. So a bearer request is structurally immune
   * to CSRF, and requiring the token there would only break the cross-site
   * clients this exists for — the `_csrf` secret is itself a cookie, and so is
   * dropped by exactly the browsers that dropped the session cookie.
   */
  // Deliberately callback-style — `(req, reply, done)`, not `async (req,
  // reply)` — because `app.csrfProtection` (from @fastify/csrf-protection) is
  // itself callback-style: on success it calls `next()`, but on failure it
  // calls `reply.send(err)` directly and returns *without* calling `next` at
  // all. Wrapping this in a promise that resolves only when `next` fires
  // would hang forever on that failure path. Forwarding Fastify's own `done`
  // straight through handles both: `next === done` on success, and the
  // request lifecycle short-circuits on `reply.send()` exactly as it does for
  // any other hook that sends a reply and returns.
  //
  // This replaced a broken `async (req, reply) => app.csrfProtection(req,
  // reply)`, which called `csrfProtection` with no third argument at all —
  // `next()` inside it then threw `TypeError: next is not a function` on
  // every request that reached it: every state-changing route for a
  // cookie-authenticated (i.e. non-itch.io) session — create/join/start
  // match, logout, password reset, saves.
  app.decorate('csrfUnlessBearer', (req, reply, done) => {
    if (req.authViaBearer) return done();
    app.csrfProtection(req, reply, done);
  });
}

// fastify-plugin stops Fastify from encapsulating this: without it, the
// decorators and hook would only exist inside this plugin's own scope and be
// invisible to the routes registered alongside it.
export default fp(authPlugin);
