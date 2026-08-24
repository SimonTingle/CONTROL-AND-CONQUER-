# Tracked vehicles in the catalog, forward-driving intelligence, and vehicle sell

## Context

Follow-up to the AI driving-fixes work (`ai-driving-fixes.md`): with those ten
defects fixed and 237 tests passing, a re-run still showed vehicles spending
real time driving backwards on the way to a destination. Investigating that
found two things, not one:

- The detour ladder both `harvesterAI.js` and `repairController.js` fall back
  to after a failed direct route ends in a backward-facing angle —
  `harvesterAI`'s `DETOUR_ANGLES = [0.9, -0.9, 1.6, -1.6, 2.4]` puts its last
  three entries at 92°, 92° and 138° off the direct bearing, all of which a
  wheeled vehicle can only reach by reversing into them.
- `tracked-vehicles.md` (this repo's earlier work) built a complete second
  steering model — pivot-in-place via `pivotRate`, independent of forward
  speed — but **no catalog entry ever set `shape.tracked: true`**. The engine
  that could have avoided the backward-angle problem for at least some
  vehicles has been sitting unused since it shipped.

The user's request tied both findings together: ship real tracked vehicles
(pricier, steeper-climbing), and specifically make *tracked* vehicles prefer
forward motion, because a vehicle that can pivot to face any bearing without
moving never needs to be sent toward a reverse-only detour angle in the first
place. Four more requests rode alongside it: a heavy tank with a dusk/night/
dawn flare ability, and a sell command for every vehicle (not just deployed
defenses, which already had one — see `ai-defense-and-sell.md`), priced by
age and condition with a kill bonus for combat vehicles.

## What was built

### Three new catalog vehicles (`src/vehicles/catalog.js`)

- `tracked-harvester` — double `crystal-harvester`'s cost (1200 vs 600),
  identical `capacity`/`fillRate`/`unloadRate` (the tradeoff is mobility, not
  a bigger or faster haul), `maxClimbGrade: 0.85` versus the wheeled
  harvester's 0.62 and every other wheeled vehicle's ceiling (scout-buggy's
  0.8 was previously the highest in the catalog).
- `tracked-tank` ("Tracked Light Tank") — double `gun-platform`'s cost (1300
  vs 650), identical turret stats (damage/range unchanged — cost buys
  mobility, not firepower), same 0.85 climb grade.
- `heavy-tracked-tank` — 3× `tracked-tank`'s cost (3900), heavier stat block
  (700 health vs 400, 40 turret damage vs 22), same climb grade, and carries
  the new flare command.

All three set `shape.tracked: true` plus `pivotRate`/`dims.roadWheels`/
`dims.trackWidth`/`dims.trackThickness`, following the exact fields
`builderSchema.js` already exposes for author-built tracked vehicles.
`maxSteerAngle`/`steerRate` are kept even though tracks don't steer by wheel
angle — `applySteering`'s tracked branch (`vehicleController.js:418-427`)
still normalizes its pivot demand against `maxSteerAngle` and paces it with
`steerRate`, so dropping them (as an earlier draft of this plan assumed) would
have been wrong; confirmed by reading the method before writing the defs.

Wired into `harvester-facility.produces` and `armed-factory.produces`
(`src/structures/structures.js`). The tracked combat units were appended
*after* `field-engineer` rather than immediately after `gun-platform` as
first drafted: `produces` order is the AI's own build-preference tie-break
within one structure (see its comment at that array), and inserting a
1300/3900cr unit ahead of the 300cr field-engineer would have shifted what
the AI prefers to build by default. Appending last keeps that preference
exactly as it was.

### Forward-driving intelligence (the actual fix for the original complaint)

Two independent gates, both keyed on `inst.tracked` (already cached on every
`VehicleInstance` — `vehicleController.js:110`):

1. **`vehicleController.js`'s sharp-turn escape.** Previously, any vehicle
   misaligned past `SHARP_TURN_ANGLE` (~110°) called `beginReverse` for a
   three-point turn. A tracked vehicle now skips that call entirely: forward
   speed is zeroed and `applySteering` is driven directly, which for a
   tracked def turns the hull in place via the pivot-rate path with no
   forward or backward travel at all. The blocked-slope reverse
   (`BLOCKED_REVERSE`, genuinely unclimbable terrain ahead) is untouched for
   every drivetrain — backing off is still the only way to unstick from an
   obstacle no amount of turning clears.
2. **The detour ladders in `harvesterAI.js` and `repairController.js`.**
   Added a `TRACKED_DETOUR_LIMIT = Math.PI / 2` cutoff: a tracked vehicle
   never gets waypointed toward a detour angle at or past 90° off the direct
   bearing, and immediately advances to the next candidate instead. For
   `harvesterAI`'s five-angle ladder this leaves only the first two (±0.9 rad,
   ~52°) reachable before falling through to the existing "out of detours"
   escalation — a deliberate narrowing, not a bug, since the whole point is
   that a tracked vehicle has no forward-facing use for the angles being
   skipped. The `_onAbandoned` reverse call in `harvesterAI` (triggered when
   already mid-detour or genuinely blocked) is also skipped for tracked
   vehicles — they retry immediately with the next detour angle instead,
   relying on the pivot fix above rather than a physical back-off.

### Universal vehicle sell (`src/vehicles/commands.js`)

