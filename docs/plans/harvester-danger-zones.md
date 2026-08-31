# Harvesters remember where they were shot; the AI fields an army again

Three fixes on one branch, all traced to the same 41-minute four-AI-team
diagnostic. The strategic reading of that diagnostic — and how this AI compares
to Command & Conquer and Homeworld — is in
`docs/plans/ai-strategy-genre-audit.md`; this document is the implementation.

## 1. Team-shared danger zones

### The gap

Homeworld's collector doctrine has two halves: break off when fired on, and do
not come back while the ground is still hot. The first half already existed —
`combatController` stamps `threatUntil`/`threatFrom` on any target at **fire**
time (not impact), and `harvesterAI`'s `FLEEING` state runs on it. The second
half did not exist at all. `THREAT_MEMORY` is 6 seconds, so a harvester fled,
the memory lapsed, and it drove back to the same field.

### The design

A per-team list of `{ x, z, radius, until }` on `HarvesterAI`, recorded when a
harvester **enters** `FLEEING`, centred on the shooter's position.

Two decisions worth stating, because the obvious alternatives are worse:

- **Team-shared, not per-harvester.** One harvester being shot teaches the
  fleet. The existing per-harvester `s.bans` stays and means something
  different — "this field failed *me*", from an unroutable or dry field — and
  both filter the same picker.
- **Positional, not field-keyed.** A harvester ambushed *between* fields has no
  `s.field` to blame, and reusing `bans` would have lost that case entirely.

Recorded on the way **into** the flee rather than on the way out, because
`threatFrom` is not serialized (see below) — a save taken mid-flee would
otherwise lose the one fact worth keeping.

Zones last `DANGER_ZONE_SECONDS` (90) with a `DANGER_ZONE_RADIUS` of 70 units,
merge into an overlapping zone rather than stacking (a turret firing for twenty
seconds would otherwise mint twenty near-identical zones and evict the memory
of everywhere else), and are capped at `MAX_DANGER_ZONES` (12), oldest evicted
first.

### The release valve, which is the important part

`_idle`'s picker has three progressively looser tiers. Zones are consulted in
tiers 1 and 2 and **deliberately ignored in tier 3**.

Zones are team-wide and last 90 seconds. Without that omission, a single
well-placed turret beside the only reachable field would mean a team never
harvests again — an economy that starves rather than work dangerous ground has
not been made cautious, it has been switched off. It is also what keeps the
existing "everything is banned" fallback from spinning: clearing `s.bans` could
never release a zone, so a zone-checking tier 3 would idle forever.

There is a test for exactly this, and a negative control that adds the check to
tier 3 and watches the harvester strand.

### Determinism

- `simClock.time` throughout, never wall clock — `harvesterAI.js`'s own header
  states the rule.
- **Serialized** in `snapshot.js` (`dangerZones`, alongside `harvesterStates`),
  restored against the same `simTick`. Absent on older saves, which load with
  no contested ground remembered — the pre-feature behaviour.
- **Hashed** in `stateHash.js`, for exactly the reason blocked fields already
  are: this decides where a team's harvesters drive, so two clients disagreeing
  route their economies apart within seconds, long before the divergence would
  surface in the positions and credits hashed downstream. Teams are sorted and
  zones sorted by coordinate, because `Map` iteration is insertion order and
  two clients that recorded the same two ambushes in a different sequence hold
  identical state in a different order.
- Fixed a stale comment in `snapshot.js` that claimed harvester bans "aren't
  worth persisting" — they have been persisted for some time.

`PROTOCOL_VERSION` bumped 3 → 4 in all three declarations. No wire format
changed; the simulation behind it did, which is the wider rule the v3 bump
established (`docs/plans/itch-fork-silent-split-brain.md`).

## 2. The AI's army budget

`isArmyUnit(def)` is now the single answer to "is this part of the army",
shared by `_tryBuildUnit`'s cap, its candidate scan, and `_manageArmy`. Scouts
are excluded from all three and get their own `reconCap` (1/2/2/3 by
difficulty), built *after* combat in the priority chain — anywhere earlier and
the cheapest unit on the list wins the affordability race on every tick between
paydays, which is the original bug in a new place.

The full trace of how three disagreeing answers produced 23 scouts and zero
tanks is in the genre audit and in `isArmyUnit`'s own comment.

