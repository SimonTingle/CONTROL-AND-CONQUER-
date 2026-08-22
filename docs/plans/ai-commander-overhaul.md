# AI intelligence: strength-aware posture, retreat and heal, generic composition

Follow-up to [ai-commander-capabilities.md](ai-commander-capabilities.md), the
investigation that motivated this. That document is the evidence; this one is
what was done about it.

## What the investigation found

The AI had a build loop and a movement loop, and nothing between them that
could be called a decision. Three gaps, all confirmed by reading
`aiCommander.js` rather than inferred from behaviour:

1. **The attack gate is a headcount and nothing else.** `_manageArmy`'s
   `if (army.length < this.economy.attackAt) return;` — `attackAt` is 2 or 3
   depending on difficulty. There is no comparison against the enemy's force
   anywhere in the file, so two gun platforms commit into ten exactly as
   readily as into none.
2. **Combat units have no self-preservation at all.** `combatController.js`
   already stamps `threatUntil`/`threatFrom` on every damaged vehicle
   (`combatController.js:239-240`), and only `harvesterAI.js` ever reads it. A
   gun platform fights to zero health. The AI then counts it, right up to the
   frame it dies, as part of the army it is deciding with.
3. **Composition has one candidate, and takes the first one found.**
   `_tryBuildUnit(tag, cap)` walks structures, walks their produced ids, and
   builds the first def carrying the tag. That is correct today because
   exactly one combat-tagged vehicle exists. It becomes arbitrary the moment a
   second one does — which is the case the vehicle builder makes routine.

## The shape of the change

One new decision layer inside `aiCommander.js`, feeding the existing
`_manageEconomy` / `_manageDefense` / `_manageArmy` calls rather than
replacing them. The tick order in `update()` is unchanged.

### Strength is measured, not counted

Three pure functions, exported so the tests can reach them without
constructing a commander:

```js
unitPower(def)    // (turret.damage / turret.fireInterval) * maxHealth, 0 if unarmed
valuePerCost(def) // unitPower(def) / cost
armyPower(units)  // Σ unitPower(u.def) * (u.health / u.def.maxHealth)
```

`damage/fireInterval` is sustained DPS; multiplying by `maxHealth` is the
standard "how much damage does this thing deliver over its lifetime" proxy,
and it is the product that matters — a glass cannon and a tough popgun are not
interchangeable. Health-weighting in `armyPower` is what makes a retreat
change the arithmetic rather than just the roster.

Every field these read is already on every def, vehicle and structure alike:
`gun-turret`'s def carries the same `turret` block a vehicle does, by design
(`structures.js:199-207` — "the same block a vehicle's turret reads"). So a
turret contributes to a base's defended strength without a special case, and a
future unit contributes the moment it exists. **Nothing is keyed by unit id.**
That is the same contract `vehicleDraft.js:373-375` already enforces on the
build side: *"aiCommander selects produced units by tag, so a buildable
vehicle with no tags can be built by a player but never by an AI."*

### The fog still binds

`_scoutedEnemyStrength()` sums `armyPower` over hostile vehicles the team has
actually seen, using the identical test `_attackTarget()` already applies —
`fog.seenAt(x, z) >= fog.revealThreshold`. Reveal is monotonic (`fogOfWar.js`:
"a mask is monotonically non-decreasing, so revealing is permanent"), so this
is memory of what was scouted, not live vision, and no new intel-staleness
concept is invented.

It returns `{ power, known }`, and `known` is the load-bearing half. An AI
that has scouted nothing sees `power === 0`, and a naive ratio would read that
as "the enemy is defenceless, attack immediately" — precisely the cheating-by
-omission the fog rule exists to prevent, arrived at from the opposite
direction. When `known` is false the commander falls back to today's flat
`attackAt` headcount, so unscouted behaviour is exactly what it is now.

### Posture

`this.posture` — one of `economy`, `defense`, `mass`, `attack`, `retreat` —
recomputed each tick by `_updatePosture(committable)` in strict priority
order:

