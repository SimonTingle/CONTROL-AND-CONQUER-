# Ten defects that stop AI units dead

Follow-up to [ai-commander-overhaul.md](ai-commander-overhaul.md) and
[harvester-field-selection.md](harvester-field-selection.md). Those made the AI
capable of playing a game; this fixes ten ways its units stop playing it.

It was scoped as four. The four were fixed, the diagnostic was re-run, and the
re-run failed — so the next defect was root-caused against the re-run, fixed,
and the whole thing repeated until the run came back clean. Six of the ten
were found that way, and none of them was visible in the original save; the
first four were masking them.

## Where the evidence came from

A player-supplied diagnostic save: `multiplayer-ai`, `expert`, four AI teams,
`simTick 158056` — **43.9 simulated minutes**. Not a synthetic scenario, and
every number below is read out of that file.

What it showed:

| Team | Credits earned in 44 min | Structures |
|---|---|---|
| You (human) | 17,657 | 5 |
| Crimson | 19,200 | 7 |
| **Amber** | **320** | 1 |
| **Violet** | **0** | 1 |
| Jade | 20,800 | 6 |

Two of four AI teams never played. Both surviving AI repair bays held **8 and 9
vehicles**. **13 of 15 AI scouts** sat at exactly 15 health —
`BLOCKED_DAMAGE_FLOOR × 100`, the terrain-grind floor. One scout had held a bay
as `docked` for **372 seconds while 228 units away from it**.

Some of it was genuinely good news, and worth recording because it is the
baseline the next change is measured against: Jade **out-earned the human
player**, the value-per-cost picker demonstrably built all 7 tanks before
anything else, and Jade fielded two *author-built* custom harvesters that
delivered 5,760cr and 2,240cr — the tag-driven contract working end to end in
AI hands with no unit ids anywhere in the decision.

## 1. The dock dead band — this is what killed two teams

Arrival and release were measured from **two different points**:

- `_travel` calls a harvester arrived at `DOCK_DISTANCE` (22) from
  **`facility.dock`** — see `_destination`'s TO_BASE branch.
- `_unload`'s drift check released the dock at `DOCK_DISTANCE * 1.5` (33) from
  **`facility.x/z`**, the building *centre*.

`dockOffset` is 12. So a harvester 22 from the dock can be up to 34 from the
centre, and **anything landing in (33, 34] was "arrived" and "drifted" on the
same tick** — a one-unit-wide annulus.

Violet's harvester sat at **21.67 from the dock** and **33.66 from the
centre**. Both true. It cycled:

```
_travel arrives  (arrive('reached') forces speed to 0)
  → _atDock → UNLOADING
  → _unload sees drift → release, state = TO_BASE, dest = null
  → TO_BASE re-requests → WAITING_FOR_DOCK → CLEARED → TO_BASE
  → arrives …
```

No order is issued anywhere in that loop, so the stall and no-progress timers —
which live behind `!inst.hasOrder` — never advance, and every transition
re-zeroes them. It is unbreakable by design. That harvester carried a full 320
load for the entire match with **92 units of odometer** to its name, and its
team finished on 0 credits, which then cascaded: no income → no second
harvester (600cr) → no armed factory (1,200cr) → no army, no defence, spectator.

**Fix:** measure the release against `facility.dock`, the same point arrival is
defined against. The two predicates then cannot both hold *arithmetically*,
rather than being merely narrow.

## 2. Two controllers driving one scout

`aiCommander.update` runs at `main.js:2477`; `repairController.update` at
`:2482`. `_driveOneScout` had **no `inst.repair` guard** — its only early-outs
were `retryTimer`, `mode` and `menuOpen`.

So every frame a repairing scout had no order, aiCommander gave it a fresh
*explore* target. `repairController._driveTo` then saw `inst.hasOrder` and fell
through to its stall/no-progress tail, never reaching its `!inst.hasOrder`
branch — which is where **both** the detour ladder and the `_leaveBay` give-up
live. Its `claimedOrder` one-shot steal only fires on a leg's first tick.

