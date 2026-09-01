# Every cookie-authenticated write was 500ing, including creating a match

## How this was found

Asked to test online multiplayer end-to-end: two real signed-up players, two
isolated Playwright browser contexts against a local instance of `server/`,
create a match, play a few minutes. The very first write — player A clicking
**Create match** — returned a 500. The server log named the exact line:

```
TypeError: next is not a function
  at Object.csrfProtection (@fastify/csrf-protection/index.js:126:5)
  at Object.csrfUnlessBearer (auth/plugin.js:53:16)
  at hookIterator (fastify/lib/hooks.js:412:10)
```

## Root cause

Yesterday's `9ee3490` ("Carry the itch.io session as a bearer token; cookies
stay for the main site") added `csrfUnlessBearer`, an `onRequest` hook that
skips CSRF for bearer-authenticated (itch.io) requests and otherwise defers to
`app.csrfProtection`:

```js
app.decorate('csrfUnlessBearer', async (req, reply) => {
  if (req.authViaBearer) return;
  return app.csrfProtection(req, reply);
});
```

`app.csrfProtection` is `@fastify/csrf-protection`'s own hook, and it is
**callback-style**, not async: `function csrfProtection(req, reply, next)`.
Calling it with only two arguments means `next` is `undefined` inside it, and
on the success path it unconditionally calls `next()` — which throws
immediately on *every* request that reaches it.

"Every request that reaches it" is every state-changing route for a
cookie-authenticated session — every player except one on itch.io, where the
whole point of `authViaBearer` is to skip this hook. `routes/matches.js` and
`routes/saves.js` both put `csrfUnlessBearer` on their write routes; so does
`/auth/logout` and `/auth/reset-password`. Concretely: creating, joining or
starting an online match, logging out, resetting a password, and every cloud
save write were all broken for the main site. This shipped already merged to
`main` (PR #104/#105 territory) — it is not something introduced by the branch
this session was originally working on.

**Why nothing caught it at the time.** The commit that introduced it verified
"488/488 [tests], including negative controls for both [bearer-token]
parsers" — true, but none of those tests exercised `csrfUnlessBearer` itself
against a running Fastify instance; they tested the token-extraction functions
it depends on in isolation. The wiring bug lived entirely in how two plugins'
calling conventions compose, which only shows up when both are actually
running together.

## The fix

`server/src/auth/plugin.js`. Kept `csrfUnlessBearer` **callback-style** —
`(req, reply, done)`, matching what `@fastify/csrf-protection` itself expects
— and forwarded Fastify's own `done` straight through:

```js
app.decorate('csrfUnlessBearer', (req, reply, done) => {
  if (req.authViaBearer) return done();
  app.csrfProtection(req, reply, done);
});
```

The first fix attempted was a promise wrapper around the async version —
`new Promise((resolve, reject) => app.csrfProtection(req, reply, (err) => err
? reject(err) : resolve()))`. That is wrong in a way worth recording: on a
*failed* CSRF check, `csrfProtection` does not call `next` (or the callback)
at all — it calls `reply.send(err)` directly and returns. A promise waiting on
that callback would never resolve or reject; the request would hang until
whatever timeout eventually killed it, rather than cleanly returning 403. The
callback-forwarding version handles both of `csrfProtection`'s exit paths
correctly because it *is* the shape the library expects: `next === done` on
success, and the reply short-circuits normally on failure, exactly like any
other hook that calls `reply.send()` and returns.

## Verification

**`server/test/csrf-hook.test.mjs`** (new — first test file `server/` has
had). A real, in-process Fastify app with the real `@fastify/cookie` and
`@fastify/csrf-protection` plugins and the real `auth/plugin.js`, driven with
`app.inject()` — no open socket, no network. `config.js` still requires
`DATABASE_URL` at import time (a real dependency of the module graph, not
faked around), so the test needs that env var set; it never actually queries
the database, since `req.user`/`req.authViaBearer` are set directly in a
follow-up hook rather than exercising `userForToken`.

Three cases:
- a cookie-authenticated write with a valid CSRF token succeeds (200) —
  this is the case that threw before the fix;
- a cookie-authenticated write with **no** token is rejected cleanly (403),
  not crashed — the case the promise-wrapper attempt would have hung on;
- a bearer-authenticated write skips CSRF entirely and succeeds with no
  token at all.

**Negative control**, by surgical edit — restore the exact broken hook body —
confirmed test 1 fails with the same `next is not a function` shape this bug
produced in the browser, while the other two still pass (they were never the
part that broke). Restored immediately after.

**End-to-end**, the thing that actually found this: two signed-up players in
two isolated Playwright contexts, against a local Postgres and the real
`server/` process, create + join + start a match. Before the fix: 500 on
create. After: `POST /matches` returns 201 and the lobby transitions into the
room. Full multi-minute two-client play session covered separately.

`npm test` at the repo root: 500/500, unaffected — this bug was entirely
server-side and outside that suite's reach.

## Honest limits

- No test in `server/test/` (there was no `server/` test infra before this)
  covers the routes this hook actually guards end-to-end against a real
  database — that coverage came from the manual two-client run, not from an
  automated suite. A future regression here would only be caught by running
  the game, unless someone adds route-level tests against a seeded database.
- Not audited: whether any other route in `server/src/routes/` calls a
  callback-style Fastify/plugin hook the async way. This was found by hitting
  the one path a real multiplayer session exercises first (creating a match);
  `/auth/logout` and `/auth/reset-password` share the exact same hook and are
  fixed by the same change, but were not separately exercised end-to-end this
  session.