| Posture | When | What changes |
|---|---|---|
| `defense` | something has hurt a unit or structure near home within `THREAT_MEMORY` | army targets the threat's own recorded origin, not the map centre |
| `attack` | opportunistic strike fires (below), or strength ratio ≥ `ATTACK_STRENGTH_RATIO` | commit at the attack target |
| `economy` | no committable army at all | hold; the build loop is the only thing doing work |
| `mass` | ratio between the two thresholds, or still rebuilding after a retreat | hold near home and keep buying |
| `retreat` | ratio ≤ `RETREAT_STRENGTH_RATIO` | pull back to home; stay in `mass` until strong again |

`ATTACK_STRENGTH_RATIO = 1.25` and `RETREAT_STRENGTH_RATIO = 0.6` are
deliberately far apart, and the whole band between them is `mass`. That gap
*is* the hysteresis: an army that withdrew at 0.6 has to climb all the way
back to 1.25 to turn around, not merely claw back over 0.6. A single threshold
would flap — an army at parity would advance, take a casualty, fall under,
withdraw, heal, advance, forever, without ever fighting.

Two things this deliberately does **not** do, both because a negative control
proved the first draft's version of them could never change an outcome (see
Verification — this is what those controls are for):

- There is no separate "was retreating, so keep massing" clause. The band
  above already produces exactly that, and the extra branch was unreachable.
- The strength comparison does not also re-apply the `attackAt` headcount.
  `attackAt` is the *unscouted* fallback and nothing else; requiring it on
  both paths made the measurement incapable of reaching any decision the
  headcount alone would not have reached, which quietly defeats the point of
  measuring. A force with a 1.25× margin over everything it has actually seen
  commits, whether that is three units or one.

`defense` outranks everything because a base being shelled while the army
marches on the far side of the map is the one failure that is unambiguously
wrong. It reads `threatUntil` against `simClock.time`, never a wall clock —
the same comparison `harvesterAI.js:230` already makes.

### Discovering a base

`_checkOpportunisticStrike` fires **at most once per enemy team, ever**,
tracked in `this._foundEnemyBase`. When a hostile base-station is scouted for
the first time, it sums the defensive power within `DEFENSE_MAX_RADIUS` of it
(the same radius the AI's own engineers deploy within, so "near the base"
means the same thing on both sides of the map). Below
`WEAK_BASE_DEFENSE_THRESHOLD` it overrides posture to `attack` for that tick
and points the army straight at the base.

Once per team is the entire safety property. Without the latch, a base that
stays weak re-triggers the override every tick, which is not "seizing an
opportunity" — it is just a permanently different attack rule. With it, an AI
that finds an undefended base early punishes it, and an AI that finds a
fortified one goes back to the ordinary strength comparison and never gets
another free pass at that team.

This is why the latch has to survive a save: see the snapshot note below.

### Retreat, heal, re-attack

Almost all of this already existed, in `repairController.js`, and finding that
is what kept the change small. `_maybeAutoQueue` (`repairController.js:104-131`)
already auto-queues *any* non-hauler vehicle for repair below
`AUTO_REPAIR_HEALTH_FRACTION = 0.3`, by setting `inst.repair = { bay, state:
'to-bay' }` — the same field the player-facing Repair command sets — and the
resulting drive already routes through `FacilityControl`'s dock clearance.

So no drive-to-bay state machine was written. What was added:

- `RETREAT_HEALTH_FRACTION = 0.4` — an *earlier*, AI-decided trigger. Between
  `harvesterAI`'s own `REPAIR_RETREAT_FRACTION = 0.5` and the generic 0.3
  backstop, on purpose: a combat unit should not run as eagerly as a harvester
  (it is supposed to be shot at) but should not wait for the last-resort
  threshold either.
- `_maybeRetreat(unit)` runs for every army unit **every tick, regardless of
  posture**. A retreat that only happens while the commander is in a
  particular mood is not self-preservation.
- `_isRetreating(unit)` excludes those units from `committable`, which is the
  roster every strength comparison and the attack gate are computed over. This
  is the part that is easy to miss: without it the AI keeps counting units it
  has just pulled off the line, and commits an army that is not there.

Affordability is checked before setting `inst.repair`, mirroring
`_maybeAutoQueue`'s own reasoning — a claim the team cannot pay for gets
released by `_repairing` on arrival and immediately re-taken next tick, a
flap that never resolves.