The counter tells the story: `DETOUR_ANGLES` has **6** entries, and the save
holds scouts with **74, 56 and 50** detours. Those can only come from the two
blind increments in the tail, each undone by aiCommander before the give-up
could ever be evaluated. `inst.repair` never cleared, so the scout thrashed
into terrain until it floored at 15 health and occupied a bay slot forever.

**Fix:** one early return, matching the invariant every other unit type already
keeps — harvesters by mutual exclusion on `def.capacity`, army units by
`_maybeRetreat`'s own `if (unit.repair) return;`. Scouts were the only type
without it.

## 3. The dock lease stopped one leg too early

`markDocked` stops the clearance lease — correctly, because a repair can
legitimately outlast it. But `repairController._claimDock` called it at the
**dock point**, and then still had to drive the `'entering'` leg to the pad.
That leg is an approach, and it can fail. `_expireLeases` only ever inspects
`entry.cleared`, so a vehicle stalled in `entering` held its bay with nothing
able to reclaim it — the 372-second, 228-unit hold, with seven vehicles queued
behind it. Exactly the failure the clearance system was built to prevent,
displaced one step past where the lease reaches.

**Fix:** claim on arrival at the pad instead, in `_entering`.
`harvesterAI._atDock` already claims at true service start (it goes straight to
UNLOADING); both callers now mean the same thing, and `markDocked`'s own
comment — "bounds the *approach*, never the service" — becomes literally true.

This opens one hole, closed in the same change: the slot can now be revoked
mid-leg, so a vehicle arriving without a live clearance must re-queue rather
than park on a bay it no longer holds. Two vehicles on one pad would be a worse
bug than the one being fixed.

## 4. `combatCap` was a per-type allowance, not an army budget

`_tryBuildUnit` gated on `_ownUnits(unitId).length >= cap` — per **unit id**.
`scout-buggy` carries `tags: ['recon', 'combat']` and the armed factory
produces it, so once gun-platform reached its own cap the scout became the only
combat-tagged candidate left and was bought up to the cap as well.

Observed: **exactly 7 gun-platforms and exactly 7 scouts** on both working AI
teams, against `combatCap: 7`. About 2,450cr per team spent on units
`_manageArmy` explicitly refuses to field (`v.def.id !== 'scout-buggy'`).

**Fix:** count every combat-tagged unit against the cap, once, before the
produce scan. Value-per-cost still picks the tank first.

**Deliberately `combat` only.** `economy` keeps its per-id allowance: with two
harvester types that yields four harvesters against a cap of two, and that
surplus is most of why the AI economies that *do* work, work — the strongest
team's 20,800cr came from four harvesters. Making it tag-level here would halve
their income inside the change meant to repair income. It is a balance decision
that deserves its own measured pass, and there is a test asserting the
exception so it stays a choice rather than drifting into an accident.

**Knock-on, stated up front:** a surviving scout now spends one point of the
budget, so the fielded army is `combatCap` minus live scouts — six tanks at
expert, not seven. That is the honest reading of a shared budget, and six
committed tanks beats seven plus seven the commander won't send anywhere. It
also means a team keeps only the scouts it starts with; if the AI should
deliberately maintain recon, that wants an explicit `reconCap`, not an accident
of the combat budget.

## What the first re-run showed

Headless Chromium, same configuration as the save (Multiplayer AI, expert, four
AI teams, 44 simulated minutes). Five of the six failure signatures cleared:
repair detours dropped from 74 to 2, nothing held a dock from far away, and
combat-tagged units per team went from 14 to 7. The dead-band signature became
visibly transient rather than terminal — a harvester appears in the frozen-full
list at 11 and 22 minutes and has cleared by 33, which is what recovery looks
like.

