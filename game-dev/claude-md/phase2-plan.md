# Plan: Phase 2 — AI opponent teams, combat, and elimination

> **STATUS: COMPLETE.** All five sub-phases shipped and pushed.
> `7b7ad77`+`63613c4`+`6caaf9f`+`f2a46f0`+`9b7b99a`+`bb6808d` (2A),
> `468ab7e` (2B), `2200f27` (2C), `82763e3` (2D), `f45f60d` (2E).
>
> Phase 1 (portal + mode routing + save/load stubs) merged earlier at `e9e213e`.
> Phase 3 (accounts/save-load backend) and Phase 4 (online multiplayer) remain deferred and unplanned.
>
> **Carried forward — known limitations, not defects:**
> - **Army units have reactive detours, not pathfinding.** They fan out on widening
>   angles when blocked (which stopped them grinding to ~100/400 health), but cannot
>   reliably cross an arbitrary island, so unattended AI armies often fail to meet on
>   rough maps. Combat itself is verified whenever units are in range with line of
>   sight. A navmesh or flow-field would fix it properly.
> - **AI economy is slow to reach combat.** At default settings an AI team needs
>   roughly 10+ minutes of simulated time to afford its first gun platform (900 cr).
>   Worth a balance pass if AI matches should turn violent sooner.
> - **Wreckage accumulates permanently** and is never disposed. Fine for a match;
>   would need a cap or fade for a very long one.

## Context

The Multiplayer AI mode shipped in Phase 1 is currently a shell: it picks a difficulty, stores `game.aiMatch = {teamCount, buildDelaySeconds}`, and starts an ordinary solo match. This phase makes it real — 1-4 AI-controlled opponent teams that scout, build, fight, and can be eliminated.

The codebase has **no concept of ownership at all**. There is one global `game.credits`, one `vehicles.instances` array, one `structures.instances` array, and a single implicit player. Worse, several lookups are global in ways that actively break with multiple teams: `harvesterAI._facility()` returns the first idle refinery *anywhere*, so harvesters would happily deliver crystals to an enemy base. And **nothing in the game can currently die** — vehicle health floors at 15%, structure `health` is assigned but never read, there is no removal API for a single entity, and nothing in the entire codebase calls `geometry.dispose()`.

So this phase is three separable pieces of work stacked on one foundation: retrofit ownership, introduce an entity lifecycle, then build the AI and combat on top.

### Decisions confirmed with the user

| Decision | Choice |
|---|---|
| Human's role | Keep the **drive-and-fight hybrid** — still drive one vehicle with WASD; turrets auto-acquire; command others via the existing radial menu |
| AI vision | **Fair** — each AI team has its own fog and must scout. No omniscience |
| Destruction | **Permanent**, leaving wreckage |
| Defeat trigger | **Base station destroyed = team eliminated.** No rebuild path |
| Match start | In **Multiplayer AI only**, every team (including the human) starts with a base station — the explore-to-unlock gate is skipped. **Sandbox Test is untouched** |
| Combat units | **Arm the existing scout** + add **one** dedicated combat vehicle |
| Player's vehicle destroyed | **Auto-switch** to their nearest surviving unit; if none, a free scout at their base after a short delay |

Because base-station destruction is now instant elimination and the base station is a *mobile vehicle* with an existing `relocate-base` command, a losing team can literally drive its base away — a nice emergent dynamic that falls out for free.

## Sub-phase ordering (and why)

**2A Teams → 2B Lifecycle → 2C AI brain → 2D Combat → 2E Win/lose.**

The non-obvious ordering is **lifecycle before the AI brain**. `destroy(instance)` invalidates every instance-keyed Map in the codebase (`trafficController._cooldowns`, `harvesterAI.states`, dock reservations, `pad.buildings`, `queueIcons`). The AI brain will add more such Maps. Landing the destroy contract *first* means the AI subscribes to it rather than being retrofitted. 2B needs no weapons — destruction is triggered from a debug key and verified that way.

