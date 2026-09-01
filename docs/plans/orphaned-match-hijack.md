# The real bug: a stale match row, not a disconnect

## What this supersedes

`docs/plans/version-badge-and-reconnect.md` chased a `code=1006` disconnect
and, once the two leading infra hypotheses (multiple CapRover instances,
`Websocket Support` off) were both checked and ruled out by the user
directly, ran out of leads. This is a different bug, found from two
screenshots the user sent after seeing "both devices go straight into a
match, no lobby — they look like two separate games":

- Device 1: `seed 2114612213 · team 1 · waiting 2p · turn 0` — a fresh match,
  waiting for a second player.
- Device 2: `seed 412335829 · team 0 · running · turn 283` — a match already
  283 turns deep.

Different seeds. These are, genuinely, two separate matches — not a
disconnect at all. `seed 412335829` matches `93d78dd3-...` from the earlier
production log: the same match `checkForOwnMatch()`'s auto-rejoin (PR #109)
kept silently pulling one account back into, repeatedly, across an entire
session, days ago.

## Root cause

`server/src/ws/matchRoom.js`'s `rooms` map is purely in-memory — its own
header says so, and `matchClient.js`'s reconnect work already relied on that
fact. **A server restart wipes it.** But nothing ever told the `matches`
table that had happened: `POST /matches/:id/start` sets `status = 'running'`
and nothing ever moves it out of that state again except `leave` (and only
for a *host* leaving an *open*, not running, match — see
`routes/matches.js`'s `leave` handler). A match that reaches `running` and
then has its process restarted — a deploy, a crash, anything — is frozen at
`status = 'running'` in the database forever.

`GET /matches/mine` (added in PR #109, `routes/matches.js:135`) scopes to
`status in ('open', 'running')` specifically so a reload can find its way
back into a real, live match. It has no way to tell "live" from "orphaned
by a restart days ago" — both look identical in the table. So it kept
returning `93d78dd3` to that account on every single lobby visit, and
`lobbyScreen.js`'s `checkForOwnMatch()` (called unconditionally from
`show()`, before the player can do anything else) redirected straight into
it — `mine.match.status === 'running'` fires `onStart` immediately, no
lobby screen ever renders.

Confirms the log evidence too: `[match] new room for 93d78dd3...:
expectedPlayers=1` appeared *repeatedly* across the earlier production log,
each time the process had freshly booted (or the room had otherwise been
garbage collected) — each "reconnect" was actually building a brand-new,
solo room from scratch, not resuming anything, because there was nothing
left to resume.

## The fix

`server/src/routes/matches.js`: new `abandonOrphanedMatches()`, called once
from `index.js`'s `start()` right after `migrate()` and before `listen()`.
Marks every `open`/`running` match `abandoned` at boot — correct
unconditionally, because `rooms` starts empty on every process start, so
there is categorically no live room behind any such row from before this
boot. A restart is the only way to reach this code at all, and a restart is
exactly what invalidates every one of those rows.

Deliberately scoped to a single instance, not attempted to be safe for
multiple replicas: with more than one process live, a restarting replica
would wrongly abandon a match another replica is still legitimately
running. The user already confirmed (checking CapRover directly, this
session) that `control-conquer-api`'s Instance Count is 1 — and
`matchRoom.js`'s own in-memory, per-process design was never safe for more
than one instance regardless (see `version-badge-and-reconnect.md`'s
now-closed-out multi-replica hypothesis).

## Files

- `server/src/routes/matches.js` — `abandonOrphanedMatches()`.
- `server/src/index.js` — calls it once, after `migrate()`.
- `server/test/abandon-orphaned-matches.test.mjs` (new) — real Postgres
  integration test, same pattern as `matches-mine.test.mjs`: abandons a
  stale `open` or `running` match, leaves `finished`/`abandoned` alone.

## Verification

- **`node --test server/test/*.mjs`** — 14 pass (4 new, 10 existing;
  `test/` as a bare glob doesn't resolve under this Node version, so the
  file list has to be explicit — that's a pre-existing quirk of this
  runner, not something this change touched).
- **Negative control**: the `where status in (...)` clause narrowed from
  `('open', 'running')` to `('open')` by surgical edit (`cp` backup, not
  `git checkout`) — the "abandons a running match" test failed for the
  right reason (a behavioral assertion on the row's status, not a missing
  import). Restored, confirmed passing again.
- **`npm test`** (root, dependency-free) — 518 pass, untouched by this
  change.
- Not verified: this was not exercised against the actual production
  database — no access to it from this environment. The fix is applied to
  the shape of the schema and the query patterns already covered by
  `matches-mine.test.mjs`'s tests against a real local Postgres, not to
  live production data. It runs once, automatically, on the next deploy's
  boot — there is no separate migration step for the user to run by hand.

## What this does not fix

- **`checkForOwnMatch()`'s own unconditional redirect** (`lobbyScreen.js:84`)
  is unchanged. A player still cannot decline an auto-rejoin — it is still
  correct behavior for a genuinely live match (that is the entire point of
  PR #109), and with this fix there should be no more orphaned rows for it
  to wrongly trigger on. Left alone rather than adding an opt-out UI this
  session did not investigate or ask for.
- **Existing orphaned rows already in the production database** — this fix
  only prevents new ones from surviving past the *next* boot. Any match
  already stuck at `running` from before this deploys will be cleaned up
  automatically the moment `control-conquer-api` next restarts (which
  deploying this change itself will do) — no manual database intervention
  needed.
- The original `code=1006` question from `version-badge-and-reconnect.md`
  is still, separately, open. This bug produced a symptom
  (`multiplayer feels broken`) that looked similar but has a fully
  different, now-identified and fixed mechanism. The `1006` reconnect
  mitigation already shipped stays in place regardless.