#### The long leg is not delegated, and a real match is what proved it

The first version handed the unit over the instant it dropped below the
threshold, and it looked right. Driving a real match found otherwise, and this
is the finding worth keeping:

> A gun platform at 15% health, **386 units** from its nearest bay, state
> `to-bay`, for **seventeen straight simulated minutes** — distance to the bay
> unchanged the entire time.

Two causes, compounding. `repairController`'s driver is deliberately a trimmed
local one — its own header says as much — with no pathfinder and six fixed
detour angles, sized for a unit hurt near home. And it never gave up, because
its detour counter resets on any local progress, so a unit shuffling sideways
forever never exhausts the fan that would have released it. Meanwhile
`_isRetreating` had removed that unit from `committable`, which is exactly the
roster `_manageArmy` drives with `_advanceUnit` — the NavGrid-backed router
that *does* know how to go around a mountain. The one unit that most needed
the better driver was the one guaranteed not to get it.

So the retreat now keeps the wheel for the long leg and hands over only the
terminal approach, at `TERMINAL_RADIUS` — the boundary `FacilityControl`
already draws around a facility, not a new number. The stale attack order is
dropped once when the retreat begins (otherwise the unit keeps driving at the
enemy while nominally withdrawing), and a new leg is issued only when the last
one ends. Release is on **full** health, not on clearing the 0.4 trigger:
letting go at 41% sends the unit straight back out to arrive needing to
retreat again.

That fix alone did nothing, and the next run showed why: `_maybeAutoQueue`
grabbed the unit at 0.3 and handed the long leg straight back to the driver it
had just been taken off. That function already carries exactly this carve-out
for harvesters, with exactly this reasoning — *"harvesterAI runs its own repair
retreat, at a higher health threshold and using its stronger detour/reverse
escape… letting this generic auto-queue also grab them is what produced the
wedge/flip-flop"* — so the AI retreat gets the same one line, suppressing only
the *initiation*, never the servicing.

The third run finally showed the commander owning the withdrawal end to end —
and the unit still frozen, at the same coordinates to the pixel across
independent runs. That last one is terrain, not this code: an order live and
never ending, against ground the vehicle cannot climb, in the same family as
`harvester-collision-avoidance-study.md`. It is not fixed here. What *is* fixed
is the part this feature owns: a withdrawing unit is subtracted from
`committable`, so a wedge on the way home is not merely a wasted unit but an
army the commander permanently believes it does not have. A withdrawal that
stops closing on its bay for `WITHDRAW_STUCK_TIMEOUT` is abandoned and the unit
rejoins the roster — where `_manageArmy` re-targets it on its own interval, a
moving destination being the likeliest thing to break a wedge, and where it at
least keeps shooting. `WITHDRAW_RETRY_COOLDOWN` keeps the health trigger from
simply re-firing next tick, which is the same claim/bail loop
`AUTO_REPAIR_RETRY_COOLDOWN` exists to stop. Same bounded-retry discipline as
`SCOUT_STUCK_TIMEOUT`, applied where the cost of not having it is highest.

A retreating unit keeps firing. Hull movement (`driveToTarget`) is independent
of turret aim in `combatController.js`, so this needed no gating either way —
confirmed by reading it, not assumed.

### Composition

`_tryBuildUnit(tag, cap)` now scores same-tag candidates by
`valuePerCost(def)` and takes the strictly highest. Strictly: ties keep the
first found, so with today's single combat-tagged vehicle the behaviour is
byte-for-byte what it was. Per-unit-id caps and the one-action-per-call
contract are unchanged — `_manageEconomy` and `_manageDefense` both chain on
the boolean return.

`economy` and `support` builds are not scored. Value-per-cost is a combat
metric; a harvester's `unitPower` is 0 and ranking engineers by their guns is
meaningless.

## Snapshot

`_foundEnemyBase` round-trips through `snapshot.js`'s
`serializeAiCommanders`/restore pair, alongside `exploreRadius` and
`baseRelocateAttempts` — it is the same category of state those two are
already saved for: latched, only ever grows, and resetting it silently undoes
a decision the commander already made. Concretely, without it, loading a save
lets every already-discovered base trigger the once-per-team strike a second
time.