Conversely, the AI brain does **not** need combat: scouting, economy, and building all exist today.

**Stop for a model checkpoint at the end of each sub-phase** before starting the next.

---

## 2A — Team foundation

*No AI behaviour yet. AI teams exist, own things, and sit there.*

- **New `src/core/team.js`**: `Team { id, name, color, isHuman, credits, earn(), spend(), fog, defeated }`. `game.teams[]`, `game.playerTeam`.
- **Ownership is a numeric `teamId`**, not an object reference — resolved via a `teamOf(inst)` helper. Object refs create cycles that break the JSON serialization Phase 3's save/load will need, and integers are the right key for grouping maps. Add `teamId` to `VehicleInstance`, `StructureInstance`, **and terraform pads**.
- Propagate through `vehicles.spawn(..., {teamId})`, `structures.place(..., {teamId})`, and `produceUnit()` (inherits `facility.teamId`).
- **Replace `game.credits` with per-team credits.** Commands already receive `instance`, so `teamOf(instance).spend(n)` needs no new context plumbing. Call sites: `harvesterAI.js:375`, `repairController.js:108,251`, `commands.js:114,121,216,227,259,268`, plus the HUD's 0.5s-cadence read.
- **Team-scope every global lookup** (these are bugs the moment a second team exists): `harvesterAI._facility()` (`harvesterAI.js:542`), `repairController._nearestBay()`, the duplicate `nearestRepairBay()` (`commands.js:50`), `vehicles.instanceOf()`, and `structures.canPlaceAt`'s base-proximity check (`structures.js:524-531`) — which must become **pad-ownership**-derived, not proximity-derived, or building is exploitable.
- **Split the fog** (`src/core/fogOfWar.js`): shared `FogTerrain` (`cellH`, `landMask`, `totalLand`, `_sampleTerrain`, `_syncSeaLevel`) + per-team `FogMask` (`data`, `revealedLand`, `_last`, optional texture). Only the human team allocates a `DataTexture` — AI masks are plain `Uint8Array`s (~65 KB each). Resolve the existing `_rescan()` coupling (it deliberately computes both counts in one pass) with a **`landVersion` counter**: `FogTerrain` bumps it on sea-level change; each `FogMask` recounts its own `revealedLand` once when its version is stale. Cells that become sea stay revealed — only the denominator moves — or terraform causes spooky re-fogging. **`blooms.js` must explicitly read the *player* fog by name**, not "the fog"; this is a silent bug once four exist.
- **Even spawn spacing**: extract `findEdgeSpawnPointAtAngle(heightmap, angle)` from `findEdgeSpawnPoint` (`src/core/pick.js:91-114` — already angle-driven internally, so this is a trivial parameterization) and place N teams at `i * 2π/N`. Equal compass angles are *not* equal distances on an irregular coastline: verify minimum pairwise separation and nudge angles when two teams land in the same bay.
- ~~**Price the harvester facility.**~~ **Dropped — the risk was not real.** `commands.js:201` gates it with `instanceOf('harvester-facility', teamId)`, capping it at exactly **one facility per team, ever**, so there is no exponential growth to exploit. It is free by necessity: it is the economy bootstrap that ships a team's first harvester while that team still has 0 credits, so pricing it would softlock a team at zero.
- Skip the explore-to-unlock gate in `multiplayer-ai` mode only; `game.mode` (added in Phase 1) already distinguishes them.

**Verify:** start a 4-team match — four bases spawn evenly spaced around the coast, each team's credits move independently, and a harvester only ever delivers to its *own* facility (drive to an enemy base and confirm it is ignored).

## 2B — Entity lifecycle

*Infrastructure only; verified via a debug destroy key.*

