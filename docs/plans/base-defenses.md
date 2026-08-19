# Base defenses: a gun turret, a sensor tower, and how they get placed

## Context

A skirmish RTS without base defense is missing the thing C&C players reach for
first. This adds two emplacements and the means to put them somewhere useful.

The design was decided by one constraint found while planning: **structures can
only be placed inside the base pad.** `canPlaceAt` requires a structure's whole
footprint within a radius-40 disc which, with `footprint: 13` and a ×1.6
overlap rule, realistically holds two or three buildings. Roof-mounted turrets
or ordinary placement could therefore only ever defend the pad's *interior* —
no perimeter, no chokepoints, which is most of what defense is for.

So defenses arrive by driving there. Precedent already existed: the base
station deploys itself, and `power-spire` is placed on open ground through
`placeAt()`, which runs no pad check at all.

## What was built

**A shared turret rig** (`src/vehicles/turretRig.js`). `updateTurret`,
`turretBearing` and the turret+barrel mesh were lifted out of `VehicleInstance`
and `buildVehicleMesh` — not copied. They were already free of movement,
suspension and physics; they touch only a mesh's local rotation, a mode flag, a
desired bearing and the host's heading. Both the vehicle and the emplacement
now delegate, so a turret cannot start behaving differently depending on what
it is bolted to.

**Two structures.** A gun turret carrying the same `turret` block a vehicle
uses, and an unarmed sensor tower whose entire contribution is `sightRadius` —
which already feeds the fog mask, so it needed no new machinery at all and
pairs directly with the minimap added just before it.

**A field engineer** that drives out and deploys one, and is consumed doing it.
That is what makes placement a commitment rather than a free sprinkle of
turrets, and it is why the cost sits on the vehicle rather than being charged
again at deploy time. It is deliberately unarmed, so escorting one is a real
decision.

**One change to combat.** `CombatController.update` read only
`vehicles.instances` for *shooters*. Structures were already valid *targets*
(`_candidates` has always yielded them), so an emplacement would have sat there
aiming at nothing. `_shooters()` now concatenates turret-bearing structures.
Everything else — acquisition, the arc and line-of-sight gates, firing, the
threat memory — worked unmodified, because a structure carries `group.position`,
`heading`, `mode`, `def.turret` and `teamId` under exactly the names the loop
already used. `_candidates` also gained a `s !== inst` guard: without it a
turret could acquire itself.

## Decisions worth recording

**No new intent type.** The obvious move was a `deployDefense` intent, and it
was written and then removed. A radial command already crosses the wire as a
`cmd` intent, which every client resolves through `commandsFor` and executes
identically — the same route the base station's own `deploy` takes. A bespoke
intent would have been redundant wire format, and per `CLAUDE.md` intent shapes
are the one thing peers on different builds cannot detect a mismatch in.

**Emplacements finish into `armed`, not `idle`.** For a vehicle, arming is a
deliberate act that costs mobility, so `combatController` requires it. A turret
has no other job and nothing to trade away; leaving it `idle` would have built
a gun that never fires and given the player no control that would change it.

**Defenses are tagged `defense`, never `production`.** `aiCommander`'s
`BUILDABLE_DEFS` picks structures tagged `production`/`repair` and builds them
on the base pad — a defense there would be placed by the wrong mechanism
entirely. A test pins this.

## Two bugs found by actually placing one

- **`onComplete` never fired for a defense.** `StructureController.update`
  tested `wasBuilding && mode === 'idle'`, and an emplacement finishes into
  `armed`. It now tests `mode !== 'building'`, so any completion transition
  fires the hook rather than only the one that existed when it was written.
- **New mesh builders forgot two required `userData` keys.**
  `StructureInstance.update()` dereferences `buildRing.visible` and iterates
  `shadowCasters` on the very first tick, so a builder missing either throws
  the instant the building is placed. Both are now set through one
  `addBuildRing()` helper rather than three hand-written copies. Only reachable
  by placing a structure, which is exactly how it was found.

## Verification

- **`tests/base-defense.test.mjs`** (14 cases, dependency-free — the rig
  operates on a plain host object, so no renderer is involved): a turret
  rotates toward its target but no faster than `rotationRate`; it cannot point
  outside its own arc; it scans when it has no target and stows when disarmed;
  the bearing folds in the host's heading (which is what lets a fixed building
  report a bearing it is actually pointing at); a host with no turret mesh is a
  no-op rather than a crash; both defenses are tagged so the engineer offers
  them and neither is tagged `production`; the gun turret's turret block is
  complete; the sensor tower is unarmed and outranges every unit's vision; the
  engineer is unarmed; and every structure def carries the blocks its mesh
  builder reads.
  **Negative controls:** removing the arc clamp failed exactly the arc test;
  dropping the heading from `turretBearing` failed exactly the bearing test.
  Both restored.
- `node --test tests/*.test.mjs`: **100/100**. `npx vite build` succeeds.
- **Driven in a real browser**, stepping the simulation directly with
  `window.__step` rather than waiting on wall-clock — headless Chromium
  throttles `requestAnimationFrame` to roughly 11% of real time, which is the
  same effect `online-multiplayer-mutual-stall.md` is still investigating:
  - A placed turret finishes construction into `armed`, acquires an enemy, and
    took a gun platform from **400 → 220 HP in 12 sim-seconds** — 8 shots at
    its stated 20 damage on a 1.5s interval.
  - Over 45 sim-seconds it **killed** the target and credited itself the kill.
  - A sensor tower placed in unexplored ground took the revealed fog from
    **818 to 3024 cells**.
  - Both meshes render (screenshotted), and no page errors occurred.

Not verified: an actual player driving an engineer out and using the radial
menu to deploy — the command's `execute` was not clicked through the UI, only
its constituent pieces (`placeAt`, `queueDestroy`) exercised directly. Also
unverified in an online match.

## Deliberately not done

- **The AI never builds defenses.** `aiCommander` produces units by tag
  (`economy`, then `combat`) and the engineer is tagged `support`, so it will
  not buy one; and it has no notion of driving somewhere to deploy. An AI that
  fortifies is its own piece of work.
- **Terrain ramparts**, the fourth item on the defense roadmap, are not here.
  They remain the right approach — raised terrain blocks for free because
  `readGrade` refuses the slope and `navGrid` re-solves on the `terrainVersion`
  bump `terraform` already emits — but they share nothing with the turret work
  and are better as their own change.
- **Selling or repacking a deployed emplacement.** Once placed it is permanent
  short of being destroyed.
