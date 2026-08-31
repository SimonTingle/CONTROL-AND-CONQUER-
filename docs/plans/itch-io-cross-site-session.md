# The itch.io build could not hold a session, so online play was unreachable

Follow-up to [itch-io-multiplayer-cors.md](itch-io-multiplayer-cors.md), which
fixed the CORS half of this and explicitly recorded the cookie half as still
outstanding. This is that half.

## The report

After the CORS fix deployed, signing in on the itch.io build appeared to work —
the corner button changed to "Signed in as …" — but "Multiplayer Online" still
answered:

> Could not reach the server.
> Sign in from the portal to play online.

## What the evidence actually said

Two things, taken together, ruled out everything except the cookie.

**The server was reachable and answering correctly.** Driven from inside the
game's own iframe:

```js
await fetch(API + '/auth/me',  { credentials: 'include' })  // → 200 {user: null, csrfToken: …}
await fetch(API + '/matches',  { credentials: 'include' })  // → 401 authentication_required
```

A `401` is a *reply*. Before the CORS fix these requests never reached JS at
all (`net::ERR_FAILED`). So the transport was fixed and the server was fine —
it simply did not consider the caller signed in.

**Consecutive requests got different CSRF tokens.** `/auth/me` mints a token
derived from a secret in the `_csrf` cookie. Two calls in a row returned two
unrelated tokens, which can only happen if the cookie set by the first never
came back on the second. Curl with a cookie jar against the same endpoint
returned a *stable* token — so the server was setting the cookie correctly
(`SameSite=None; Secure; HttpOnly`, verified in the response headers) and the
browser was choosing not to keep it.

The heading "Could not reach the server." was misleading throughout and cost
time: `lobbyScreen.js`'s `renderError` prints it for *every* failure, including
`authentication_required`, which is not a reachability problem at all.

## Root cause

itch.io serves an HTML5 game from `html-classic.itch.zone`, embedded in an
iframe on `itch.io`, talking to an API on `apps.simontingle.com`. That makes
the session cookie third-party. Safari's Intelligent Tracking Prevention blocks
third-party cookies outright and has for years; Chrome is phasing them out the
same way. **`SameSite=None` is not an exemption from this** — it is what makes a
cookie *eligible* to be sent cross-site, and then a separate policy layer
discards it anyway. The user was testing in Safari, where this is
unconditional.

So sign-in "worked" (the login response updated the UI directly) while the
session it established was discarded before the next request. No server
configuration can change this; the cookie is refused by the client.

## The fix: carry the session as a bearer token, opt-in per build

The cookie stays exactly as it is for the main site, which is same-site with
the API and where an `httpOnly` cookie page JS cannot read is strictly the
safer arrangement. Cross-site builds additionally get a token they hold and
present themselves.

- `server/src/auth/credentials.js` (new) — `bearerToken` and
  `subprotocolToken`. Deliberately its own module with **no imports**: both
  parsers are pure strings, and `sessions.js`/`ws/match.js` both reach
  `db/pool.js`, which would have made these untestable without `pg`. The same
  trap already killed `tests/match-client-protocol.test.mjs` once — see its
  header — and forced `matchRoom.js` out of `ws/match.js` before that.
- `server/src/auth/plugin.js` — resolves `req.user` from the cookie, falling
  back to `Authorization: Bearer`. Cookie is checked first, so the main site's
  behaviour is bit-for-bit unchanged. Also adds `app.csrfUnlessBearer`.
- `server/src/routes/{auth,matches,saves}.js` — swap `app.csrfProtection` for
  `app.csrfUnlessBearer`; `/auth/login` and `/auth/register` additionally
  return `sessionToken` in the body; `/auth/logout` revokes the bearer token
  when there is no cookie to revoke.
- `server/src/ws/match.js` + `index.js` — the WebSocket carries the token as a
  subprotocol, and `handleProtocols` echoes the marker back.
- `src/net/api.js` — `USE_BEARER_AUTH` build flag; token in `localStorage`;
  `getSessionToken()` for the socket; cleared on logout and whenever `/auth/me`
  reports signed-out while a token is held.
- `src/net/matchClient.js` — `socketProtocols()`, passed as `new WebSocket(url,
  protocols)`.
- `vite.config.js` (off) and `itch.io/vite.config.js` (on).

### Why CSRF is skipped for bearer requests, not weakened

CSRF exists because browsers attach cookies to cross-site requests *by
themselves*, so a hostile page can make an authenticated request without
reading anything. A bearer token only travels if the page's own JS reads it
from same-origin storage and sets a header — a hostile origin can do neither.
Bearer requests are therefore structurally immune. Keeping the check would also
be self-defeating: the `_csrf` secret is itself a cookie, so it is dropped by
exactly the browsers that dropped the session cookie.

### Why the token is not in the URL

The browser WebSocket API cannot set an `Authorization` header. The obvious
alternative is a query parameter, and `protocolVersion` already travels that
way — but Fastify logs `req.url` on every request, so that would write a live
credential into every access log the upgrade passes through. The subprotocol
list is the one other client-settable handshake header, so the token goes
there as `ptg-bearer, <token>`. RFC 6455 requires a client that offered
subprotocols to fail the connection if the server names none of them, hence
`handleProtocols` — it echoes back only the marker, never the token, since a
response header is as loggable as a URL.

### The cost, stated plainly

A `localStorage` token is readable by page JS; an `httpOnly` cookie is not. An
XSS bug in the itch.io build could exfiltrate a session where the same bug on
the main site could not. That is a real regression in blast radius, accepted
**only** on the build where the alternative is no online play at all, and it is
why this is a per-build flag rather than a global switch.

## Verified

- `npm test`: 488/488 (6 new in `tests/bearer-auth.test.mjs`).
- **Negative controls, both run.** Replacing the greedy `Bearer` capture with a
  split-on-space parse failed two tests for the right reasons: `Basic abc123`
  was accepted as the token `abc123`, and `Bearer a b c` truncated to `a`.
  Replacing `subprotocolToken`'s marker check with a bare `parts[1]` **passed
  everything** — the control found a genuine hole in the test, since a client
  negotiating `graphql-ws, soap` would have had `soap` read as a session token.
  Added `subprotocolToken requires the marker, not merely a second list entry`,
  which fails against that break and passes against the real parser.
- Main-site build inspected: `ptg_session_token` appears zero times in
  `dist/`, confirming the flag is off and the cookie path is untouched.

## Not verified

- **That Safari actually keeps the session now.** No test here can make that
  claim — it needs the built itch.io zip uploaded and a real sign-in in Safari.
  That is the one check that closes this out.
- The WebSocket subprotocol handshake against a live server. The parser is unit
  tested and `handleProtocols` is per the `ws` docs, but no test in this repo
  opens a real socket with a subprotocol; `tests/e2e/two-client-match.mjs`
  authenticates by cookie.

## Found and deliberately not fixed

`lobbyScreen.js`'s `renderError` prints "Could not reach the server." above
*every* failure, including `authentication_required` and
`no_backend_configured`, neither of which is a reachability problem. It is what
made this bug read as a network fault for as long as it did. Left alone here to
keep this change to the session mechanism; it wants a heading chosen per error
code.
