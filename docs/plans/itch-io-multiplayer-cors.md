# Online multiplayer doesn't connect from itch.io

## The report

"Online multiplayer does not connect" on the deployed itch.io build
(https://tingletech.itch.io/control-and-conquer).

## Live repro

itch.io wraps the actual game in an iframe served from a fixed CDN origin —
confirmed from the outer page's DOM:

```js
Array.from(document.querySelectorAll('iframe')).map(f => f.src)
// → ["https://html-classic.itch.zone/html/19042464/index.html?v=..."]
```

Reading the console *inside that iframe* (not the itch.io wrapper page, whose
console is a different, same-origin-restricted document) after clicking
"Multiplayer Online" showed one error and nothing else:

```
Access to fetch at 'https://control-conquer-api.apps.simontingle.com/auth/me'
from origin 'https://html-classic.itch.zone' has been blocked by CORS policy:
The 'Access-Control-Allow-Origin' header has a value
'https://control-conquer.apps.simontingle.com' that is not equal to the
supplied origin.
```

Every subsequent step (auth, cloud saves, opening the match relay's
WebSocket) is downstream of `/auth/me` and never got the chance to run — the
browser refused the request outright.

## Root cause 1 — CORS is single-origin

`server/src/config.js` read `CORS_ORIGIN` as one literal string and passed it
straight to `@fastify/cors`'s `origin` option (`server/src/index.js`). The
CapRover `control-conquer-api` app has it set to
`https://control-conquer.apps.simontingle.com` only (confirmed via a
screenshot of the app's own Environment Variables screen). itch.io games are
served from `https://html-classic.itch.zone` — a fixed origin, shared by
every HTML5 game itch.io hosts, but a different one from the main site — so
every cross-origin request from there was rejected before it reached the
server at all. Not a build problem: the itch.io fork's committed default API
URL (`itch.io/vite.config.js`) already points at the right place.

## Root cause 2 — the session cookie is cross-site, not just cross-origin

`src/net/api.js` sends every request with `credentials: 'include'`; the
session lives in an httpOnly cookie. `apps.simontingle.com` and `itch.zone`
are different registrable domains — genuinely cross-*site* — unlike the main
frontend and API, which are same-site subdomains of one domain and so work
fine under the deployed `COOKIE_SAMESITE=lax` (unset, defaulting to `lax`,
per the same screenshot). Even after fixing the CORS allow-list, a `lax`
cookie is silently dropped by the browser on a cross-site request — this
would have surfaced as a second, more confusing failure (CORS passes,
`/auth/me` returns 200, but with `user: null`) once the first bug was fixed.
`config.js` already had full support for `COOKIE_SAMESITE=none` (validated at
boot to require `NODE_ENV=production`, which the screenshot confirms is
already set) — it just wasn't turned on.

## Fix

Pure config, no feature-code or protocol changes:

- `server/src/config.js` — `CORS_ORIGIN` now parses as a comma-separated
  list (`corsOrigins`), trimmed and filtered. A single origin with no comma
  behaves exactly as before, so nothing changes for the existing deployment
  until the env var itself is edited. `frontendUrl` (the password-reset link
  target) now reads `corsOrigins[0]` — the canonical site, deliberately never
  a second, alternate-distribution origin like itch.io.
- `server/src/index.js` — no change needed. `@fastify/cors`'s `origin` option
  accepts an array of allowed origins natively.
- `server/.env.example` — documented the comma-separated syntax and the
  first-entry rule for `frontendUrl`.
- **Deployment** (done by the user in the CapRover dashboard, not from this
  session — no CLI/API access to it):
  - `CORS_ORIGIN` → `https://control-conquer.apps.simontingle.com,https://html-classic.itch.zone`
  - Added `COOKIE_SAMESITE=none`
  - Save & Restart

## Verified

- `npm test`: 482/482 pass, unaffected (no existing coverage of
  `server/src/config.js`).
- Ran the new parsing logic directly with `node -e` against both the
  two-origin production value and the original single-origin value; confirmed
  `corsOrigin` and `frontendUrl` come out correct in both cases (array of two
  / first entry; and unchanged single-string-equivalent behavior
  respectively).

**Not verified: the live fix.** This session has no access to the CapRover
dashboard to change env vars or trigger a redeploy — that part is on the
user. Once redeployed, the same live repro (Browser pane → itch.io page →
into the game's iframe → Multiplayer Online → console) is the way to confirm
it actually landed.