`posture`, `myStrength` and `enemyStrength` are **not** saved. They are
recomputed from scratch on the first tick after load, which puts them in the
same category as `armyTarget`, which `serializeAiCommanders` already
deliberately omits for exactly that reason.

## Determinism

No `Math.random`, no `Date.now`, no `performance.now`. The one clock reference
is `simClock.time`, compared against `threatUntil` — which was itself written
from `simClock.time` by `combatController`. Every input is state both clients
already agree on: def stats (compile-time), health, position, fog masks, and
the credit balance. Iteration order follows the existing `instances` walk
this file already uses everywhere.

None of this becomes an intent. It is sim-internal AI behaviour resolved
identically on every client from synced state — the same category as
`harvesterAI`'s decisions, which are not intents either. CLAUDE.md's "player
actions are data" rule governs *player* actions; no intent constructor is
touched.

## Deliberately not done

- **No coordination between AI teams.** Up to four commanders run fully
  independently and will happily converge on the same target without ever
  acknowledging each other. That free-for-all is the existing design, and
  making them allies is a game-design decision, not a bug fix.
- **No dedicated economy escort.** "Protect the harvesters" is served here
  only insofar as `defense` posture pulls the army home when something near
  home is taking fire. A harvester ambushed at a distant bloom field gets no
  help. A real answer means assigning units to escort duty, which is a
  standing role the army roster has no concept of.
- **`harvesterCap` is still flat at 2 across every difficulty**, and economy
  is still periodic rather than reactive to harvester losses or idle facility
  capacity. The investigation flagged both; neither is touched here. The
  posture layer makes *spending* decisions no smarter — it only makes
  *committing* decisions smarter.

  This turns out to matter more than the investigation implied, and driving a
  match measured it. **On `hard`, across 45 simulated minutes, the AI never
  built a single combat unit** — because every combat unit comes from the
  armed factory (1200cr) and two harvesters deliver roughly 320cr every 90
  seconds against a build order that also wants a repair bay at 2000cr. The
  same run against `main` produced identical numbers to the credit, so this
  predates this change entirely and is not a regression. But it does mean that
  in a default match today, none of the work above ever runs. **The single
  highest-value follow-up is the economy, not the tactics.**

- **A vehicle wedged against terrain with a live order that never ends.**
  Observed at the same coordinates across independent runs. Same family as
  `harvester-collision-avoidance-study.md`'s frozen harvesters, and it wants
  that kind of investigation rather than a patch here.

  The final run shows exactly how far the give-up gets, and where it stops.
  It fires on schedule and hands the unit back — and `_maybeAutoQueue` then
  claims it at 0.15 health, which is that function doing precisely its job.
  From there the unit is off the roster again, now via `inst.repair` rather
  than `_aiRetreat`, and stays there. That is accepted: it is stuck on terrain
  either way, and which subsystem holds the label does not change whether it
  can move. Worth being explicit that this *is* a behaviour change versus
  `main`, where no `committable` notion existed and an auto-queued unit still
  received army orders — two controllers steering one vehicle. Excluding it is
  the right call on its own merits; the cost is that a wedged unit now stays
  subtracted. Prising it back out means clearing `inst.repair` from outside
  the controller that owns it, to no benefit while the vehicle physically
  cannot move.
- **Difficulty still only scales cadence and caps**, never resources or unit
  stats. `ATTACK_STRENGTH_RATIO` and `RETREAT_STRENGTH_RATIO` are the same for
  every tier; a plausible follow-up is making expert commit at a thinner
  margin.
- **Scouting is unchanged** — still a blind widening spiral. The AI now acts
  on what the spiral finds, but does not aim it. Directing a scout at a
  suspected base rather than at the next ring is a separate change.
- **No test observes this in a real match.** The unit tests below are over
  plain objects. See Verification.
- **`itch.io/src/` is not synced.** Per CLAUDE.md it is a deliberate fork;
  flagged so the divergence is a decision rather than an oversight.

## Verification

`tests/ai-posture.test.mjs`, dependency-free, extending the `makeCtx` /
`makeCommander` mock shape `tests/ai-defense.test.mjs` established. Each test
was checked against a negative control — the specific branch reverted, and the
test confirmed to fail for a *behavioural* reason rather than a missing
symbol:

