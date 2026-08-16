# Online multiplayer: two clients, two private worlds

## The report

Two diagnostic exports from a single online match, plus: *"at the beginning of
the game there was a long pause as both screens said that they were waiting for
other team"*, and *"I remember multiplayer worked recently."*

Both files describe the same map — terrain seed `889011147`, identical team
seats — and completely different worlds.

| | Team A's save | Team B's save |
|---|---|---|
| Local seat (`activeVehicleId`) | 3 → team **1** | 2 → team **0** |
| simTick | 11118 | 14084 |
| Saved at | 12:58:23 | 12:57:52 |
| Structures / pads | facility + spire, 1 pad | **none** |
| Credits | team 1: 640 | both: 0 |
| Team 0 scout odometer | 12.88 | **1637.1** |
| Team 1 scout odometer | 244.73 | **0** |

Each client saw only its own player's actions. The opposing team sat frozen at
spawn in both. Team A saved 31 seconds *later* than Team B while being ~3000
ticks *behind* it, so nothing was gating either client's clock on the other.

## Reading the tick counts

`TICKS_PER_TURN = 6`, and `beginStep()` can only refuse to advance at
`tickInTurn === 0`. So a client stopped by lockstep always stops on a multiple
of 6; a client running ungated stops wherever it happened to be. That single
fact separates the two failure modes:

- **A: 11118 = 1853 × 6 exactly** — still gated, stalled awaiting a turn.
- **B: 14084 = 2347 × 6 + 2** — not on a boundary, therefore running with no
  gate at all.

Two *different* bugs, one on each client.

## What happened

1. **A connects first.** The room expects 2 and has 1, so nothing is released.
   A's screen: *"Waiting for 2 players to connect…"* — the reported pause.
2. **The 30-second start grace expires.** `maybeBegin` began the match anyway,
   short-rostered, flagged `waitedOut`. `releaseReadyTurns` gates on
   `room.players.size` — who is *connected*, not who is *expected* — so with one
   player present it released every turn on A's input alone. A played ~3 minutes:
   deployed, built the facility and spire, bought a harvester, earned 640
   credits. Alone, on a map it believed it was sharing.
3. **B connects late.** The room is already `started`, so `maybeBegin` returned
   at its first line and **B was never sent a `begin` frame**. `welcome` does
   carry `started` and `releasedTurn` — added precisely so a late arrival could
   catch up — but nothing in `src/` ever read either field, and
   `LockstepSession.resetTo` was dead code, never called from anywhere. So
   `session.start()` never ran, B never primed its input-delay window, and B
   **never sent a single input**. B's screen: *"Waiting for 2 players to
   connect…"* — the other reported pause.
4. **A stalls.** `players.size` is now 2 but only A reports, so the quorum can
   never be met. A froze on a turn boundary: 11118.
5. **B drops or reloads.** `onClose` → `endOnlineMatch` → `match = null`. Every
   other check keyed off that object rather than the mode, so the sim gate
   (`if (match && …)`) and the local-intent guard (`if (match) return;`) both
   stopped applying. B **free-ran at 60 Hz**, applying its own orders locally
   with `teamId = null` — which switches the ownership check off entirely — while
   `game.mode` was still `'multiplayer-online'`. B drove its scout 1637 units
   through a world nobody else could see.

Three independent fail-opens had to line up. Fixing any two still leaves a path
to a silent solo match, which is why all three are addressed here.

