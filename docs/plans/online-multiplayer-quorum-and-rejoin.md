# Online multiplayer, round two: the running-match quorum and a broken rejoin

## Context

`docs/plans/online-multiplayer-desync.md` fixed the *start* barrier — a match
would no longer begin short-rostered. That part held: two new screenshots from
a live redeploy both show *"Waiting for the other player…"*, confirming both
clients received `begin` and the roster completed. Everything after that was
still broken, and **most of what follows was introduced or amplified by that
same fix.** That is the honest headline of this round: the fail-open at match
*start* was closed, and the identical fail-open in the *running* match was left
standing.

## The report

Same seed (`513863176`) on both screens, both `STALLED`, both ejected to the
portal after roughly 15 seconds:

| | Team 1 | Team 0 |
|---|---|---|
| turn / tick | 14 / 84 | 2 / 12 |
| vehicles | **8** | **4** |
| sync | **DESYNC @t10** | unverified — no peer compare |

A 2-team match spawns one base station and one scout per team, so 4 is correct
and 8 means that client built its world twice.

## Reading the numbers

`TICKS_PER_TURN = 6` and `beginStep()` can only refuse to advance at
`tickInTurn === 0`, so a client stopped by lockstep always lands on a multiple
of 6. Both readouts here are on the surface consistent with that (14, 2), which
only says both clients were gated — it does not by itself explain the gap
between them, or the doubled world. Both required tracing the actual protocol
rather than reading the numbers alone this time.

## What happened

**The primary cause: the running quorum still counted connections, not the
roster.** `releaseReadyTurns` gated on `reported.size < room.players.size` —
the *connected* count. The start barrier (previous round) stops the match from
*beginning* that way, but nothing stopped the quorum from *shrinking* the
moment a socket closed mid-match. The instant that happened, the survivor alone
satisfied the smaller quorum and was released to simulate every subsequent turn
on its own — free-running at up to ~8 turns/sec
(`MAX_CATCHUP_STEPS = 5` per frame). That is how one client reached turn 14
while the other's world sat at turn 2. This is precisely the class of bug the
previous round's fix targeted; it just wasn't applied to the running-match path,
only the start-of-match one.

**Why the client that fell behind could never come back**, three separate
faults, two of them introduced by the previous fix:

- `LockstepSession.resumeAt` set `sentThrough` past the input-delay window
  without ever sending anything for it — `resetTo` alone advances the
  bookkeeping, `start()` actually loops over `send()`, and `resumeAt` was
  missing that loop. The server then waited forever for input the rejoining
  client would never send, which — once the quorum is roster-based — stalls
  *every* client, not just the rejoiner. **Introduced this round's predecessor.**
  The unit test written for it missed this because it hand-fed
  `receiveTurn(501)` directly, mocking away the very server quorum that broke.
- `matchClient.js`'s message switch had no `case 'resyncNeeded'` — the previous
  round added the server message and the `main.js` handler for it, but not the
  client-side route between them, so the handler was dead code and no resync
  was ever requested. **Introduced this round's predecessor.**
- `turn_already_released` (a turn rejected because it was already broadcast)
  was sent by the server but `main.js` registered no `onError` handler at all,
  so a session that could never rejoin the turn stream learned nothing and
  re-stalled silently, forever.

**Why both were ejected after 15 seconds.** A `lastInputAt`-based reaper (added
last round specifically to prevent one kind of stall) treated "sent no input for
15s" as death. But a stalled client stops sending input *by design* —
`beginStep()` returns early the instant a turn is missing. Both sides of any
mutual stall cross that threshold within one 5-second sweep of each other, so
both were closed and both landed back on the portal. The heartbeat added to
protect a stalled client only ever fed `lastSeen`, a different field, so it
could not help. **Introduced this round's predecessor** — it punished the
symptom of the very stall the quorum fix should have prevented, rather than the
actual dead connection.

**Why one client had eight vehicles.** `deployStartingForces` is purely
additive — it spawns one base and one scout per team without clearing
anything — and neither `beginMatch` nor `startOnlineMatch` nor
`world.regenerate` clears the world first. `startOnlineMatch` had no re-entry
guard, and `LobbyScreen` could call `onStart` twice: `this.current` was cleared
only in `leave()`, never in `start()`, and `refresh()`'s `if (!this.open) return`
sat *before* its `await`, so a poll already in flight when the lobby hid could
still resurrect it. **The previous round's own fix made this the default path**:
`endOnlineMatch` began calling `returnToPortal()` on any disconnect, so a
dropped player landed on the portal, clicked Multiplayer Online, and the
still-populated lobby immediately re-entered the same running match — running
`beginMatch` a second time on top of the first. The codebase already knew this
class of problem: `matchEndScreen`'s "play again" uses `location.reload()`
specifically because rebuilding a match in place means unwinding the world, the
fleet, the fog masks, the commanders and the destroy queue by hand, and any one
of those missed is a subtle cross-match bug.

**Why the sync verdicts disagreed.** `room.hashes` was never purged when a
player left — only aged out by turn number — so a hash left behind by a dead
connection could sit in its turn's bucket and later be compared against a live
client's later report for the same turn, producing a phantom desync between two
clients that were never describing the same running match.

## Changes