**One team was still economically dead, and that was a fifth defect.** The full
verification and the final numbers are at the end of this document; the four
sections between here and there are what the re-runs turned up.

## 5. The terrain-blocked escape switched off the escalation

One AI team still finished on 0 credits. Its harvester sat at `to-base` with a
full load, order live, destination set, **odometer frozen at 1755 for fourteen
straight minutes**, both escape timers reading exactly `0.00`. In `_travel` both
are gated on one expression:

```js
const holding = inst.yielding || inst.reverseTimer != null || s.state === FLEEING;
```

Instrumenting it settled which term was live, and it was not the one the shape
suggests: `yielding` was **false** every sample, with no other vehicle within 40
units. `reverseTimer` was non-null on five samples of six, cycling 0.67 / 0.12 /
0.78 / 0.23 / 0.90 against a `REVERSE_DURATION` of 1.5 — re-armed before it
could ever expire.

That is `vehicleController.driveToTarget`'s terrain-blocked escape: facing an
unclimbable grade it drops the order and calls `beginReverse`, which sets
`reverseTimer`, which makes `holding` true, **which switches off the stall and
no-progress detection that would otherwise route the harvester around the
obstacle** — so it re-blocked and re-reversed forever, at zero speed, without
even accruing the grind damage that would eventually kill it and free the slot.
The escape hatch disabled the escalation.

Two things were wrong, and they are separate:

**5a. A cooldown shorter than the manoeuvre it gates.**
`escapeCooldown = SHARP_TURN_REVERSE * 0.5` — 0.6s against a 1.2s reverse. It
expired *during* the reverse, so the escape re-armed on the tick the reverse
ended, with no forward travel in between. The blocked path was already correct
at `BLOCKED_REVERSE * 2`. Now both are, and there is a test that reads the
multipliers out of the source rather than restating them.

**5b. A hold that never ends.** `holding` is right for a manoeuvre in progress
and wrong for one that cannot finish, so the mechanical terms get a
`HOLD_GRACE` of 10 seconds — generous against a real three-point turn, far
short of a freeze. `FLEEING` is deliberately left unbounded: that one is not a
manoeuvre but a standing decision, and timing it out would send a harvester
back into fire. The same bound is mirrored in `repairController._driveTo`,
which carries its own copy of the expression.

Re-running after 5a and 5b, the team that had earned **0** finished on
**11,840**. Two checks still failed, which is how the last four were found.

## 6. Three ways an escalation could never arrive

All three came out of the same observation: the escapes were not being
*suppressed* any more, they were never being *reached*.

### 6a. A waypoint leg with no order was completely inert

`repairController._driveTo`'s waypoint branch:

```js
if (r.waypoint) {
  if (reached) { r.waypoint = null; r.detours = 0; inst.setTarget(x, z, …); }
  return false;          // ← whether or not it was reached
}
```

