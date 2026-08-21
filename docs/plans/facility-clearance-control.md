# Facility clearance: one ground controller instead of two half-built ones

## The request

Vehicles should ask a facility for permission before using it — the way an
aircraft asks a tower — and hold clear until it is granted, so that they stop
crossing each other's paths on the way in.

## What was already there, and the thing worth noticing

Two independent implementations of the same idea, in two files, drifting apart.

`repairController.js` claims `bay.dockedVehicle`, allocates ring indices out of
a lazily-created `bay._repairQueue` Set, sweeps stale claims every tick in
`_sweepBays`, and releases both directions in `onDestroy`.
`harvesterAI.js` claims `facility.dockedHarvester`, allocates out of
`facility._haulQueue`, sweeps in `_sweepFacilities`, releases in its own
`onDestroy`. The allocators are the same 64-iteration loop with the same
comment. Each file's comments refer to the other's bugs:

```js
// harvesterAI.js:603
/** Real per-waiter allocation — mirrors repairController's own queue Set. */
```

```js
// repairController.js:336
/**
 * Real per-waiter allocation rather than the harvester queue's own bug (a
 * hardcoded position that every waiter aims at) ...
 */
```

That second comment is now stale — harvesterAI was given a real allocator
later. Which is the point: **the same bug was found twice and fixed twice, and
the fixes did not reach each other.** The capability gaps below are all
instances of one copy having something the other never got.

| | depot (`harvesterAI`) | repair bay (`repairController`) |
|---|---|---|
| claims before approaching | yes (`TO_BASE` divert, `:296`) | **no — on arrival only** |
| sweep reclaims stale dock | `_sweepFacilities` `:142` | `_sweepBays` `:169` |
| sweep reclaims stale **queue slot** | **neither** | **neither** |
| stall detection while holding | **none** — `_waitingForDock` uses raw `_order`, not `_travel` | partial |
| queue ordering | **none** | **none** |
| lease/timeout on a claim | **none** | `QUEUE_TIMEOUT = 600` |

## Evidence: what the two-copy design actually costs

This work follows `harvester-collision-avoidance-study.md`, where four
harvesters and one depot produced two ordinary collisions in the approach
corridor and then **total, permanent gridlock** — all four frozen for 83% of a
ten-minute run, 1200cr delivered. The defects below are what that run was
sitting on top of. Each was traced in the source, not inferred:

- **`QUEUE_RING = 35` exceeds `DOCK_DISTANCE * 1.5 = 33`.** A waiter that wins
  the dock from its ring slot is instantly beyond `_unload`'s drift check
  (`harvesterAI.js:473`), so it releases the dock it just claimed and
  re-approaches. A claim/release flap on every single handoff.
- **`MAX_QUEUE_POSITIONS = 4` is not enforced by either allocator.** Both loop
  to 64 while the ring angle is `slot * 2π/4` — slot 4 is the *identical world
  point* as slot 0. The bookkeeping stays unique; the geometry does not. And
  `?? 0` turns the allocator's `-1` (full) into angle `-π/2`, which collides
  with slot 3.
- **Queue slots leak permanently, in both files.** The sweeps cover only the
  single dock field, never the Sets. Worse, `harvesterAI.onDestroy` releases
  against `_facility(inst)` — a `.find()` **search**, not the facility the
  claim was taken on — so with two same-team facilities it deletes an index out
  of the wrong Set, corrupting a live allocation there *while* leaking the real
  one.
- **Snapshot asymmetry.** `snapshot.js` serializes each vehicle's
  `queuePosition` (`:251`, `:122`) but neither facility Set — they are listed
  in `REBUILT_ON_LOAD` as deliberately transient. So after every load, waiters
  hold indices no Set records and the next claimant is handed index 0 on top of
  one of them. This is precisely the double-allocation
  `repairController.js:343-350` spends eight lines warning against.
