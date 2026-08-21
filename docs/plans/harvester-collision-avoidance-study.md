# 4-harvester demo: collisions, and what happens after one

## What was run

A practice scenario, not a fix: 4 Crystal Harvesters on one team, one
Harvester Facility, left to run autonomously for 10 simulated minutes
(`window.__step`, real Multiplayer AI match, headless Chromium). A temporary
telemetry hook (`window.__harvesterTelemetry`, removed before this doc was
written — confirmed `git diff --stat src/main.js` empty) polled every
harvester's position, health, `yielding`/`_yieldTimer`, `reverseTimer`,
`blocked`, and `harvesterAI` state twice a second, filtered to the player's
own team (the AI opponent runs its own harvester in parallel and contaminated
the first attempt at this run — worth flagging: **team-scoping telemetry is
not optional** when a demo shares the map with an AI economy). Events were
classified into `hull-overlap` (polled distance under the same `hitRadius`
formula `trafficController.js` uses internally), `damage` (a health drop —
the only thing that can lower a harvester's health here is
`_applyCollisionDamage`, so this is an unambiguous "it actually hurt"
signal), `yield-start` (avoidance engaging), and `reverse-start` (an escape
maneuver beginning).

The Harvester Facility's placement was found by an automated "first open pad
slot" scan around the base, not chosen for good terrain — that matters for
how to read the severity below.

## What happened: two real collisions, then total gridlock

**Two genuine collisions**, both early, both between exactly the pair of
harvesters converging on the same place at the same time:

- `t=1.0`–`7.5s`: harvesters #4 and #6, both racing to the same crystal
  field, took 5 rounds of contact damage (220 → 194 HP each) while jockeying
  at the field edge.
- `t=33.5s` and `t=64.5s`: harvesters #7 and #8, both approaching the depot
  from similar headings, collided twice more near the dock.

That much is unsurprising and matches what `trafficController.js`'s swerve
avoidance is *supposed* to allow — a bump under contention, not a crash.

**What's alarming is what happened next: all four harvesters, not just the
two that touched, permanently stopped delivering anything for the remaining
~500 seconds of the run** — 83% of the demo. Each settled at one fixed world
position and never moved again, down to the float:

| id | frozen from t≈ | frozen position | reverse-start count |
|----|---|---|---|
| 4 | 33.5s | (201.2, −53.7) | 17 |
| 6 | 99.5s | (221.1, −67.5) | 26 |
| 7 | 118.5s | (335.8, −3.2) | 256 |
| 8 | 82.0s | (328.5, 41.5) | 27 |

