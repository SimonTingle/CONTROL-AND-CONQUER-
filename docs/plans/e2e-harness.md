# Standing up the e2e harness — and the bug it immediately found

## The problem

`tests/e2e/two-client-match.mjs` and `tests/e2e/custom-vehicle-match.mjs` are
the only checks in the repo that can observe a lockstep split-brain between
two real clients — the audit that led to PR #88/#89 flagged that every
determinism fix landed there was verified against a single client or by
argument, never against two real peers and a real relay. Neither script had
ever been run; nothing had booted `server/` in any session that touched this
repo.

This sandbox has Postgres 16 already installed, which the prior session's
summary hadn't established — that made this task tractable rather than
theoretical.

## Standing it up

Followed `two-client-match.mjs`'s own header recipe, with one adjustment: as
root, `initdb` and `pg_ctl` must run as the `postgres` system user (`initdb`
refuses to run as root), and the socket directory needs to be owned by that
user too:

```
mkdir -p /var/tmp/ccpg /var/tmp/ccsock
chown postgres:postgres /var/tmp/ccpg /var/tmp/ccsock
chmod 700 /var/tmp/ccpg

su postgres -c "PATH=/usr/lib/postgresql/16/bin:\$PATH initdb -D /var/tmp/ccpg -U cc -A trust"
su postgres -c "PATH=/usr/lib/postgresql/16/bin:\$PATH pg_ctl -D /var/tmp/ccpg -o '-p 55432 -k /var/tmp/ccsock' -l /var/tmp/ccpg/logfile start"
PATH=/usr/lib/postgresql/16/bin:$PATH createdb -h /var/tmp/ccsock -p 55432 -U cc ccdev

cd server && npm install
DATABASE_URL=postgres://cc@127.0.0.1:55432/ccdev \
  CORS_ORIGIN=http://localhost:5178 NODE_ENV=development PORT=3999 \
  MATCH_START_REPORT_MS=1000 node src/index.js &

node tests/e2e/two-client-match.mjs
node tests/e2e/custom-vehicle-match.mjs
```

Migrations run automatically at boot (`migrate.js`'s "runs on every boot"
design), so no separate `npm run migrate` step was needed.

One operational note worth recording: a background server process started
inline in a compound shell command (`cmd &`) did not survive past that
command in this environment — it was reaped along with the shell it was
attached to, producing `ECONNREFUSED` on the very next command. Starting it
as its own `nohup`/`&; disown` invocation, separate from any command that
also does other work, is what made it persist.

## The bug this immediately found

The very first e2e run surfaced a live crash, not a test failure:

```
ReferenceError: send is not defined
    at handleMatchSocket (server/src/ws/match.js:145:5)
```

PR #88 split `server/src/ws/match.js` into a pure `matchRoom.js` (room rules,
importable without Postgres) and a thin route handler left in `match.js`. The
split moved `send`, `broadcast`, `roomFor`, and `rosterOf` into `matchRoom.js`
as **module-private** functions — not exported — while `match.js`'s
`handleMatchSocket` still called all four, unqualified, relying on them
being in scope the way they had been before the split. Every unit test
passed because none of them exercise `handleMatchSocket` — the extraction
was checked by the rules it moved out, never by the handler that was left
behind calling them. This is exactly the class of bug the e2e harness exists
to catch: real, in code that shipped, invisible to every check that had
actually been run.

**Fixed** by exporting the four functions from `matchRoom.js` and adding them
to `match.js`'s existing import list (not to its re-export list — they were
never part of the public "room rules" surface the two unit-test suites
import, only internal to the route handler).

A second, smaller issue surfaced by the same run: `custom-vehicle-match.mjs`
asserted `a.welcome.protocolVersion === 2` — a hardcoded literal left over
from before PR #88 bumped `PROTOCOL_VERSION` to 3, even though the file
already imports the constant for the handshake itself two lines above.
Exactly the copy-vs-import drift `tests/match-client-protocol.test.mjs`
exists to prevent, in a file that test doesn't cover. Fixed by asserting
against the imported constant instead of the number.

## Also fixed: the fragile `ws` import

The audit had flagged `import ... from '../../server/node_modules/ws/index.js'`
in both e2e files as fragile: `ws` was reachable only transitively, through
`@fastify/websocket`, never declared in `server/package.json`. Added `"ws":
"^8.16.0"` as an explicit dependency there. The import path itself is
unchanged — a bare `import 'ws'` cannot resolve from `tests/e2e/`, which has
no `node_modules` of its own for Node's resolver to walk into — but what it
now reaches for is a pinned, declared dependency rather than an accident of
what another package happened to pull in.

## Verification

- `npm test` — 334 pass, 0 fail (unaffected; this branch is off `main` after
  PR #88 merged, before PR #89's determinism-fix suite).
- `npm run build` passes.
- `node tests/e2e/two-client-match.mjs` — **18/18 passed**, run twice
  (confirms it's idempotent against the same database — each run registers
  fresh accounts via `/auth/register`, so nothing carries over between runs).
- `node tests/e2e/custom-vehicle-match.mjs` — **8/8 passed**, also run twice.

**Not verified:**

- The `send`/`broadcast`/`roomFor`/`rosterOf` fix was found and fixed in this
  session; it was never live in production between PR #88 merging and this
  fix, because the server was never deployed with the split before this
  branch (the itch.io/live-relay history predates the split entirely) — but
  this was not independently confirmed against deploy logs, only inferred
  from the merge timeline.
- Postgres and `server/node_modules` are provisioned freshly by hand in this
  sandbox and do not persist between sessions; nothing here makes the harness
  self-installing for the next session. A `tests/e2e/run.sh` wrapper was
  considered but left undone — the manual recipe above is short enough that
  automating it didn't clearly pay for itself in this pass, and is left for a
  future session if the setup steps prove to recur often enough to be worth it.
- CI still does not run either e2e script (unchanged from PR #88, deliberate:
  `.github/workflows/ci.yml`'s header already documents that server deps and
  e2e are out of scope for CI).