The existing test asserting the old contract ("a scout counts against the
budget") was updated rather than deleted: the half of it that mattered — one
budget shared across *army* ids, not one allowance each — is preserved using a
second army def, and a new test asserts the budget and the roster cannot
disagree again.

## 3. Repair-queue depth cap

`facilityControl._assignSlots` has no depth cap, arguing that geometry
substitutes for one (`holdingFix` puts every fourth waiter on a wider ring).
The diagnostic disproves it: slots 0–10 filled at one bay, 14 vehicles queued
against 2 repairing, one scout holding 23,753 ticks — 6.6 minutes — without
reaching `QUEUE_TIMEOUT`'s **10-minute** backstop.

A bay repairs one vehicle at a time, so queue depth *is* the wait.
`MAX_REPAIR_QUEUE` (4) is applied where a vehicle **chooses** a bay, in both
`repairController._nearestBay` and `harvesterAI._nearestRepairBay` — imported
from one place, because a harvester and a combat unit deciding differently how
full is "full" is the same split-answer bug as the scout tag.

A full bay is skipped rather than joined, so with two bays and one full the
second still takes the vehicle. With every bay full the lookup returns null,
which callers already handle — it is the existing "no bay at all" disposition
(retry cooldown, carry on damaged), not a new branch.

## Verification

`npm test` — **363 pass, 0 fail** (18 new). `npm run build` passes.

**Seven negative controls**, each a surgical string replacement (never
`git checkout`, which has clobbered uncommitted work in this repo before), each
confirmed to fail for its own specific reason and then restored:

| Reverted | Tests that failed |
|---|---|
| zones consulted in tiers 1–2 | 3 — contested field taken, team not taught, no recovery after lapse |
| zone expiry pruning | 2 — zone never lapses |
| overlapping-zone merge | 1 — duplicate zones stack |
| team scoping on lookup | 4 — zones leak across teams |
| tier 3's release valve (added the check) | 1 — harvester strands with nowhere safe |
| `isArmyUnit`'s recon exclusion | 2 — the original bug, caught |
| the repair-queue cap | 3 — full bays accepted again |

**End-to-end AI match**, 41 simulated minutes, four AI teams, fast-forwarded
through `window.__step` (sim only, no render) against the built bundle:

Measured at tick 147,600 against the diagnostic's 147,610 — the same moment in
the match, to within a sixth of a second.

| | uploaded diagnostic | after |
|---|---|---|
| scout-buggies across AI teams | 23 | **8** (2 per team, exactly `reconCap`) |
| gun-platforms | 1 | **10** |
| AI teams fielding an army | 0 | **4 of 4** |
| kills by an AI team | 0 commanded | 2 gun-platform kills, by two teams |
| vehicles queued for repair | 14 | **8** |
| longest repair wait | 23,753 ticks (6.6 min) | **18,489 ticks (5.1 min)** |

Three teams reached the full `combatCap` of 3 gun platforms; Amber managed 1,
and Amber is the same team that was economically starved in the original
diagnostic (3,595 credits earned here against 4,160 there). Its income, not the
budget, is now what limits it — which is the correct failure mode.

**The repair-queue number is the weakest result here and is not oversold.**
Depth fell from 14 to 8 and the longest wait from 6.6 to 5.1 minutes, but 5.1
minutes is still a long time to be parked. The cap stops a bay accumulating
eleven waiters; it does not make a legitimately 4-deep queue at a slow bay
quick, because `secondsPerHealth` means a full repair genuinely takes minutes.
Cutting the wait further is a separate question about repair *rate* or bay
count, not about queue admission, and this change does not attempt it.

## Not verified

- **The comparison is not perfectly matched.** The uploaded diagnostic's teams
  held 6–7 scouts, which implies a higher `combatCap` and therefore a harder
  difficulty than the `normal` this run used; the diagnostic also recorded
  `buildDelaySeconds: 30` against this run's 30 but a different map seed. The
  qualitative change (an army exists at all; commanded combat happens) is
  decisive either way, and the tick counts match, but the per-unit numbers are
  a comparison of two similar matches rather than a controlled A/B of one.
- **Attack-wave quality is unmeasured.** `_manageArmy`, `_pickArmyTarget` and
  `_advanceUnit` have, as far as this diagnostic shows, never executed in a
  shipped build. They now run. Whether the waves they produce are *well tuned*
  — the right size, the right target, at the right moment — is a balance
  question this change does not answer, and the first honest place to find out
  is a human playing against it.
- **Danger zones were exercised in unit tests and by inspection, not observed
  live.** The 41-minute run produced too little harvester-directed fire to
  confirm a zone was recorded and avoided in a real match.
- Multiplayer determinism of the new hashed state was reasoned about and
  covered by sorting, not demonstrated with two clients (`tests/e2e/` needs
  Postgres and a running API server).
