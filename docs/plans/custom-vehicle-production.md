# Making an author-built vehicle buildable

## The question

A vehicle saved in the editor appeared in the sandbox drawer but could not be
*produced* from a factory. How should one become eligible — and does a
harvester go to the harvester facility, a weapon to the armed factory?

## What was in the way

**`producedBy` had no reader.** Every catalog def carries it
(`crystal-harvester: 'harvester-facility'`, `gun-platform: 'armed-factory'`),
and a grep across `src/`, `server/` and `tests/` found it only in those defs
and the builder's blank draft. It was inert documentation. The live link ran
the other way: each structure lists its units in a `produces` array
(`structures.js:38`, `:86`), which `producedByCommands()` /
`producedNearBaseCommands()` turned into `build-<unitId>` commands.

That direction cannot work for custom vehicles, because a player cannot edit
`structures.js`.

**And the commands are generated at module import.** `COMMANDS` is a top-level
const whose entries *spread* the generated arrays eagerly (`commands.js:454`,
`:459`). So even pushing a custom id into a structure's `produces` at runtime
would have produced nothing: the arrays were built before anyone signed in.

## What was done

`producedBy` became load-bearing for the first time. `producedUnitIds(structureDef, ctx)`
returns the structure's own `produces` list, then any custom def naming it in
`producedBy`. Two callers use it:

- `commandsFor()` appends a generated build command for each custom id the
  static list does not already contain. This is per-call, so it sees whatever
  the player has loaded now.
- `aiCommander._tryBuildUnit` iterates it instead of `s.def.produces` directly
  — otherwise the AI would have been blind to every custom unit, since it
  reads that array raw.

The two near-identical command generators collapsed into one
`buildCommandFor(unitId, { atBase })`, which is what makes generating a
command for a *single* id possible at all. Built-in behaviour is unchanged:
harvesters still spawn at the facility, armed-factory units still queue near
the base.

**Ordering is deliberate.** Custom ids come *after* the built-ins, because
`aiCommander` takes the first produced unit matching its wanted tag that is
under its cap. Appending means a custom vehicle supplements the AI's build
order rather than silently displacing its first pick.

**The online boundary needed no new check.** `producedUnitIds` reads
`ctx.vehicles.extraDefs`, which `applyCustomCatalog()` already leaves empty in
an online match via the fail-closed allowlist in `customCatalog.js`. A custom
vehicle is therefore unbuildable online for the same single reason it is
unspawnable there — there is one boundary, not two that could drift.

## Answering the original question directly

**The author chooses**, via a "Built at" select: Armed Factory, Harvester
Facility, or Not buildable. Inference from turret-or-cargo was rejected as
surprising — a vehicle would land in a factory nobody chose.

But the factory is not what the *AI* selects on: `aiCommander` asks for a unit
tagged `economy`, then one tagged `combat`. So the editor also exposes a
"Role" select writing `tags[0]`. A vehicle built at the harvester facility but
tagged `combat` is legal and will never be bought by an AI as economy — which
is now a visible choice rather than a silent trap.

**Price** was already editable (`cost`); it moved into the new Production
group beside the factory choice, since it now means something.

**Upgrade path**: `unlock` gating only — a select for "From the start" versus
"After exploring", reusing the existing `unlock: 'exploration'` value. Both
progression loops (`main.js`'s `updateProgression` and the skirmish
start-unlocked loop) iterated `VEHICLE_CATALOG` directly and would have left a
custom vehicle locked forever; both now iterate the merged catalog the picker
already maintains.

## Findings not acted on

- **There is no vehicle-to-vehicle upgrade and no tech tree.** Searches for
  `requires`, `prereq`, `tech` turn up nothing. What exists is per-building
  tiers (`upgradeTiers` on the harvester facility and repair bay) and
  team-wide weapon tiers — neither is a vehicle successor chain. Building one
  is a new mechanic, deferred deliberately.
- **Structural prerequisites are hand-written**, inside individual `enabled()`
  bodies on the base station ("Needs a finished pad", "Already built"), not
  data. Making them data is the prerequisite for a real tech tree.
- **Vehicle production is instant on payment.** There is no `buildTime` on
  vehicle defs — only on structures — and no queue. Unchanged here.
- **`role` is read nowhere**, on any def. Left alone.

## Verification

- **`tests/custom-production.test.mjs`** (8 cases): built-ins unchanged when
  there are no custom defs (the regression guard); a custom vehicle appended
  *after* the built-ins, preserving their order; offered only by the factory
  it names; `producedBy: null` offered by nothing; duplicate ids deduped;
  several customs kept in order; a missing controller treated as none; and
  the online consequence pinned so it cannot drift from `customCatalog.js`.
  **Negative control:** making `producedUnitIds` ignore `extraDefs` failed
  exactly the three "custom appears" cases while the four regression guards
  still passed — then restored.
- **`tests/vehicle-def.test.mjs`** (+4): `producedBy` must name a structure
  that actually produces units (the repair bay is rejected, though it is a
  real structure); the two factories and `null` accepted; `unlock` accepts
  only the value the picker understands, since an unrecognised string leaves
  a vehicle permanently locked behind a generic label; a negative price
  rejected, zero allowed.
- `node --test tests/*.test.mjs`: 73/73. `npx vite build` succeeds.
- **Driven in a browser**, against the real bundle and then the dev server:
  - In a real sandbox match, a custom def reaches `vehicles.extraDefs`, the
    picker's catalog, and `vehicles.defOf`.
  - `commandsFor` on an idle Armed Factory returns
    `build-custom:test-tank` with hint `275 cr` — the author's price — after
    the two built-in builds and the weapon upgrade; with `extraDefs` cleared
    the same call returns exactly the original three commands.
  - Executing a custom build with credits: **1 vehicle spawned, credits 1000
    → 725** (exactly the 275 price), on the right team.

One thing this exposed about the harness rather than the product: fabricating
a structure instance kept tripping over *other* built-in commands'
expectations (`baseSpawnAnchor` wanting a real base station, `UPGRADE_COMMAND`
wanting `upgradeLevel`). Confirmed each time that the built-in `build-gun-platform`
failed identically on the same fake, so these were test-setup gaps, not
regressions.

Not verified: the AI actually choosing to build a custom vehicle in a running
Multiplayer AI match. `_tryBuildUnit`'s change is one line and its selection
logic is unchanged, but no AI has been observed buying one.
