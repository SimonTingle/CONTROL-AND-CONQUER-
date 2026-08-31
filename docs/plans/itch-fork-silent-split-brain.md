# The itch.io build was joining live matches and playing a different game

## The problem

`itch.io/` is a deliberate fork of `src/`, and its README says the build "talks
to the same production API… joins the same matches." It had not been synced in
13 `src/`-touching commits, and the drift had reached the point where the two
builds no longer agreed on what the simulation *was*:

| | `src/` | `itch.io/src/` |
|---|---|---|
| `PROTOCOL_VERSION` | 2 | **2 — handshake passes** |
| `SCHEMA_VERSION` | 3 | 2 |
| combat resolution | travelling shells | **hitscan** |
| `hashState` inputs | `{…, projectiles, bounties, blooms}` | `{vehicles, structures, game}` |

Eleven modules were missing from the fork entirely — `projectiles`, `craters`,
`bounty`, `veterancy`, and all of `audio/` and `render/`.

The handshake is the only thing standing between two clients and a shared
match, and it compares `PROTOCOL_VERSION` alone. Both sides said 2. So an
itch.io player could join a web player's match, and **the two would diverge on
the first shot fired** — one resolving damage instantly on the trigger tick,
the other flying a shell for a third of a second first. Everything downstream
(kill credit, veterancy, bounty coins, credits) follows from that.

`itch-io-distribution.md:71` anticipated exactly this failure mode when the
fork was created: *"is not fixed in the other, and copies drift silently."*

## Why nobody noticed

Because the guard was broken. `tests/match-client-protocol.test.mjs` exists
solely to catch client/server version drift, and it had been dying on
`ERR_MODULE_NOT_FOUND` for months — see
`docs/plans/reviving-the-dead-protocol-guard.md`, which is the companion to
this change and landed first for that reason. There was also no CI.

The ordering matters: syncing the fork without reviving the guard would have
fixed today's drift and left the mechanism that let it happen fully intact.

## The fix

**1. Ran `itch.io/sync-from-main.sh`.** `src/` and `itch.io/src/` are now
byte-identical (`diff -rq` clean). The script is an allow-list copy of
`src`, `index.html` and `public` — it cannot reach this fork's own
`package.json`, `vite.config.js` or `README.md`, so `base: './'` (the setting
itch.io actually requires) was never at risk.

`index.html` was in the sync set and is the one file
`itch-io-distribution.md` warns to re-check afterwards. Diffed before running:
the only difference was a stale `<h1>World Settings</h1>` where the root now
says `Menu`, from the drawer's chooser refactor. No absolute asset URLs on
either side. Confirmed after the build too — `dist/index.html` emits
`./assets/…` for both script and stylesheet, zero absolute references.

**2. Bumped `PROTOCOL_VERSION` 2 → 3** in all three places (`src/`,
`itch.io/src/`, `server/`).

This is the part worth explaining, because **v3 changes no wire format at
all**. The existing comment on the constant says to bump it "whenever the wire
format changes in a way an older or newer peer would misinterpret" — and by
that rule, this change doesn't qualify. That rule is too narrow, and this
incident is the proof: the frames were identical the whole time, and the two
builds still could not play together, because what actually has to match is
*the simulation reading them*.

So the rule is now wider, and the comment in the source says so: bump when the
wire format changes, **and** when a change lands that two peers would simulate
differently.

The bump is what makes the fix durable rather than momentary. The stale bundle
already uploaded to itch.io still declares v2; the server now requires v3, so
it is refused at the handshake with `versionMismatchMessage`'s explicit text
and close code 4010 — *"one side of this match needs to redeploy before it can
be joined"* — instead of silently joining and desyncing. The same applies to
the currently deployed web frontend until it redeploys, which is correct: the
frontend and the API are one deployable pair.

## Verification

`npm test` — 334 pass, 0 fail. The revived protocol guard now asserts the
bumped constant across client and server, so this change is covered by the test
whose absence caused it.

`npm run build` (root) passes. `cd itch.io && npm run build` passes — the
fork's dependencies were not installed in this environment and were installed
fresh, so this is the first confirmation the synced fork even compiles.

**Ran the built itch.io bundle in a real browser** (served from `dist/`,
driven with headless Chromium), because a clean build proves it compiles, not
that it works — and this sync added eleven modules the fork had never
contained. Portal → sandbox → difficulty → spawn a scout → drive it. Canvas
renders, HUD renders, the vehicle drives, and `window.__audio.debugState()`
reports `contextState: 'running'` — the audio system the fork did not have an
hour ago is live. Zero `pageerror`s. The two console errors are
`ERR_TUNNEL_CONNECTION_FAILED` (this sandbox's proxy blocking the build's call
to the production API — expected here, not a code fault) and a 404 for the
favicon.

**Not verified:**

- **The actual thing this fixes.** Proving an itch client and a web client can
  now share a match needs two clients against a live relay — `tests/e2e/`,
  which needs Postgres and a running API server, neither present here. What is
  demonstrated is that the two builds are byte-identical and that the stale one
  is now rejected; that they *interoperate* is inferred from identity, not
  observed.
- **Nothing has been uploaded to itch.io.** `itch-io-distribution.md:108`
  already records that the zip has never actually been uploaded once. The
  deployed bundle stays stale — and now stays *rejected* — until someone runs
  `npm run zip` and uploads it. That is a deliberate consequence of the version
  bump, not an oversight, but it does mean **the itch.io build is offline for
  multiplayer until it is re-uploaded**, which is a call worth making
  knowingly.
- The server was not booted (no `server/node_modules` here), so the bumped
  constant is checked by the test, not by a live handshake.