| Test | Negative control | Result |
|---|---|---|
| holds at `mass` inside the strength band | restore the flat `attackAt` headcount gate | 2 fail |
| a retreat is not abandoned at parity | collapse the two ratios onto one value | 3 fail |
| unscouted enemy falls back to `attackAt` | make `_scoutedEnemyStrength` always report `known` | 1 fail |
| a unit under 0.4 health gets `inst.repair` set | drop the threshold to the generic 0.3 | 3 fail |
| a retreating unit is excluded from `committable` | count the full army | 1 fail |
| self-preservation runs in every posture | gate `_maybeRetreat` on `posture === 'attack'` | 1 fail |
| an unaffordable repair does not claim a bay | remove the credits check | 1 fail |
| the strike fires once per enemy team, ever | drop the `_foundEnemyBase` latch | 1 fail |
| a defended base is found but not struck | drop the `_nearbyDefensePower` check | 1 fail |
| home defence outranks the strength comparison | move it below the ratio check | 1 fail |
| `_tryBuildUnit` picks the higher value-per-cost def | restore first-found selection | 1 fail |

Every one of those failed on an assertion about behaviour, not on a missing
symbol. **Two of them failed to fail on the first attempt, and that is the
most useful thing this exercise produced**: the "stay in `mass` after a
retreat" clause and the headcount term on the strength path both turned out to
be unreachable — every input reached the same posture with them deleted. Both
were removed rather than kept as decoration, and the design section above
records why. A branch no control can break is not cautious, it is untested
code that reads as if it does something.

The remaining tests without a control are the ones that *are* controls:
`_tryBuildUnit` with a single candidate (proves the scoring change is
additive), and the four arithmetic tests over `unitPower`/`armyPower`/
`valuePerCost`, which have no branch to revert.

The withdrawal give-up carries its own three: never giving up (the observed
freeze), giving up with no backoff so the health trigger re-fires next tick,
and giving up on a timer regardless of progress. Each fails one test
behaviourally.

Also run: `node --test tests/*.test.mjs` — 197 tests, all passing — and
`npx vite build`.

**Partially verified: the snapshot round-trip.** `serialize()` is exercised
for real and asserted to carry `foundEnemyBaseTeamIds`. The restore half is
one line inside `deserialize()`, which rebuilds a whole world and is not
reachable from a dependency-free test; it was read, not run.

**Not verified: online multiplayer.** The determinism argument above is
reasoning, not a test. `tests/e2e/`'s two-client match test is the only check
in the repo that can observe a lockstep split-brain, and it was not run for
this change.

### Driven in a real match

Headless Chromium against the dev server, `Multiplayer AI` on `hard`, sampling
each commander's posture and roster every simulated minute. Four runs, and each
one changed the code — the long-leg fix, the `_maybeAutoQueue` carve-out and
the withdrawal give-up all came out of watching this, not out of reading.

Confirmed observed:

- `economy` → `mass` → `attack`, in that order, driven by the strength ratio.
- Strength reported as unscouted until the fog actually revealed the enemy,
  then real numbers on both sides (e.g. `11839v943`).
- Units pulled off the line at the AI threshold and marked withdrawing.

Not observed, and therefore **not verified beyond the unit tests**:

- **The opportunistic strike never fired in any run.** No scout ever revealed
  an enemy base within 45 minutes — `_foundEnemyBase` stayed empty throughout.
  The latch, the defence check and the retarget are covered by tests over
  plain objects only. Given that scouting is unchanged and the economy stall
  above, this is unsurprising; it is still untested in situ.
- **A completed heal.** Every withdrawal observed ended in the terrain wedge
  rather than at a bay, so the hand-off into `repairController` at
  `TERMINAL_RADIUS` and the return to the roster on full health were never
  seen end to end in a match.

**Not verified: that any of this makes the AI more fun to play against.** There
is no automated harness for full-match behavioural comparison and no baseline
recording of the old AI to compare against.
`harvester-collision-avoidance-study.md` exists precisely because that kind of
claim needs a measured before and after; this change does not have one.