Everything below that — the order re-issue, the stall check, the no-progress
check — was unreachable while a waypoint was live. So a vehicle whose order
went missing there had no way to get another one. Two ways it goes missing:
`driveToTarget` drops it on a terrain block, and the leg-change cancel at the
top of the same function drops it outright (`claimedOrder` is reset by every
caller on a new leg, and it does not clear the previous leg's waypoint).

The trace is unambiguous — one of Jade's harvesters, sampled every two seconds:

```
rst=queued det=2 wp=y order=false stall=0.0 noProg=0.0  odo=4803.6
rst=queued det=2 wp=y order=false stall=0.0 noProg=0.0  odo=4803.6
… identical for eight minutes …
```

Full load, in a repair queue, holding its slot, every timer at zero. Its team's
income was flat at 12,160 for eleven minutes.

**Fix:** return only when the waypoint has actually been reached, and clear a
stale waypoint on a leg change. `harvesterAI._travel` has always fallen through
here, which is why only the repair path had this.

The progress measure moves with it: while a waypoint is live it, not the
destination, is what the leg is driving at, so `bestDistance` is measured
against it. A detour deliberately moves away from the destination and would
otherwise read as failure.

### 6b. A hold that ends and immediately starts again

Fix 5b bounded a hold that never ends. This is the other shape, and 5b cannot
see it: `holdTimer` resets to zero whenever the hold lifts, so a hold that
*completes* every two seconds never reaches `HOLD_GRACE`.

Amber's harvester, sampled every second:

```
pos=(-137,307) d=26.6 spd=2.1 rev=1.5  noProg=0.9
pos=(-142,307) d=31.7 spd=6.6 rev=-    noProg=0.0
pos=(-137,307) d=26.6 spd=0.3 rev=1.5  noProg=0.0
pos=(-142,307) d=32.1 spd=6.6 rev=0.2  noProg=0.0
```

Drive at an unclimbable grade, block, reverse, drive at it again — a two-second
cycle, six units of ground, at full speed, for forty minutes. `stall` never
fired (the reverse is fast, so speed is high); `noProgress` never fired because
`if (holding) s.noProgressTimer = 0` wiped it on every cycle. The team finished
on 320 credits with one structure.

**Fix:** a hold *pauses* the no-progress timer rather than resetting it. A
deliberate hold is not a failure to progress, but it is not evidence of
progress either. The moving-but-getting-nowhere fraction of each cycle then
accumulates, and the escalation arrives in about a minute instead of never.
Mirrored in `repairController`.

### 6c. The detour ladder reset itself on success

With 6b in place the harvester escalated — and got stuck one level up:

```
det=2 → det=3 → det=1 → det=2 → det=3 → det=0 → det=1 …
sweeps=0 throughout
```

`_travel` set `s.detours = 0` on reaching a detour waypoint. But reaching a
waypoint means the *manoeuvre* worked, not that the leg is going anywhere — and
a harvester wedged short of its field can reach waypoints all day. The ladder
never reached `DETOUR_ANGLES.length`, so everything past it was unreachable:
the field ban for `TO_FIELD`, `abandonSweeps` and the holding-fix reroute for
`TO_BASE`, `_leaveBay` for the repair path. `abandonSweeps` read 0 for the whole
match, which is what that counter looks like when it is dead code.

**Fix:** progress resets the ladder, not a completed manoeuvre — one line moved
from the waypoint-reached branch to the `bestDistance` improvement branch. It
is then monotonic exactly when nothing is working, which is when the give-up
needs to be reachable. Mirrored in `repairController`, where progress toward a
*waypoint* explicitly does not count (see 6a — that is what `d` measures there).

### 6d. A loaded harvester queued for repair instead of delivering

Not a freeze, and the last thing standing between Violet and a normal economy.
`_maybeRetreatForRepair` fires from `TO_BASE`, so a damaged harvester one leg
from home broke off and joined the repair queue *carrying a full load*.
Measured: two harvesters, 640cr between them, queued behind five damaged
scouts for eight to ten minutes, while the team earned nothing and its credits
drained paying for those scouts' repairs.

**Fix:** finish the delivery already under way. The unload is seconds off and
`IDLE` re-checks the retreat the moment it is done, so the repair is deferred
rather than skipped. Danger is a separate question and `FLEEING` still owns it.

Violet finished on 13,440 instead of 11,840.

## Verification

`tests/ai-driving-fixes.test.mjs` — 24 dependency-free tests. Twelve negative
controls, each reverted in turn and confirmed to fail behaviourally (a wrong
assertion, not a missing import) on the test that names it:

| Reverted | Result |
|---|---|
| centre-based drift release | dead-band harvester ping-pongs again |
| scout `repair` guard | aiCommander steers a repairing scout |
| `markDocked` back in `_claimDock` | vehicle reads DOCKED during `entering` |
| lost-clearance re-queue guard | services a bay it does not hold |
| per-unit-id combat cap | buys a scout to top up the per-type allowance |
| `SHARP_TURN_REVERSE * 0.5` cooldown | cooldown expires mid-reverse |
| unbounded mechanical hold | permanently-reversing harvester never escalates |
| unconditional waypoint return | a leg with no order issues none and goes inert |
| stale waypoint kept across a leg change | aims at the previous leg's goal |
| `noProgressTimer = 0` under a hold | intermittent hold never accumulates |
| ladder reset on reaching a waypoint | ban is unreachable; harvester never gives up |
| no deliver-first guard | full harvester joins the repair queue |

Full suite 237 passing; `npx vite build` clean.

Two of the earlier controls did **not** bite on their first run, and both were
defects in the tests rather than in the fixes: the cooldown test restated the
multipliers instead of reading them from the source, and the FLEEING test set
`reverseTimer = null`, so the mechanical hold was false and the grace timer it
was meant to exercise never ran. Recorded because "the control passed" is
exactly the result that looks like success and isn't.

### Re-run results

Headless Chromium, same configuration as the save (Multiplayer AI, expert, four
AI teams, 44 simulated minutes), checking the save's own failure signatures:

| Check | Save | After 1–4 | After 5 | Final |
|---|---|---|---|---|
| AI teams economically dead (<2,000cr) | 2 | 1 | 1 | **0** |
| max repair-detour count | 74 | 2 | 0 | **2** |
| vehicle holding a dock from far away | 372s at 228u | none | none | **none** |
| frozen full-load harvesters at the end | 2 | 1 | 2 | **none** |
| combat-tagged units per team | 14 (7+7) | 7 | 7 | **7** |
| page errors | — | none | none | **none** |

Per-team credits earned in 44 minutes, save against final run:

| Team | Save | Final |
|---|---|---|
| Crimson | 19,200 | 16,640 |
| Amber | **320** | **2,240** |
| Violet | **0** | **13,440** |
| Jade | 20,800 | 25,600 |

Crimson is down and that is not noise: `combatCap` is now an army budget rather
than a per-type allowance, so a team fields six tanks instead of seven plus
seven scouts, and Crimson is the one team that was building tanks. The trade is
deliberate and stated in section 4.

Amber is alive but still poor, and the reason is terrain rather than logic: its
start position has one crystal field within 132 units and that field sits at
zero stock for the whole match; everything else is 278 units away, a round trip
its single harvester cannot run often enough. Recorded as a map/start-position
question, not fixed here.

**The frozen-harvester check needed fixing too.** Its predicate — full load,
speed 0, no order — also describes a harvester that has *just* arrived at its
dock, because `arrive('reached')` zeroes both. The final harness confirms every
vehicle it flags by stepping another minute and reading the odometer: the last
run flagged one and it had moved 235 units, so the check now reports what it
was always meant to report.

**Not verified: online multiplayer.** All ten changes read already-synced state
and add no `Math.random`/`Date.now`/`performance.now`, but that is reasoning,
not a two-client `tests/e2e/` run.

## Deliberately not done

- **Amber's start position.** See above — one dead field in range and a
  278-unit round trip to anything else. That is a map generation or
  start-placement question and wants its own measured pass.
- **Repair-bay queue priority.** The queue is FIFO by `requestedTick` with an
  id tie-break, which is fair and deterministic; five damaged scouts ahead of a
  harvester is that rule working as designed. 6d sidesteps it by not joining
  the queue mid-delivery rather than by re-ordering it. A priority scheme would
  need to be deterministic across clients and is a larger change than it looks.
- **`economy`'s per-id cap**, unchanged and asserted, for the reasons in
  section 4.
- **The terrain-grind mechanism itself.** A vehicle can still spend a minute
  bouncing off a slope before the escalation fires; what changed is that the
  escalation now fires at all. Making the first attempt smarter — a real
  pathfinder, or a grade-aware approach bearing — is a different piece of work.
