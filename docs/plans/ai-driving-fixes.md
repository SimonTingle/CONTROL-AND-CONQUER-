# Four defects that stop AI units dead

Follow-up to [ai-commander-overhaul.md](ai-commander-overhaul.md) and
[harvester-field-selection.md](harvester-field-selection.md). Those made the AI
capable of playing a game; this fixes four ways its units stop playing it.

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

## Verification

`tests/ai-driving-fixes.test.mjs` — 12 dependency-free tests. Five negative
controls, each failing behaviourally:

| Reverted | Result |
|---|---|
| centre-based drift release | dead-band harvester ping-pongs again |
| scout `repair` guard | aiCommander steers a repairing scout |
| `markDocked` back in `_claimDock` | vehicle reads DOCKED during `entering` |
| lost-clearance re-queue guard | services a bay it does not hold |
| per-unit-id combat cap | buys a scout to top up the per-type allowance |

Full suite 225 passing; `npx vite build` clean.

### Re-run results

Headless Chromium, same configuration as the save (Multiplayer AI, expert, four
AI teams, 44 simulated minutes), checking the save's own failure signatures:

| Check | Save | After |
|---|---|---|
| AI teams economically dead (<2,000cr) | 2 | **0** |
| max repair-detour count | 74 | **2** |
| vehicle holding a dock from far away | 372s at 228u | **none** |
| frozen full-load harvesters at the end | 2 | **none** |
| combat-tagged units per team | 14 (7+7) | **7** |
| page errors | — | none |

The dead-band signature is visibly transient now rather than terminal: a
harvester shows up in the frozen-full list at 11 and 22 minutes and has cleared
by 33, which is what recovery looks like.

**One check still fails, and it is a fifth defect this work did not fix.** One
AI team finishes on 0 credits. Root-caused rather than left as a symptom:

Its harvester sits at `to-base` carrying a full load, order live, destination
set, **odometer frozen at 1755 for fourteen straight minutes**. Both escape
timers read exactly `0.00` the whole time — and in `_travel` both are gated on
the same expression:

```js
const holding = inst.yielding || inst.reverseTimer != null || s.state === FLEEING;
```

Instrumenting it settled which term is live, and it is not the one the shape
suggests: `yielding` is **false** every sample, with no other vehicle within 40
units. `reverseTimer` is non-null on five samples of six, cycling 0.67 / 0.12 /
0.78 / 0.23 / 0.90 against a `REVERSE_DURATION` of 1.5 — it is being re-armed
before it can ever expire.

That is `vehicleController.driveToTarget`'s terrain-blocked escape: facing an
unclimbable grade it drops the order and calls `beginReverse`, which sets
`reverseTimer`, which makes `holding` true, **which switches off the stall and
no-progress detection that would otherwise route the harvester around the
obstacle** — so it re-blocks and re-reverses forever, at zero speed, without
even accruing the grind damage that would eventually kill it and free the slot.

So the escape hatch disables the escalation. That is why terrain-blocking is
fatal here rather than merely wasteful, and it is a different statement from
"the AI grinds itself down" — this harvester is not being ground down at all
(health held steady at 201), it is simply switched off.

**Not attempted, by agreement:** this is the terrain-grind area the user
deliberately scoped out in favour of measuring first. The measurement is above.
The fix is small in shape — a hold cannot be indefinite, so `holding` should
stop suppressing the escapes once a reverse has been re-armed rather than
completed — but it lives in shared driving code that player vehicles use too,
and it is that user's call to make, not a drive-by inside a change that was
scoped to four other things.

**Not verified: online multiplayer.** All four changes read already-synced state
and add no `Math.random`/`Date.now`/`performance.now`, but that is reasoning,
not a two-client `tests/e2e/` run.