- **Two-step destroy**: set `inst.dead = true` synchronously, then `entities.queueDestroy(inst)`. **Flush the queue at exactly one point in the tick** — after `structures.update`, before the fog reveal loop — never mid-iteration.
- **Cleanup ownership**: a small `entities` module holding an explicit **array of `onDestroy(inst)` hooks**, each system registering its own. An explicit array rather than an event bus keeps ordering readable and greppable, matching this codebase's style.
- **Belt and braces, in the style of the existing `_sweepFacilities()` self-heal**: every system also gets a cheap `if (inst.dead) return` guard in its per-instance loop *and* a periodic sweep that nulls dangling references. Hooks handle the common path; the sweep means a missed hook degrades instead of deadlocking.
- **Full cleanup surface** — `trafficController._cooldowns`, `harvesterAI.states` + its facility-keyed `bans`, `inst.repair`, `facility.dockedHarvester` + `_haulQueue`, `bay.dockedVehicle` + `_repairQueue`, `pad.buildings`, `group.userData.selectable`, `queueIcons`, the radial menu's target, `buildPlacementMode`/`harvestSelectMode`, the camera follow target, `checkBaseRepositioning`, and **`vehicles.active`**.
- **Disposal is safe — do it.** I verified `buildVehicleMesh(def)` is called fresh per instance (`vehicleController.js:42`) with every geometry and material `new`'d inside and no module-level cache, so nothing is shared *across* vehicles. Traverse and dispose with a `Set` to dedupe the intra-vehicle sharing (one `wheelGeo` serves four wheels). **Re-verify the same property for structure meshes before disposing those.** This will be the first `geometry.dispose()` in the codebase.
- **Player-vehicle death handoff**: on `vehicles.active` dying, switch to the nearest surviving unit of the same team; if none, grant a free scout at their base after a short delay.

**Verify:** a debug key destroys the hovered entity. Kill a docked harvester mid-unload, a facility with a queue, and the player's own vehicle — confirm no console errors, no orphaned reservations, no stuck queues, control hands off cleanly, and memory does not climb across many destroys.

## 2C — AI brain

- **New `src/vehicles/aiCommander.js`**, one instance per AI team, modelled on `harvesterAI.js`'s hard-won patterns: a per-team state machine, a `retryTimer` global brake, temporary `bans` with expiry that **clear rather than deadlock**, and a periodic self-heal sweep. Read that file's header comment first — its governing invariant (never infer from `hasOrder`, never trust `blocked`; measure your own distance to your own destination) applies to everything the commander orders.
- **Reuse `commands.js` directly** — it is almost entirely headless (`{id, label, hint, enabled(inst,ctx), execute(inst,ctx)}`), and `enabled` returns *a string explaining the refusal*, which is ideal for AI logging. Only three commands are UI-coupled by outcome: the two build commands merely set `ctx.buildPlacementMode` (real placement happens on pointerup), and `target-harvest` sets `harvestSelectMode`. For those, the AI calls `structures.place(def, pad, {x,z})` and sets `inst.targetField` directly — both re-validate internally.
- **Replace duck-typing with explicit catalog `tags`.** Function is currently inferred from shape: `def.unloadRate`⇒refinery, `def.repair`⇒repair bay, `def.produces`⇒factory, `def.turret`⇒combat. Add `tags: ['economy'|'repair'|'production'|'combat'|'recon']` and a `cost` on every entry, and have the commander select **generically by tag and cost**. This is what satisfies the user's standing requirement that *future* units and structures are automatically available to AI teams without touching AI code.
- Difficulty scales the **build-delay** (already collected by the Phase 1 slider) and an **economy/aggression multiplier** — the standard AoE/C&C/SC2 skirmish approach.
- Slot the commander into the tick **between `harvesterAI.update` and `trafficController.update`** — after input is known, before traffic and movement read targets.
- **Stagger AI fog reveals across frames.** The reveal loop is now N× and is the per-tick hot spot; AI fog does not need 60 Hz freshness.

**Verify:** watch an Easy (1 AI team) match unattended — the AI deploys its base, scouts outward, builds a facility, produces a harvester, and its credits climb. Confirm it never deadlocks over a long run, and that its fog reveals only where it has actually driven.