- **Parking bays never had an allocator at all.** `parkingBayIndex` is
  `parkedHarvesters.length % 4` — a count. Park A, park B, A leaves, park C:
  C and B are assigned the same bay. `onDestroy` never calls `_leaveParking`,
  so a destroyed parked harvester skews every future assignment forever.
- **No queue ordering anywhere.** The dock goes to whichever waiter
  `for (const inst of this.vehicles.instances)` happens to reach first. That
  array's order is spawn/removal history, which `stateHash.js:13-16` explicitly
  documents as *not* part of the state two clients must agree on.
- **Holding has no stall detection.** `_waitingForDock` drives with raw
  `_order`, bypassing `_travel` — so no stall timer, no no-progress timer, no
  detours. A waiter that cannot reach its ring point re-issues the same failing
  order every tick, forever. The ring point itself is raw `cos/sin` with no
  terrain check, so "cannot reach it" is not hypothetical.

## The design: the ledger is derived, never stored

The decision that makes the rest simple.

`src/core/snapshot.js` is a hand-written field whitelist; a reservation map
added to a structure instance is silently dropped. Restore tears the world down
with `vehicles.remove()` / `structures.remove()` (`:343`), which bypasses the
destroy pipeline entirely — **`onDestroy` hooks never fire on load**. And
`snapshotContext()` (`main.js:1542`) doesn't include the traffic or repair
controllers at all. Any new *stored* ledger would need serializing, restoring,
sweeping, a `SCHEMA_VERSION` bump — and would still leak dead keys across every
load and every desync resync, exactly as `_haulQueue` does today.

So it is not stored. **The claim on the vehicle is the only source of truth:**

```js
inst.clearance = { facilityId, kind, slot, status, requestedTick, revokes } | null
```

and `FacilityControl` rebuilds its whole index from the fleet each tick, in
id-sorted order. Consequences, which are the actual argument for it:

- **A leak is not expressible.** A destroyed vehicle is not in `instances`, so
  its claim ceases to exist. No sweep, no release-on-destroy, no
  wrong-facility search — the three mechanisms that were buggy above all stop
  existing rather than getting fixed.
- **Snapshot needs nothing new.** `inst.clearance` rides on the vehicle, which
  is already serialized; the index rebuilds itself on the first tick after
  load. The saved-one-side-only asymmetry disappears because there is no other
  side.
- **Rebuild is also repair.** If a restored fleet contains two vehicles both
  claiming the same dock, the rebuild resolves it by the same ordering rule it
  uses for everything else — earlier `requestedTick`, id as tie-break — and
  demotes the loser. Self-healing is a property of the data structure rather
  than a sweep that has to remember to run.
- **Determinism by construction.** Contention resolves in id-sorted order, per
  `stateHash.js`'s own rule, replacing today's dependency on `instances` order.

## What it enforces

1. **One vehicle in the approach corridor.** `CLEARED` is exclusive within
   `APPROACH_RADIUS` of the facility. Holding fixes sit outside it by
   construction (`HOLD_RING > APPROACH_RADIUS`), so the corridor where the
   study's collisions happened admits one vehicle at a time.
2. **FIFO by `requestedTick`, tie-broken by id** — replacing "whoever the array
   loop reached first" with something both fair and identical on every client.
   `simClock.tick`, never wall clock.
3. **Clearance is a lease.** A grant not converted to a dock within
   `CLEARANCE_LEASE` is revoked and passed to the next in line, and the holder
   goes to the back of the queue with `revokes` incremented. This is the
   backstop against one stuck vehicle blocking a dock indefinitely — and,
   because the ledger is derived, a lease is an age check rather than more
   state to reconcile.
4. **Holding fixes are allocated and probed.** Slots are unique *and* capped:
   overflow widens the ring by a layer instead of reusing an angle, so slot 4
   is no longer slot 0. Each candidate is grade-probed before assignment
   against the same rule `_routeLooksDrivable` already uses, so a holding fix
   is never inside a cliff.

