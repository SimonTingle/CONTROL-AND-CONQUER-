# A minimap, and two bugs that drew nothing rather than erroring

## Context

The game had no minimap — in a skirmish RTS that is a real gap, since it is
how a player notices an attack at all. Chosen as the first of several
C&C-competitive additions specifically because it touches no simulation state:
`renderTick` is documented as presentation-only, and a minimap reads sim state
and never writes it.

Everything it needs turned out to be CPU-resident already, which is what made
this cheap:

- `FogMask.data` is a plain `Uint8Array(256×256)`; the `DataTexture` merely
  aliases it, so there is no GPU readback. `seenAt(x, z)` is a handful of
  arithmetic ops.
- `FogTerrain.cellH` (normalised height) and `landMask` share that *exact*
  256² grid, so one fused pass produces terrain colour and fog darkness
  together with no resampling.
- The world is centred on the origin spanning ±size/2, so world→map is the
  same `(w / size + 0.5)` expression already inlined in four places.
- Bottom-right was the only free screen corner: `#hud` owns bottom-left, both
  top corners hold drawer toggles, toasts land bottom-centre.

## Design

Two layers on two cadences, mirroring how `main.js` already separates its
half-second stats poll from per-frame work:

- **Terrain + fog raster, half-second.** One pass over 65 K cells into an
  `ImageData`, blitted with `imageSmoothingEnabled = false` — smoothing turns
  the fog boundary into a gradient that reads as "partly explored".
- **Blips and the view box, per frame**, because they move every frame.

Every blip is gated on `isRevealed()`. That is not decoration: without it the
minimap draws every enemy on the map regardless of exploration, which is the
one thing fog of war exists to prevent.

Clicking jumps the camera. This needed care — two camera rigs exist, and while
the chase rig is active `renderTick` forces `controls.enabled = false` *every
frame*, so setting `controls.target` alone would have silently done nothing.
The handler disables chase first, exactly as `setChase(false)` does.

The drawer-shift is published as a `body.drawer-open` class from
`vehiclePicker.setOpen` rather than the picker reaching for the minimap:
anything else anchored to that edge needs the same signal, and CSS owns what
"aside" means.

## Two bugs found by sampling the canvas, not by any exception

Both drew *something wrong* and raised nothing, which is why they are recorded
here rather than just fixed.

**1. Team colours are numbers.** `Team.color` is `0x4fd1c5`, not `'#4fd1c5'` —
three.js takes numbers directly. Assigning a number to a canvas `fillStyle` is
**silently ignored**: the previous style stays in effect. Every blip drew
invisibly. Caught by sampling the pixel under a known vehicle position and
finding `[0,0,0]`. `cssColor()` now normalises, and a unit test pins it.

**2. There is no honest camera footprint to draw.** The view rectangle was
attempted twice and failed twice, for the same underlying reason: with the
camera angled the way an RTS view is, the upper screen corners look at or
above the horizon and have **no ground intersection at all**.

- Raymarching the terrain per corner (`pickTerrain`) returned null for those
  corners, so the all-or-nothing rule discarded the quad and the rectangle
  simply never appeared — verified as 0 stroke pixels on screen.
- Intersecting a horizontal ground plane instead pushed those corners out to
  the map edge, and the "rectangle" rendered as a diagonal streak across the
  entire minimap.

The visible ground in that direction genuinely is unbounded, so no correct
quad exists. It is now a square centred on `controls.target`, sized from the
camera's distance and FOV — an approximation, documented as one, that answers
the question actually being asked ("where am I looking?") and cannot
degenerate.

A third false alarm is worth recording so it is not re-investigated: an early
test reported the raster as entirely black and the minimap as shifted left.
Both were correct behaviour — sandbox opens the vehicle drawer at start (so
the shift was right) and with no vehicle spawned nothing had revealed fog yet
(so black was right).

## Verification

- **`tests/minimap-projection.test.mjs`** (13 cases, dependency-free — the
  geometry is pure functions, so no canvas or DOM): centre and all four
  corners project correctly; the projection **round-trips** (the property that
  makes a click land where the player aimed); out-of-bounds clamps rather than
  wrapping; non-finite input yields a drawable number rather than a NaN
  position that draws nothing; the fog gate hides unexplored blips and treats
  the threshold as a floor; a numeric team colour converts, a string passes
  through, a missing one still yields something drawable.
  **Negative controls:** disabling the fog gate failed exactly the two
  fog tests; replacing the clamp with a wrap failed the corner, clamp and
  non-finite tests. Both restored, 13/13.
- `node --test tests/*.test.mjs`: **86/86**. `npx vite build` succeeds.
- **Driven in a real browser** (Playwright against `vite preview`):
  - Hidden before a match, shown once one begins.
  - The raster tracks fog exactly as territory is explored — lit cells went
    798 → 1608 → 2414 against fog counts of 806 → 1612 → 2418 as a unit moved.
  - The blip pixel under a vehicle reads `[79, 209, 197]`, exactly the team's
    `0x4fd1c5` — the check that caught bug 1.
  - **Clicking at (0.25, 0.75) moved the camera to world (−256, 256)** on a
    1024-unit map — the projection round-trip confirmed end to end — and did
    so *from chase mode*, which is the case that fails if the
    `controls.enabled` interaction is missed.
  - The view box draws (612 stroke pixels at brightness 196, matching a
    0.75-alpha white) and sits correctly bottom-right at 16px inset, shifting
    aside when the vehicle drawer opens.

Not verified: behaviour in an online match specifically. The minimap reads
`game.playerTeam.fog`, which is per-team and correct by construction there, but
no two-client session was run against it. Also unverified at mobile widths
beyond the CSS breakpoint existing — the layout was checked at 1280×720 only.

## Roadmap: base defenses (next, not this change)

Recorded because the investigation behind it is the expensive part:

1. **Deployer vehicle** — the only route to *perimeter* defense.
   `canPlaceAt` requires a structure's whole footprint inside the base pad, a
   radius-40 disc that realistically holds 2–3 buildings, so roof turrets or
   normal placement could only ever defend the pad interior. Precedent exists:
   the base station deploys itself, and `power-spire` is placed on open ground
   via `placeAt()`.
2. **Gun turret** — the cheapest real win. `updateTurret`/`turretBearing` are
   fully separable from driving and work unmodified given `heading`,
   `mode: 'armed'`, `turretAim`, `sweepPhase`, `def.turret` and
   `group.userData.turret`. Structures already have `takeDamage` and are
   already valid *targets*; the one real change is that
   `CombatController.update` scans only `vehicles.instances` for *shooters*.
   The turret mesh block is inline in `buildVehicleMesh` and needs extracting.
3. **Sensor tower** — nearly free; structures already carry `sightRadius`
   feeding the fog mask, which this minimap now renders.
4. **Terrain ramparts, not object walls.** There is **no vehicle↔structure
   collision anywhere** — `advance()` writes position unconditionally and the
   only "can't go there" test is a heightmap slope probe, so a vehicle drives
   straight through the harvester facility today. Object walls would be
   scenery. Raised terrain blocks for free, because `readGrade` refuses the
   slope and `navGrid` re-solves on the `terrainVersion` bump `terraform`
   already emits.

Still absent and worth knowing: no sound system anywhere in the repo, no
infantry tier, no superweapons, and `aiCommander` is a single archetype whose
difficulty tiers vary only speed and caps, not build order.
