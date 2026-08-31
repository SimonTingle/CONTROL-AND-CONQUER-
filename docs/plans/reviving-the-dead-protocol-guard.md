# The version guard was broken while a version drift happened

## The problem

`npm test` reported "2 failing" for months. Both suites —
`tests/match-room.test.mjs` and `tests/match-client-protocol.test.mjs` — died
identically, before running a single assertion:

```
tests/match-client-protocol.test.mjs
  → server/src/ws/match.js:59
  → server/src/db/pool.js:1   import pg from 'pg'
  ✗ ERR_MODULE_NOT_FOUND: Cannot find package 'pg'
```

Neither test touches a database. `match-room` wants `createRoom`,
`maybeBegin`, `releaseReadyTurns`, `reapSilent`, `checkProtocolVersion`,
`TICKS_PER_TURN`; `match-client-protocol` wants a single integer,
`PROTOCOL_VERSION`. All of them are pure. But they lived in the same module as
`matchSocket`, whose Fastify route handler imports `db/pool.js`, and an ES
module import pulls in the entire file — so reading one constant required the
Postgres driver to be installed.

It wasn't, at the repo root, because CLAUDE.md says it shouldn't be: *"`npm
test` must stay dependency-free — no database, no browser, no network."* Both
suites had a `process.env.DATABASE_URL ??= 'postgres://…'` placeholder that
handled `config.js` refusing to load, but nothing could handle `pool.js`'s
hard `import pg`.

## Why this was worse than a red tick

`match-client-protocol.test.mjs` exists for exactly one purpose. Its own
comment says so:

> The two files can't share a module — they ship as separate deployables — so
> nothing but this test catches one side being bumped without the other.

That guard had not executed in months. And in that window the client and the
`itch.io/` fork drifted apart underneath it: `SCHEMA_VERSION` went to 3 in
`src/` and stayed at 2 in the fork, eleven simulation modules were added to one
and not the other, and `PROTOCOL_VERSION` stayed at 2 on both — so the
handshake still passes and an itch.io client still joins a live match against a
web client running fundamentally different simulation code.

The fork sync is a separate change. This plan is about the fact that **the
smoke detector was disconnected while the fire started**, and that no CI
existed to notice either. Four merged branches — including several of mine —
reported "2 pre-existing failures, unrelated" in their PR descriptions. They
were not unrelated to anything.

## The fix

Split the pure room rules out of `server/src/ws/match.js` into
`server/src/ws/matchRoom.js`, which imports nothing at all. `match.js` keeps
`matchSocket` and re-exports the rules so existing importers
(`server/src/index.js`) are untouched.

**Not** `npm install pg` at the root. That would have turned the tests green
while leaving the CLAUDE.md rule broken — the suite would still depend on a
database driver, just a present one. The rule exists so the fast checks stay
fast and runnable anywhere, and satisfying the runner without satisfying the
rule is how the next person inherits the same problem.

The boundary was already clean, which is some evidence the split was latent in
the design rather than invented for the tests: `query()` appears exactly once
in the file, inside the route handler, as do `userForToken`/`SESSION_COOKIE`.
Nothing in lines 61–335 reached outside the module.

`Date.now()` and `process.env` are used freely in the extracted rules and that
is fine — this is the relay, not the simulation. CLAUDE.md's determinism rules
govern `src/`, where every client must derive identical state from a shared
seed. The server holds a wall clock on purpose.

## Also fixed by the same split

- `tests/e2e/two-client-match.mjs` carried the identical `DATABASE_URL`
  placeholder + dynamic-import workaround purely to read `PROTOCOL_VERSION`.
  Now a plain import from `matchRoom.js`; the workaround is gone.
- `tests/e2e/custom-vehicle-match.mjs` had `const PROTOCOL_VERSION = 2`
  hand-copied, while its sibling deliberately imported the constant to avoid
  drift. That copy would have gone stale on the next bump — the exact failure
  mode the protocol test exists to prevent, reproduced inside the test
  directory. Now imported.

## CI

Added `.github/workflows/ci.yml` running `npm test` and `npm run build` on push
to `main` and on every PR. There was no `.github/` directory at all.

Deliberately minimal, and deliberately **without** an `npm install` in
`server/`: if a future change makes the root suite need the server's
dependencies again, that step failing is the signal. `tests/e2e/` is not
included — it needs a live Postgres and a running API server, which is a job to
stand up separately rather than a reason to leave the fast checks unautomated.

## Verification

`npm test` — **334 pass, 0 fail.** The first fully green run in this repo for
months. The 18 tests in the two revived suites (14 room + 4 protocol) had never
executed at all; all 18 pass on their first real run, which is worth stating
plainly — they were correct all along, merely unreachable.

`npm run build` passes.

**Negative control**, per CLAUDE.md — and here the obvious one is exactly
right, because it reproduces the original incident. Bumped
`matchRoom.js`'s `PROTOCOL_VERSION` to 3 while leaving the client at 2:

```
not ok 1 - client and server agree on the protocol version constant
```

Restored, back to 4/4. The guard now does the job it was written for.

**Not verified:** the server itself was not started. `server/node_modules` is
not installed in this environment, so `matchSocket`'s runtime behaviour after
the split is checked only by `node --check` and by confirming
`server/src/index.js`'s `import { matchSocket }` still resolves against the
re-export. The extraction moved no code inside `matchSocket` and changed no
call sites, but a real boot is the honest confirmation and has not happened.