`FacilityControl.update` runs **before** `harvesterAI` in `simTick` — harvesters
must route against an already-decided assignment.

### Not intents

Clearance is sim-internal AI behaviour resolved identically on every client
from already-synced state — the same category as `harvesterAI`'s existing
decisions, which are not intents either. CLAUDE.md's "player actions are data"
rule governs *player* actions. No intent type is added and no existing intent
constructor is touched.

## A deadlock the unit tests could not see

The first working version put every rule above in place, passed 21
dependency-free tests including three negative controls, built clean — and
**deadlocked the moment it drove four real harvesters.**

Sixty simulated seconds, nothing delivered, credits flat at the starting 1200:

```
t=21s  states=to-field,waiting-for-dock,to-base,waiting-for-dock  clr=-,h0,c0,h0  delivered=0,0,0,0
t=41s  states=to-field,to-base,waiting-for-dock,waiting-for-dock  clr=-,c0,h1,h0  delivered=0,0,0,0
t=61s  states=to-field,waiting-for-dock,to-base,waiting-for-dock  clr=-,h1,c1,h0  delivered=0,0,0,0
```

Read the `clr` column: the `c` moves between harvesters every twenty seconds
and the revoke counts climb. The corridor was rotating and nobody was arriving.

**Cause: clearance was requested the moment a harvester left its field**, so
`CLEARANCE_LEASE` was timing an entire cross-map drive rather than an
approach. No harvester could finish that drive inside the lease, so every
grant was revoked in turn and handed to another harvester equally far away,
which also could not finish. The lease — the mechanism added specifically to
stop one stuck vehicle blocking a dock — had become the thing blocking it.

Bounding the approach and bounding the journey are not the same statement, and
nothing in a unit test distinguished them: every assertion was about ordering,
uniqueness and expiry, all of which were correct. What was wrong was *when the
clock started*, which only has meaning once a vehicle has a position and a
distance to cover.

Fixed with `TERMINAL_RADIUS`: outside it a vehicle is not under ground control
at all and simply drives; inside it, it must hold a clearance. The lease now
bounds the last ~110 units, which is what it was always meant to mean. The
regression is pinned by a test asserting the terminal area exists and sits
outside the holding ring — but the honest note is that the **browser run is
what caught this, not the suite**, and a version of this change that skipped it
would have shipped a worse economy than the bug it was fixing.

Two smaller faults surfaced in the same pass, both from the fix for the
one-tick bounce through holding (granting on the spot when the corridor is
free):

- Granting immediately while a queue already existed let a vehicle that had
  just arrived overtake one that had been holding. Immediate grant now also
  requires an empty queue.
- With immediate grants, whoever called `request()` first won — making the
  outcome depend on `vehicles.instances` order, the precise hazard this design
  set out to remove. The rebuild now re-checks the ordering rule against the
  current holder and swaps if a waiter outranks it, so the rule decides rather
  than the call order.

## Deliberately not done

- **Map-wide path deconfliction.** Ruled out deliberately: the game has no
  pathfinder, only five fixed detour angles, so general multi-agent path
  reservation would mean building one first. Scope here is facility approach
  zones, which is where the measured collisions actually happened.
- **`produceUnit`'s spawn exit** (`main.js:1161`) — the angle fan always starts
  at offset 0 and `isSpawnLocationViable` probes terrain only, never occupancy,
  so every unit a facility produces spawns on the same point. Armed Factory
  output is worse: `baseSpawnAnchor` (`commands.js:325`) pins it to
  `base.pos + (padRadius+8)` along `base.heading`, one fixed coordinate per
  team for the whole match. Separation is left entirely to
  `TrafficController._applyBump` shoving overlaps apart afterwards. A real
  convergence source; out of scope here.
- **Crystal fields** keep their advisory `MAX_HARVESTERS_PER_FIELD` count,
  which is bypassed three ways (the fallback query drops it, a player-picked
  field skips it) and, separately, **counts enemy harvesters** —
  `_countHarvestersOnField` walks `this.states`, which is not team-scoped and
  there is one `HarvesterAI` for the whole world.
