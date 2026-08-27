# Harvesters now route around structures instead of through them

## The report

"All harvesters must find a track around military vehicle depot and repair
bay, to and from harvester depot" — harvesters were driving straight through
buildings on their way to and from crystal fields.

## The root cause

Confirmed via two read-only investigations before any code changed: **no
structure of any kind was ever registered as a pathing obstacle anywhere in
the codebase.** `src/core/navGrid.js` — the one system that already does
"go around an obstacle" routing, built specifically because army units used
to converge on a blocked pocket and never meet — computed passability purely
from terrain grade. `harvesterAI.js` drove every leg with a single
straight-line `inst.setTarget(dest.x, dest.z, heightmap)` and never consulted
NavGrid at all; only `aiCommander.js` (army units) did. This wasn't a
regression — the feature had never been built for harvesters, or for
structures at all.

## The fix

Extended the existing NavGrid rather than inventing new pathfinding, and
wired `harvesterAI.js` into it the same way `aiCommander.js` already is.

**`src/core/navGrid.js`** — now takes an optional `structures` reference and
rasterizes each standing structure's circular `footprint` (already in
`STRUCTURE_CATALOG`, radius 13 for `harvester-facility`, `armed-factory`, and
`repair-bay` alike) into the passability grid. A `structuresVersion` counter
on `StructureController` (bumped on build/rebuild-from-save/destroy) drives
the same staleness check `heightmap.terrainVersion` already does, so a
building appearing or disappearing mid-match invalidates cached routes.

**The design mistake caught before it shipped, worth recording:** the first
version exempted a structure's own *home cell* from its own footprint at
*build* time, reasoning "a structure must never block routing to itself."
Tracing the actual geometry killed that approach: `footprint` (13) is smaller
than half a grid cell (`CELL_SIZE` 24), so the rasterization circle can
*never* reach a neighboring cell's center — a build-time home-cell exemption
would have exempted the *only* cell a structure this size can ever mark
impassable, silently disabling the entire feature for every structure the bug
report named. Verified directly: with the exemption at build time, a
structure dead-center in its cell blocked exactly 0 cells.