Worth noting what the grace period was originally *for*: an earlier fix added it
so that "somebody who joined a lobby and then closed their tab must not be able
to hang everyone else indefinitely." That is a real problem. But starting a
match that cannot work is not a lesser failure than refusing to start one — it is
a worse one, because it looks like success. The file's own header already stated
the correct contract ("Nothing is released until the whole roster has
connected"); the grace period quietly contradicted it.

## Changes

**A. The start barrier never fires short** (`server/src/ws/match.js`).
`maybeBegin` begins only when the roster is complete, with no timeout.
`START_GRACE_MS` became `START_REPORT_AFTER_MS` — a threshold for *reporting*
who is missing, via a new `waiting` frame, not for starting without them.

**B. Joining a running match works** (`ws/match.js`, `matchClient.js`,
`main.js`, `lockstep.js`). A socket joining a started room is now sent `begin`
directly, and the server asks the host for a resync snapshot through the path a
desync already uses. The client honours `welcome.started`/`releasedTurn` and
calls the new `LockstepSession.resumeAt()`, which resumes at the first
unreleased turn *without* re-priming turns 0..DELAY. It starts reporting input
immediately, despite its world still being stale — staying quiet until a
snapshot arrived would stall the host before it could ever send one.

**C. A silent peer cannot hang the match** (`ws/match.js`). Participation is now
timed separately from liveness: `lastInputAt` alongside `lastSeen`. The 5-second
heartbeat kept a client that never reported input looking perfectly healthy,
which is exactly how A froze. Only counted once the match has begun.

**D. An online match never degrades to local play** (`main.js`). The sim loop
and `drainIntents` both key on `game.mode` rather than on `match` being live, so
a disconnected client holds instead of free-running, and its orders are never
applied locally with ownership checks disabled. `endOnlineMatch` returns to the
portal.

**E. A way out** (`toast.js`, `style.css`). Since the barrier now waits
indefinitely, the waiting message carries a **Leave match** button. Toasts are
`pointer-events: none` so a background message can never swallow a click; the
action button opts back in, and opts out again while hidden.

## Verification

Before this change the repository contained **no tests at all** — no files, no
runner, no `test` script. Recent commit messages referenced verification
harnesses that lived only in a scratch directory, so none of those claims could
be re-checked. That is fixed here.

- **18 unit tests** (`npm test`), dependency-free: the barrier and release rules
  over a plain room object, and the session's stall/resume behaviour.
- **A 9-assertion two-client end-to-end** (`tests/e2e/two-client-match.mjs`)
  against the real relay, two real WebSockets and a real Postgres.
- **Negative controls on both.** Reverting only the barrier logic (keeping the
  test seams) fails the two tests that describe it, behaviourally rather than by
  import error. Running the E2E against the old barrier reproduces the original
  bug outright: the lone client is told `begin` with a roster of one, **simulates
  12 ticks by itself**, and the two clients end on **different turn streams
  (4 versus 0)**. With the fix, both run 40 turns on an identical stream.

The E2E's last assertion is the diagnostic signature from the saves, inverted:
both clients must be on the same tick and both on a turn boundary. The original
files showed one of each.

## Found, deliberately not fixed

Recorded rather than silently dropped. Roughly descending severity.

1. **No build or protocol version is exchanged.** `welcome` carries no build
   identity, so peers on mismatched builds connect happily. This is now live:
   PR #61 changed `Intent.command` from `(instanceId, cmdId)` to
   `(instanceId, instanceKind, cmdId)` — *positionally*, so an un-refreshed
   browser emits the old shape, `JSON.stringify` drops the `undefined` field, and
   the new peer reads every structure command as a vehicle command. Silent
   divergence from the first build order. The uploaded saves predate that merge,
   so it is not the cause here, but it is the most likely cause of the *next*
   report. A version in `welcome` and a refuse-with-"please reload" is the fix.
2. **`SCHEMA_VERSION` is still 2** (`src/core/snapshot.js`) though later commits
   added snapshot fields, and the resync path relays snapshots verbatim
   host→client — so a mismatched-build resync restores a world missing fields
   with no error raised.
3. **A departed player's team freezes.** Both `main.js` and `ws/match.js`
   describe an AI takeover that was never implemented. The teams in these saves
   are motionless for exactly this reason.
4. **`teams[0]` is always "You" in the player colour**, whatever seat you hold
   (`src/core/team.js`; `createTeams` never sees `localTeamId`). On the team-1
   client the HUD calls the *enemy* "You". Visible in both uploaded saves, which
   is why they look identical in that field.
5. **`hashState` covers too little to catch this class of desync**: no
   crystal-field stock, harvester AI state, fog or terraform. And
   `window.__determinismCheck` replays one client against itself, so it is
   structurally incapable of observing two clients disagreeing — a green
   determinism check says nothing about lockstep agreement.
6. **`difficultyId` is hardcoded `'normal'`** at the online callsite rather than
   read from the match row the server already stores and returns. Both clients
   hardcode the same literal so it is consistent today; it is still a
   determinism input not derived from shared truth.
7. **Rooms are in-memory and per-process.** A redeploy mid-match, or any replica
   count above 1, splits players into separate rooms under one match id — a
   latent second route to this same bug, invisible to the fixes above.
8. **The intent queue grows unbounded while stalled** (it is drained inside
   `beginStep`), and the whole backlog would apply at once if the client were
   then dropped to local play. Change D closes the exploit route; the unbounded
   growth remains.