- **Parking bays.** The `length % 4` allocator and the missing `_leaveParking`
  in `onDestroy` are real and reproducible; folding parking into the controller
  is the natural follow-up, not done here.
- **`repairController._maybeAutoQueue` filters only on `def.capacity`**, so
  `gun-platform`, `field-engineer` and `base-station` all auto-queue for repair
  at 30% health — contradicting `commands.js:83-91`, which says the base
  station is deliberately left out because it "isn't wired into the repair
  queue/dock flow".
- **Queued harvesters still cannot flee or retreat for repair** (`:231`,
  `:260`). Those exclusions exist to protect the claim invariant. Explicit
  release makes relaxing them safe now, but it is a behaviour change with its
  own balance implications and is left alone.
- **`itch.io/src/`** is a byte-identical mirror of several touched files. Per
  CLAUDE.md it is deliberately forked, so it is not synced here — flagged so
  the divergence is a decision rather than an oversight.

## Verification, including what it did not show

`tests/facility-clearance.test.mjs` — 21 dependency-free tests over plain mock
vehicles and structures, following `traffic-avoidance-swerve.test.mjs`. Three
negative controls, each confirmed to fail behaviourally before being restored:
reinstating the modulus ring geometry fails the slot-aliasing test; collapsing
the ordering rule to array order fails the FIFO test; removing lease expiry
fails both the stuck-holder and the repeated-revoke tests. 162/162 across the
suite; `npx vite build` succeeds.

The browser run, 4 harvesters and one depot, against the study's own baseline
over the same first 300 simulated seconds:

| | baseline | with clearance |
|---|---|---|
| reverse-starts | 153 | **70** |
| worst single harvester | 108 starts, 19 positions | 25 starts, 19 positions |
| a harvester pinned to ≤2 positions | yes (h4: 9 starts, 2 positions) | h4 only, and it never left `to-field` |
| max vehicles inside the approach corridor | not measured | **1**, in 0/600 samples exceeded |
| damage events | 14 | **24** |
| yield-starts | 4 | 10 |
| credits delivered | **0** | **0** |

**What is genuinely established.** The corridor invariant holds: across 600
samples no two vehicles were ever inside `APPROACH_RADIUS` of the depot at the
same time. Reverse-starts more than halved, and the pathological case the study
named — harvester #7, 108 escape maneuvers in 300s — is gone.

**What is not.** Nothing delivered, in either version. That is not a regression
and it is also not a success: **the baseline delivered exactly zero too.** Its
1200cr endpoint is just the 3000 grant minus three harvesters at 600 — arithmetic,
not income. The depot in this scenario sits at world (272, 0) and the baseline's
four frozen positions were all 64–89 units from it, i.e. jammed in the annulus
just outside; with clearance they are sequenced and still never get inside 36.
Neither version can complete a delivery here, so this scenario cannot demonstrate
an economic improvement, only the absence of gridlock. **A scenario with a
reachable depot is still needed and has not been run.**

**And one result that goes the wrong way: contact went up, 14 damage events to
24, with three polled hull overlaps where the baseline had none.** The likely
reading is that the baseline's low count was a symptom rather than a virtue —
four vehicles frozen solid do not collide with each other — and that vehicles
actively circulating around holding fixes trade some paralysis for some
bumping. Likely is not measured, though. If contact frequency matters more than
throughput, this change is not obviously an improvement on that axis, and the
honest position is that it needs the reachable-depot scenario to settle.

**A finding worth more than the traffic fix.** The automated "first open pad
slot" placement used by the study, and reused here, produced a depot that
harvesters cannot reach at all — in two independent runs, under two different
traffic systems. `canPlaceAt` checks terrain for the *structure*, never whether
a harvester can drive to the resulting `dock` point. That is a placement bug and
it silently costs a player their whole economy; it is not fixed here.