The correct fix moves the exemption to **solve time** instead: `_edgeCost`
takes the query's own `goalCell` and allows entry into it regardless of
`_passable`, while every other cell (including a structure's home cell, when
it isn't the goal) blocks normally. This is what actually satisfies "never
blocks routing to itself, but still blocks routing through itself for
everyone else" — the first version only achieved the first half, and did it
by disabling the whole mechanism to do so. A second array,
`_terrainPassable`, was added to keep this from also silently accepting an
underwater goal: it's used only for `nextWaypoint`'s upfront goal-validity
check, so "structure sitting there" and "water sitting there" stay two
different, correctly-handled cases instead of collapsing into one.

**`src/main.js`** — `navGrid` used to be constructed at the bottom of the
file, well after `harvesterAI`, so it was never available to pass in. Moved
its construction earlier (it only depends on `heightmap`/`structures`, both
already built), passed into `HarvesterAI`'s constructor alongside its
existing dependencies.

**`src/vehicles/harvesterAI.js`** — added `_advanceViaNavGrid(inst, s, dest)`,
mirroring `aiCommander.js`'s `_advanceUnit` exactly, including its stall
handling: if the same waypoint comes back twice in a row (NavGrid's cells are
coarser than the fine-grained slope probe `driveToTarget` actually steers by,
so a hidden local bump can produce a deterministic repeat), fall through to
driving the real destination directly, the same safe degrade as when NavGrid
has nothing to offer at all.

This is a wrapper around the existing `_order`, not a change to it —
`_order` stays the simple "drive to this point" primitive `_onAbandoned`'s
local escape fan also calls directly with its own short local point, which
has no business consulting a global router. Only the calls aiming at a real
destination (`_idle`'s fresh field order, `_retargetInFlight`, and
`_travel`'s own re-aim once a local detour waypoint is reached) route through
`_advanceViaNavGrid` instead.

The new `s.navWaypoint`/`s.navStallCount` fields are deliberately **separate**
from the existing `s.waypoint`/`s.detours` (the local escape-fan state).
`_onAbandoned` treats `s.waypoint` truthy as "already tried a local escape"
and reverses immediately on the next abandonment — and a NavGrid step is
almost always truthy on any leg longer than one ~24-unit cell. Reusing the
same field would have made ordinary multi-cell travel indistinguishable from
"already failed once," changing that escalation for the worse on every
routine trip.

## Verification

**`tests/nav-grid.test.mjs`** (new, 11 tests) — dependency-free, plain mock
heightmap/structures objects matching NavGrid's actual constructor shape.
Covers: routing around a structure on the direct line, routing being
unaffected with no structure present (the control), a bigger hypothetical
footprint blocking more than one cell (the real catalog footprint never
does), a route successfully ending at a structure's own position, that same
exemption *not* opening a through-shortcut for someone else, an underwater
goal still being rejected, `structuresVersion` staleness in both directions
(built and removed, each with its own negative-control-style companion test),
a dead-but-still-in-the-array structure not blocking, and backward
compatibility with no `structures` reference at all.

One coordinate subtlety cost real time and is documented in the test file
itself: this grid's cells center on `…,-12, 12, 36,…`, so an "unobstructed
straight line" test written against `z=0` fails — not because of a bug, but
because `z=0` sits exactly on a cell boundary and the returned waypoints
legitimately settle on whichever row straddles it. Every coordinate in the
final test file sits on an actual cell-center row specifically to make
"detoured or not" unambiguous rather than fighting quantization noise.

**Three negative controls**, each a surgical string replacement (never `git
checkout`, which has clobbered uncommitted work in this repo before), each
confirmed to fail for a specific, correct reason, then restored:

| Reverted | Test(s) that failed |
|---|---|
| the `goalCell` exemption in `_edgeCost` | "a route can still end at a structure's own position" |
| the entire structures-blocking loop in `_build` | 5 tests — every test that depends on a structure actually blocking anything |
| the `structuresVersion` check in `_refreshIfStale` | both staleness tests (built-and-missed, removed-and-still-blocked) |

**End-to-end browser verification** (Playwright, headless Chromium, the real
built bundle — not a mock): placed a harvester facility and a `crystal-
harvester` directly via the same APIs the game itself uses (sandbox starts
with neither), placed an `armed-factory` dead center on the straight line
between the facility's dock and the nearest crystal field, then let
`harvesterAI`'s ordinary update loop run unmodified and sampled the
harvester's real driven position every 0.5s. Result: closest approach to the
placed structure was **19.2 units** against its **13-unit** footprint radius
— it never entered the footprint — and the sampled path visibly bows away
from the structure's position rather than running straight through it,
continuing to make steady progress toward the field (still closing distance,
no oscillation or stall) throughout the full 45-second sample window. Zero
page errors.

The sample window ended before the harvester actually arrived and started
filling — a real gap in this verification, not a claim of full arrival. The
detour adds real distance, and 45 real-time seconds wasn't enough headroom on
top of that at the harvester's drive speed. What's demonstrated is the part
this change actually touches (does it detour, does it keep making progress
while doing so) rather than the full round trip end to end.

`npm test` — 354 pass, 0 fail (11 new). `npm run build` passes.

## Not verified

- **Full arrival at the field.** See above — the browser check confirmed
  detour behavior and continuous progress, not the completed round trip.
- **Army units in a live match.** `aiCommander.js` shares this exact NavGrid
  instance, so its routing is now also structure-aware — plausibly a welcome
  side effect, since army units walked through buildings too, but this was
  not separately confirmed against a live AI-vs-AI match. The unit-level
  tests that already exist for `aiCommander.js` were unaffected (`npm test`
  stayed green), which covers its own logic but not an integration check of
  "does the shared grid still behave for two very different consumers at
  once" beyond what's implied by both working independently.
- **A cluster of adjacent structures forming an unreachable pocket.** The
  header/comment calls this out as an accepted coarse-grid edge case rather
  than something this pass tries to solve: two buildings placed close enough
  to share a grid cell could still shadow each other. Not reproduced or
  measured — footprint (13) vs cell size (24) makes it unlikely for the named
  structures specifically, but a denser custom base layout could hit it.
- **Multiplayer determinism.** NavGrid's Dijkstra solve is a pure function of
  shared state (heightmap, structure positions, a version counter) and
  produces render-side waypoints only — nothing here writes simulation state
  directly, so it should carry the same determinism guarantee `aiCommander`'s
  existing use of it already has. Not independently re-verified against
  CLAUDE.md's determinism rules beyond that reasoning.
