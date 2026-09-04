# The hamburger menu shows every world-authoring control mid-skirmish

## The report

> "In online and ai multiplayer. Only make (high quality shadows), sound and
> camera accessible in hamburger menu"

## What was there

`buildSchema()` (`src/ui/controlSchema.js`) already had a `simState()` wrapper
that *disabled* individual controls writing simulation state during an
**online** match — `simState()`'s own comment explains why: a scrubbed sun
changes `cycle.phase`, which changes crystal regrowth, and the peer has no way
to learn about any of it, so the other client silently diverges. Regenerating
terrain is worse — every spawn point is derived from the heightmap.

Two gaps against the report:

- `simState()` only checked `game.mode === 'multiplayer-online'`. Vs-AI never
  desyncs anything (there's no peer to diverge from), so locking those
  controls there was never the concern — but the report asks for the same
  *visibility* restriction in both modes, not just online. A player mid-match
  against an AI commander has just as little reason to be re-shaping the
  terrain or auditioning day-length as one playing another person.
- `locked: true` only disables a control's input elements — the row, its
  label, its slider still render, just greyed out. Nine groups of terrain,
  atmosphere, ground, water and account/save controls were still fully drawn
  in the drawer, most of them not even locked (only some Atmosphere/Terrain
  shape controls used `simState()` — Ground, Water and most of Game/debug
  never did, since those never touch simulation state, only rendering
  uniforms). The report's ask is coarser than what existed: hide those groups
  outright, not merely grey out the subset that happens to write sim state.

## The fix

`isSkirmishMode(game)`, exported from `controlSchema.js` — true for both
`multiplayer-ai` and `multiplayer-online`, the same "multi-team match on a
shared island" condition `main.js`'s own (unexported) `isSkirmish()` already
uses for other purposes. Duplicated rather than imported, matching this
codebase's existing convention of checking `game.mode` directly per-file
(`statisticsScreen.js` already does the same for its own online-only branch)
rather than introducing a shared module for one boolean.

`buildSchema()` filters its returned group list down to `['Performance',
'Camera', 'Sound']` when `isSkirmishMode(game)` is true. Everything else —
Account, Save/Load, Atmosphere, Terrain shape, Ground, Water, Game/debug —
disappears from the drawer entirely rather than showing locked. `simState()`
and its per-control locking are untouched: they still guard the online-only
desync case for anyone reaching those controls through some future path (e.g.
a debug build), and they are now redundant-but-harmless for the groups that
are hidden outright.

The chooser's "World Settings" hint text — "Terrain, atmosphere, camera" —
would have been actively wrong once those first two are gone. `Menu` now takes
the live `game` object (previously it only got `isMatchActive`/`onCloseGame`
closures) purely to read `.mode` for this string, and shows "Shadows, camera,
sound" in a skirmish instead.

## Files

- `src/ui/controlSchema.js` — `isSkirmishMode` export, `SKIRMISH_VISIBLE_GROUPS`,
  the filter on `buildSchema()`'s return.
- `src/ui/menu.js` — `game` accepted in the constructor's options, used only
  for the chooser hint.
- `src/main.js` — one line, passing `game` into the existing `new Menu(...)` call.

## Verification

`tests/skirmish-menu-restriction.test.mjs`, dependency-free: `buildSchema()`
only builds closures at construction time (no `get`/`set` is ever *called*
while assembling the group array), so it can be driven with minimal stub
`world`/`view`/`game` objects rather than a real three.js scene. Covers:

- `isSkirmishMode` true for both multiplayer modes, false for sandbox/undefined/null.
- Sandbox still sees all nine groups (unrestricted, matching a backend-less
  build with `__API_URL__` unset).
- Both skirmish modes show exactly `['Performance', 'Camera', 'Sound']`.
- Performance's one remaining control is still exactly "High-quality shadows".
- Camera's and Sound's own control lists are byte-identical between sandbox
  and a skirmish — the fix hides *groups*, not controls within a kept group.

**Negative control**: reverted the filter (`return groups;` with no
`isSkirmishMode` branch) and re-ran — 4 of the 9 tests failed, exactly the
ones asserting the restriction itself; the sandbox and per-control-list tests,
unaffected by the revert, kept passing. Restored, all 9 green again.

**Live browser**, `npm run build` + Playwright against the dev server:

| Mode | `#panel-body .group summary` titles |
|---|---|
| Sandbox | Save / Load, Performance, Atmosphere, Terrain shape, Ground, Water, Camera, Sound, Game / debug |
| Multiplayer AI | Performance, Camera, Sound |

Chooser hint under "World Settings" read "Shadows, camera, sound" in the
Multiplayer AI run. (Multiplayer Online was not driven live — it needs a real
signed-in second client — but it shares the exact same `isSkirmishMode()`
branch as Multiplayer AI, already covered above by both the unit tests and
this live run.)

`npm test`: **573 passing** (564 before this change, 9 new), dependency-free.
Root and `itch.io` builds both pass.