**A. The quorum follows the roster, not the connection**
(`server/src/ws/match.js`). `releaseReadyTurns` now gates on
`room.expectedPlayers`. A drop pauses the match for everyone rather than
releasing the survivor — the running-match twin of the start barrier, closing
the identical fail-open at a different point in the match's life. The
`lastInputAt` mute-reaper is removed entirely along with its `not_reporting`
path; `reapSilent` now only removes a socket that has gone genuinely silent
(no message of any kind, including the heartbeat), and — critically — no longer
changes `expectedPlayers`, so it cannot let the match run ahead of whoever it
just removed. A departing player's `room.hashes` entries are purged so a dead
connection's stale hash can never be compared against a live later report.

**B. Rejoining actually works** (`ws/match.js`, `matchClient.js`,
`lockstep.js`, `main.js`). Added the missing `case 'resyncNeeded'`.
`LockstepSession.resumeAt(turn)` now primes `turn..turn+inputDelayTurns-1` the
same way `start()` primes `0..DELAY-1` — by sending, not just by moving
`sentThrough`. No separate "receiving but not simulating" state was needed: the
stale local world simulates briefly and wrongly until the snapshot corrects it
at a turn boundary, exactly as an ordinary in-match desync resync already
tolerates. Registered an `onError` handler: `turn_already_released` means this
session can never rejoin the turn stream, so it now ends the match for that
client with an honest message instead of re-stalling forever and, since the
quorum is now the whole roster, taking every other player down with it.

**C. One world, one match** (`main.js`, `ui/lobbyScreen.js`).
`startOnlineMatch` refuses to run while a match is already live.
`LobbyScreen` gained an `entered` latch, set before either `start()`'s request
or a poll's `onStart` call, checked by both, and reset only when the lobby is
opened again (`show()`) for a genuinely fresh visit — closing both races that
could fire `onStart` twice. `endOnlineMatch` now does `location.reload()` back
to a clean portal, replacing the previous round's `returnToPortal()` — the
remedy this codebase already sanctioned for exactly this class of problem. A
toast queued immediately before the reload is handed across it via
`sessionStorage`, read back once on load.

**D. The player is told what is happening** (`main.js`). Since the quorum now
pauses indefinitely rather than timing out, a mid-match stall past a few
seconds gets the same "Leave match" toast action the pre-start wait already
had — a pause has to look different from a freeze, and now has an escape hatch
either way, not just before the match begins.

## Verification

Every fix here got its own negative control, run against a surgical revert of
just that piece, and confirmed to fail for the *right* reason (a behavioral
assertion, not an import error) before being restored:

- **19 unit tests total** (`npm test`, was 18 after the previous round): the
  roster-quorum tests replace the two that had pinned the old (buggy)
  connected-count behavior; the `resumeAt` tests replace two that had asserted
  the pre-fix "does not send" shape, since that shape *was* the bug the tests
  were meant to guard against but instead were hiding.
- **A new `tests/lobby-reentry.test.mjs`** (3 tests) exercises `LobbyScreen`'s
  double-start races directly, with a small hand-rolled DOM stub rather than a
  jsdom dependency — `LobbyScreen`'s DOM surface is small and fixed
  (`createElement`, `classList`, `append`/`appendChild`, `replaceChildren`,
  `addEventListener`).
- **`tests/e2e/two-client-match.mjs` extended** with the drop→pause→rejoin
  cycle against a real relay and a real database: confirms the survivor does
  **not** advance while its peer is gone, confirms the rejoining socket
  receives `begin{resuming}`, confirms `resyncNeeded` reaches the host and a
  relayed snapshot reaches the rejoiner, and confirms both clients converge on
  an identical turn again afterward. Reverting the roster-based quorum alone
  reproduces the field bug directly: the survivor free-runs from turn 42 to 61
  while its peer is gone, unprompted. (Reverting the `resumeAt` priming fix
  *together with* the quorum fix does not cleanly isolate at this level — the
  two defects interact once the peer count returns to matching
  `expectedPlayers`, which masks the second one. That fix's negative control is
  the clean unit-test one instead, and is decisive on its own.)
- Full regression: `npm run build`, `node --check` on every touched file, the
  existing 10-minute AI-match pathology suite, and the determinism harness —
  all still pass. This round touches `src/main.js`'s `beginMatch`/sim-loop
  paths shared by every mode, so these mattered more than usual.

## Found, deliberately not fixed

Two items from the previous round's list are now more urgent than when they
were written, since more of the wire protocol has changed since:

1. **No build/protocol version is exchanged between peers**, still. Every fix
   in both rounds has touched shipped wire behavior (`Intent.command`'s shape
   from #61, `resumeAt`'s send behavior, the new `waiting`/`resyncNeeded`
   frames). None of it is guarded by a version check in `welcome`. Two players
   on different builds mid-transition will still fail in some new,
   undocumented way.
2. **A departed player's team is still not handed to an AI commander.** The
   pause behavior in this round makes the gap more visible, not less: a
   genuinely-departed player (not a network blip) now pauses the match
   indefinitely for their partner, with no automatic resolution beyond the
   survivor's own "Leave match" choice.

Everything else from the previous round's list (`SCHEMA_VERSION` staleness,
`teams[0]` always reading "You", `hashState` coverage, hardcoded
`difficultyId`, per-process in-memory rooms, unbounded intent-queue growth
while stalled) is unchanged and still recorded there.