`ai-defense-and-sell.md` already gave deployed defenses (`gun-turret`,
`sensor-tower`) a health-scaled sell refund via `SELL_COMMAND`/`sellRefund`.
That formula (`cost * 0.5 * healthFraction`) has no age term, which is fine
for an immobile defense but wrong for a vehicle that might be sold the
instant it spawns or after driving the whole match. `vehicleSellRefund` adds
one: an exponential decay from 1.0 toward a 0.6 floor over a 3000-tick
half-life, read from `simClock.tick - instance.createdAt` (both already
sim-tick fields — no new state). Combat-tagged vehicles get a flat +15cr per
confirmed kill (`instance.kills`, already tracked and incremented in
`combatController.js`) on top of the age/condition value. Wired into the
`idle`-equivalent (`mobile`/`armed`) command list of every vehicle def,
`base-station` excluded on the same reasoning `repairController.js` already
excludes it from auto-repair — it isn't a disposable field unit.

### Flare command (`heavy-tracked-tank` only)

Gated to dusk/night/dawn using the identical elevation read
`headlightsWanted()` already performs in `main.js`
(`world.atmosphere.params.elevation`), just against a wider threshold (12,
matching `atmosphere.js`'s own dusk-blend zone) so dawn and dusk both count,
not only "past the headlight cutoff." Fires at the tank's current
`combatTarget` (reusing `SELECT_TARGET_COMMAND`'s existing field rather than
building a second targeting mechanism) and calls
`team.fog.reveal(x, z, 60)`.

**Deliberate scope decision, not an oversight:** `FogMask.reveal()`'s own doc
comment states the reveal is permanent — "reveal a disc of ground
permanently," `max(prev, v)`, never decremented (`core/fogOfWar.js:202-263`).
There is no timed/decaying reveal primitive anywhere in the engine. Building
one just for this command would have meant inventing a second kind of fog
state; instead the flare acts as a (permanent) forced scout of the target's
surroundings, which is what the one reveal primitive that exists can
actually do. If a genuinely temporary reveal is wanted later, that is new
fog-of-war infrastructure and belongs in its own plan.

The visual reuses the existing tracer pool (`showTracer`/`updateTracers`,
`main.js:1256+`) rather than a second pooled-mesh system — `showFlare` calls
`showTracer` with the target's position and a synthetic high-elevation
endpoint (140 units up) and a slow speed (60 u/s vs the default 160), so it
reads as something rising and holding rather than snapping across like a
shot.

## Known, deliberately unaddressed side effect

`aiCommander.js`'s `_tryBuildUnit('economy', harvesterCap)` caps *per unit
id*, not per tag — a decision already made and documented in
`ai-driving-fixes.md`'s Fix 4, which explicitly notes "two harvester types
currently yields 4 harvesters instead of 2" as a known quirk deserving its
own balance pass, not a bug to silently fix inside an unrelated change. Adding
`tracked-harvester` as a second `economy`-tagged, `harvester-facility`-produced
unit means an AI team can now build up to 2 wheeled + 2 tracked harvesters
under the existing cap — the same quirk, now with one more unit id that can
trigger it. Not fixed here for the same reason it wasn't fixed in the prior
plan: changing `economy`'s cap semantics changes AI income for every
existing team, in a change that isn't about AI economy tuning.

## Verification

- `node --test tests/*.test.mjs`: 253 passing (up from 237), including
  `tests/tracked-vehicles.test.mjs` (catalog sanity, the pivot-vs-reverse
  sharp-turn gate, and the detour-ladder forward-hemisphere filter — each
  with a negative control proving the wheeled path is unchanged) and
  `tests/vehicle-sell.test.mjs` (refund formula: fresh/full-health,
  half-health, the age floor, the kill bonus, and a negative control proving
  the kill bonus is tag-gated rather than triggered by the field's mere
  presence). Two pre-existing tests in `tests/tracked-vehicle.test.mjs` that
  asserted "no shipped vehicle is tracked" were updated to assert the new,
  correct invariant (exactly the three `tracked-*`/`heavy-tracked-tank` ids
  are tracked) rather than deleted — the premise they pinned is now
  deliberately false.
- `npx vite build` succeeds; no new warnings beyond the pre-existing
  500kB-chunk notice.
- **Not verified in this pass:** a real-browser playtest of the pivot
  behavior, the flare's visual arc, and the sell price display in the radial
  menu — no automated harness exists for full visual behavior (same gap
  every prior UI-facing plan in this index records). The formulas and gating
  logic are unit-tested directly; the rendering is not.
- **Not verified:** online multiplayer. New defs and commands read/write only
  already-synced state (`health`, `kills`, `createdAt`, `combatTarget`,
  `produces` lists) with no new `Math.random`/`Date.now()`/`performance.now()`
  — but that is reasoning, not a two-client `tests/e2e/` run.

## Deliberately not done

- No rebalancing of `crystal-harvester`/`gun-platform`'s existing stats to
  compensate for the new tracked options entering the economy — this only
  adds choices, it doesn't touch what already shipped.
- No `reconCap`-style fix for the AI's per-id economy cap noted above.
- No temporary/decaying fog reveal — see the flare section above.
- No UI change to the radial menu itself: `hint()` already renders as the
  price line under any command (`radialMenu.js:88-89`), so the sell price and
  flare's disabled-reason string need no new rendering path.
