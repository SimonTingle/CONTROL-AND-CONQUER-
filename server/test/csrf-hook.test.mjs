/**
 * `csrfUnlessBearer` — the hook `auth/plugin.js` puts on every state-changing
 * route (create/join/start match, logout, password reset, saves).
 *
 * Found by hand: two real signed-in players in two real browsers, creating a
 * real match against a real local server, hit a 500 on the very first write.
 * The server log named the exact line:
 *
 *   TypeError: next is not a function
 *     at Object.csrfProtection (@fastify/csrf-protection/index.js:126:5)
 *     at Object.csrfUnlessBearer (auth/plugin.js:53:16)
 *
 * `@fastify/csrf-protection`'s `app.csrfProtection` is callback-style —
 * `(req, reply, next)` — and on a *failed* check it does not call `next` at
 * all; it calls `reply.send(err)` directly and returns. The hook had been
 * written `async (req, reply) => app.csrfProtection(req, reply)`: no third
 * argument, so `next()` inside throws on every request that reaches it — which
 * is every cookie-authenticated (non-itch.io) write. The fix forwards
 * Fastify's own `done` callback straight into `csrfProtection`, so both of its
 * exit paths work: `next === done` on success, and the request lifecycle
 * short-circuits on `reply.send()` on failure, exactly as it does for any
 * other hook that sends a reply and returns.
 *
 * This exercises the real hook through a real (in-process) Fastify instance
 * with the real `@fastify/cookie` and `@fastify/csrf-protection` plugins —
 * the bug was in how they compose, which a test that stubbed either away
 * would not have caught. No database and no network: `app.inject()` never
 * opens a socket. `authPlugin` itself needs no DB either — `userForToken`
 * is stubbed by monkey-patching `req.user`/`req.authViaBearer` directly in a
 * cookie-less onRequest hook ahead of it, rather than pulling in sessions.js
 * and its pg dependency.
 *
 * Run: node --test server/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import csrfProtection from '@fastify/csrf-protection';
import authPluginModule from '../src/auth/plugin.js';

// authPlugin is `export default fp(authPlugin)`, and its onRequest hook calls
// the real `userForToken`, which needs postgres. Route around that the same
// way this file avoids every other DB dependency: register the real plugin
// (its csrfUnlessBearer decorator is what's under test) but override
// `req.user`/`req.authViaBearer` in a hook that runs after it.
async function buildApp({ bearer = false, authed = true } = {}) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(csrfProtection, { csrfOpts: { hmacKey: 'test-hmac-key' } });
  await app.register(authPluginModule);
  app.addHook('onRequest', async (req) => {
    req.user = authed ? { id: 'test-user' } : null;
    req.authViaBearer = bearer;
  });

  // Registered before `ready()` alongside `/write` — routes must all be added
  // before boot, or avvio refuses with "Root plugin has already booted".
  app.get('/token', async (req, reply) => ({ token: reply.generateCsrf() }));
  app.post('/write', { onRequest: [app.requireAuth, app.csrfUnlessBearer] }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

test('a cookie-authenticated write with a valid CSRF token succeeds', async () => {
  const app = await buildApp({ bearer: false });

  // Prime a CSRF cookie the way a real client does: GET something that calls
  // reply.generateCsrf(), which sets the _csrf cookie and returns a token tied
  // to it.
  const tokenRes = await app.inject({ method: 'GET', url: '/token' });
  const setCookie = tokenRes.headers['set-cookie'];
  const { token } = tokenRes.json();

  const res = await app.inject({
    method: 'POST',
    url: '/write',
    headers: { cookie: setCookie, 'csrf-token': token },
  });

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert.deepEqual(res.json(), { ok: true });
  await app.close();
});

test('a cookie-authenticated write with no CSRF token is rejected, not crashed', async () => {
  // The failure path is the one the broken code never reached without
  // throwing first — this is the case that would hang forever under a naive
  // `next`-must-be-called Promise wrapper, since csrfProtection replies
  // directly on failure instead of calling next.
  const app = await buildApp({ bearer: false });
  const res = await app.inject({ method: 'POST', url: '/write' });

  assert.equal(res.statusCode, 403, `expected a clean 403, got ${res.statusCode}: ${res.body}`);
  await app.close();
});

test('a bearer-authenticated write skips CSRF entirely, no token needed', async () => {
  const app = await buildApp({ bearer: true });
  const res = await app.inject({ method: 'POST', url: '/write' });

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  await app.close();
});