Each of these positions is right where that harvester was when it collided
(or, for #4/#6, right by the field they collided at). None of the four ever
reached `unloading` or `waiting-for-dock` again after freezing — the
periodic state dump shows `to-field,to-base,to-base,to-base` essentially
unchanged from t=21s to t=581s. Team credits ended the run at 1200cr — a
fraction of what 4 active harvesters over 10 minutes should deliver.

**Harvester #7 is the extreme case**: 256 of the run's 326 `reverse-start`
events belong to it alone, recurring roughly every 60–90 seconds, forever,
at the identical position — not slow progress, zero net movement, verified
by sampling its position at every one of those 256 events.

## Why: the mechanism, traced to the actual code

`_onAbandoned` in `src/vehicles/harvesterAI.js` (line ~942) is what a
harvester falls back to when it stalls (`STALL_TIMEOUT = 3s` below
`STALL_SPEED = 0.3`) or makes no progress (`NO_PROGRESS_TIMEOUT = 6s`
without closing `PROGRESS_EPSILON = 0.5` units). It tries
`DETOUR_ANGLES = [0.9, -0.9, 1.6, -1.6, 2.4]` radians off the direct
bearing, one at a time. When all five have been tried and failed, the code
has an explicit branch for `TO_BASE` — and its own comment states the
design assumption plainly:

```js
if (s.state === TO_BASE) {
  // Home is never bannable: the pad is reachable by construction, the base
  // drove there. A harvester circling near home beats one frozen in a
  // canyon, so just keep trying.
  s.retryTimer = RETRY_PAUSE;
  s.dest = null;
  return;
}
```

**That assumption is the bug.** "A harvester circling near home" is not what
the telemetry shows — it's a harvester frozen in place, retrying the
identical five-angle sequence against the identical unreachable target,
forever, because `TO_BASE` is the one state this retry loop can never escape
by design (every other state eventually bans its destination via
`s.bans.set(field.id, ...)`, `BAN_SECONDS = 45`). There is no fallback
beyond "try the same five angles again" — no widening search, no picking a
different approach point, no flagging itself as genuinely stuck. The
~60–90s period between #7's reverse-starts is consistent with one full
sweep: an initial straight-line attempt (up to 6s to notice no progress),
then up to five detour attempts each needing its own stall/no-progress
window (up to `~5 × (6s + REVERSE_DURATION 1.5s)`) before the empty
`TO_BASE` branch resets and the whole thing repeats — reconstructing the
exact figure would need sub-second polling this run didn't do, but the
order of magnitude matches.

**The two are connected**, not independent findings: a routine, expected
collision (harvesters #7/#8 converging on one dock, exactly the scenario
`_waitingForDock`'s per-slot queue ring was built to handle) knocked #7 into
a position and heading its local-only steering — no real pathfinding, five
fixed detour angles, a cheap `_routeLooksDrivable` pre-check — could never
recover from. `beginReverse` fires every cycle (confirmed:
`reverseTimer` is briefly non-null at each trigger) but produces no lasting
displacement, which reads as either a genuinely undrivable pocket at that
exact spot, or the reverse maneuver's own short duration
(`REVERSE_DURATION = 1.5s`) being too brief to clear whatever's pinning it
before the next stall check re-arms.

**#4 and #6's freeze is the same mechanism seen from a different trigger**:
they never even reached `to-base` cleanly — #4's frozen spot is right at
the crystal field where the *first* collision happened, meaning that
harvester's own field-approach path degraded the same way #7's base-approach
did, from the same root cause (no recovery path after a local-steering
system loses its bearings, whatever the destination).

## Caveats

- **The facility's placement was automated, not deliberately adversarial.**
  Whether the specific terrain here happens to be unusually bad, or whether
  this reliably reproduces on flatter ground, was not tested — a second run
  with a hand-chosen, clearly-flat facility site (and maybe a wider dock
  approach) would separate "this code path is fragile" from "this map spot
  was unlucky." The mechanism (`_onAbandoned`'s un-bannable `TO_BASE`, no
  escalation beyond five fixed angles) is real regardless; how *often* it
  bites in ordinary play is not established by one run.
- **`hull-overlap` (the poll-based geometric-overlap check) never fired**,
  despite 14 confirmed `damage` events that can only come from
  `_resolveCollision`. The 0.5s poll resolution missed the actual overlap
  tick every time — `trafficController`'s bump-apart resolves overlap
  within the same tick it's detected, faster than this demo's sampling rate.
  Anyone repeating this: poll at the sim's own tick rate, or hook
  `_resolveCollision` directly, not positions after the fact.
- Only one depot, one facility placement, one seed was tested. This is a
  single data point, richly instrumented, not a statistical sample.

## Recommendations, each tied to the mechanism it addresses

1. **Give `_onAbandoned`'s exhausted-detours `TO_BASE` branch an actual
   escalation, not just a reset.** The five angles are `atan2`-relative to
   the *current* position every time — after enough failed cycles, try a
   larger radius, or a bearing relative to the *facility's* position rather
   than the harvester's current (possibly already-bad) one, or fall back to
   the queue-ring point (`QUEUE_RING = 35`, already computed in
   `_waitingForDock`) as a known-reachable rally point to route through
   first. The goal is a harvester that eventually reaches *somewhere*
   useful, not one that reruns an identical failing plan.
2. **Add a genuinely-stuck signal distinct from "still trying."** Right now
   a harvester frozen for 8 minutes reports the same `to-base` state as one
   mid-delivery — nothing tells a player (or an AI commander evaluating its
   own economy) that a harvester has silently stopped contributing. A
   counter on consecutive full `_onAbandoned` cycles for the same
   destination, surfaced as a HUD/selection warning past some threshold,
   would turn a silent failure into a visible, actionable one.
3. **Investigate why `beginReverse` produced zero measured displacement for
   harvester #7 across 256 separate triggers.** Either terrain there is
   genuinely inescapable at `REVERSE_DURATION = 1.5s` of backing off (in
   which case a longer or repeated reverse before re-attempting the detour
   sweep might clear it), or there's a deeper interaction between
   `reverseTimer`/`escapeCooldown` and `_onAbandoned` re-triggering before
   any reverse motion accumulates. This needs a finer-grained repro (poll
   at tick rate, log `forwardSpeed` through a reverse cycle) to distinguish
   the two — this study's data narrows the search but doesn't resolve it.
4. **`trafficController.js`'s swerve avoidance itself did roughly what it
   should here** — it didn't prevent the two initial collisions (closing
   speed and approach angle at a dock/field entrance can still exceed what
   a 6-unit `AVOIDANCE_MARGIN` and 120° cone catch in time), but it wasn't
   the origin of the gridlock either. The highest-value fix is upstream in
   `harvesterAI`'s recovery path, not in the avoidance geometry — tightening
   `AVOIDANCE_MARGIN` or the cone further is likely to reduce initial-contact
   frequency only marginally next to what fixing item 1 would prevent
   (contact still happens under real contention; it's the *inability to
   recover* from it that turned two bumps into a fully stalled economy).

## Not done

No code changes were made — this is the investigation the plan called for,
not the fix. Whether recommendation 1 (or another) becomes a scoped
implementation task is a decision for after these findings are reviewed.