## 2D — Combat

- **Resolve as hitscan, render as a travelling tracer.** At 60-unit range on a 1024-unit map, flight time is ~0.2 s; instant resolution gives deterministic damage attribution and kill credit with no per-frame projectile-vs-entity loop. The tracer is purely cosmetic.
- **Target acquisition** on the existing, currently-unread `turret.range` and `fireArc`, using **`raymarchTerrain()` (`src/core/pick.js:24`) for line of sight** — it already marches the CPU heightfield with adaptive stepping and bisection. Re-acquire every ~0.25 s, staggered by instance index; filter by `teamId !==`, range, and arc; cache the target and drop it with hysteresis (`range * 1.15`) to stop flicker. `rotationRate` finally slews the turret; fire only once angle error is small.
- **Keep `mode: 'armed'` as the capability gate**, not a target-presence flag — it drives `armedSpeedFactor`/`armedSteerFactor`, and coupling those to *having a target* would make the driving feel oscillate as enemies come and go. The existing cosmetic sine sweep (`vehicleController.js:446-457`) becomes the **idle** branch.
- **Remove the 15% floor for weapon damage** (keep it for terrain/collision wear), and wire destruction into 2B's lifecycle. Add wreckage meshes.
- **Convert repair from frozen-lerp to rate-based, in this sub-phase.** Repair currently precomputes `startHealth`/`duration` at dock time and *overwrites* health (`repairController.js:238-270`) — a unit under fire inside a bay would be invulnerable. Cost is also charged upfront, so a vehicle destroyed mid-repair is a credit-sink bug: charge per tick or refund on interrupt.
- **Harvesters flee when attacked** — a new `FLEEING` state gated at the same pre-emption point as the existing `PAUSED` check. Two constraints: stall detection must exempt fleeing exactly as it already exempts `yielding`/`reversing`, and fleeing must not interrupt a dock in progress or it churns reservations.
- **Add one combat vehicle** to the catalog, produced from a facility, with `tags: ['combat']` so 2C's commander picks it up without AI changes.
- Leave `trafficController`'s avoidance cross-team (it reads as collision avoidance, not courtesy), but ensure a dead or fleeing unit cannot hold a `_cooldowns` entry.

**Verify:** drive the armed scout at an AI unit and confirm auto-acquire, LOS blocking behind a hill, damage, destruction, and wreckage. Confirm a harvester under fire flees without corrupting its dock reservation, and that a unit damaged *inside* a repair bay is not invulnerable.

## 2E — Win/lose

- Defeat check: **a team whose base station is destroyed is eliminated** — mark `team.defeated`, and stop its commander.
- Last team standing wins; victory/defeat overlay reusing the **`portalScreen.js` / `difficultyScreen.js` full-screen overlay pattern** established in Phase 1 (not a HUD block).
- Match summary — credits earned, units built/lost, structures built — which pairs naturally with Phase 3's activity logging.
- The HUD updates on a 0.5 s cadence, too slow for combat feedback; health bars and damage flashes need a faster path.

**Verify:** run an Easy match to completion both ways — destroy the AI's base and confirm the victory overlay; let the AI destroy yours and confirm defeat. Confirm a 4-team match correctly eliminates teams one at a time and only ends when one remains.

---

## Cross-cutting risks

- **`vehicles.active` dying** is dereferenced by drive input, camera follow, the radial menu, and `trafficController._isAutonomous`. The 2B handoff must land before 2D makes death routine, or the game soft-locks.
- **Credits refactor blast radius** — ten call sites plus the HUD; easy to miss one and have an AI spend the player's money.
- ~~**Free harvester facility**~~ — investigated and dismissed; it is capped at one per team and is the economy bootstrap (see 2A).
- **Fog reveal cost scales with team count** — stagger it.
- **Structure mesh sharing is unverified** — check before disposing structure geometry, even though vehicles are confirmed safe.
