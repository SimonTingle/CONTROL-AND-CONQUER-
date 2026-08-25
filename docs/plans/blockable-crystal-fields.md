# Crystal fields had no player-facing control at all

## The problem

Harvester income routed itself entirely by algorithm — `harvesterAI.js`'s
`_idle`, a three-tier `nearestTo` fallback, plus a per-harvester short-lived
`bans` map for retry avoidance after a failed order. The player's only lever
was a one-shot manual order via `harvestSelectMode` (aim one harvester at one
field, once). There was no way to tell your economy "never send anyone to
that field" — useful when a field sits exposed to enemy fire, behind a
contested chokepoint, or you'd simply rather keep it in reserve — and no way
to change your mind later.

## What was added

Double-click a crystal field to open a radial menu with a single
**Block harvesters** / **Allow harvesters** toggle, scoped to your own team.
Blocking stops new assignments — the idle AI's auto-pick and a manual order
alike — but leaves a harvester already en route or already working the field
alone, matching the existing `bans` mechanism's own avoidance-only shape
rather than introducing a second, more forceful kind of control.

## Why a dedicated intent instead of the generic `cmd` pipe

`Intent.command` + `applyIntent`'s `'cmd'` case resolves its instance through
`ctx.vehicles`/`ctx.structures` and re-derives its command list via
`commandsFor`, which is keyed on `COMMANDS[instance.def.id][instance.mode]` —
built for catalog entries. A crystal field has neither. Rather than fake a
def and mode to fit that shape, this follows the precedent already set by
`harvest`, `target` and `move`: a small dedicated intent that mutates state
directly after an ownership check, with no `commandsFor` involved. Two lines
of authorization logic, easy to read in full at the call site.

`applyIntent`'s existing `owns()` helper doesn't apply to `blockField` — there
is no instance to own, only a claimed team id — so the roster check is done
directly against `intent.teamId`, the same pattern `'build'` already uses for
the same reason.

## Picking a field: no new raycasting

Fields are drawn as slices of one shared `InstancedMesh` in `Blooms`, with no
per-field `group`, `def` or `speed` — the shape `pickSelectable`'s raycast and
`RadialMenu.openFor`'s contract both expect. Rather than add real
instanced-mesh raycasting, `openMenuAt` falls back to the exact ground-click
path `harvestSelectMode` already uses to aim a manual harvest order:
`pickTerrain` to a world point, then `world.blooms.nearestTo(point, { requireOnField: true })`,
whose `PICK_MAX_FACTOR` is already tuned so a click on bare ground finds
nothing rather than snapping to whatever field is nearest the miss. The
fallback only runs when `pickSelectable` finds no vehicle or structure, so a
vehicle standing on a field still wins the double-click.

`RadialMenu.openFor` still needs something instance-shaped, so a small
wrapper (`fieldMenuTarget` in `main.js`) is built on the fly when the menu
opens — never stored, never a second entity system. Its `dead` is a live
getter over the real field record rather than a value captured at open time:
a base pad poured over the field while its menu is still open has to close
it, the same as `entities.onDestroy`'s `radialMenu.instance === inst` check
does for every vehicle and structure. Fields never go through that pipeline
(they aren't in `entities`), so the equivalent check is one explicit line next
to the existing `radialMenu.update()` call in the render tick, rather than
teaching `RadialMenu` itself about a kind of instance it otherwise never
handles destruction for.

## Persistence and the state hash

Field mutable state (`stock`, `dead`, etc.) was not previously serialized at
all — `snapshot.js` only ever resolved fields by id as cross-references for
other things (a harvester's `targetField`, a ban). `blockedByTeam` breaks that
pattern deliberately: it's a player decision, not derived simulation state
that regenerates from the seed, so it has to be saved explicitly. It's
flattened to `{fieldId, teamId}` pairs — the same shape any other
field-keyed persisted state in this codebase would take — and restored by
walking the same `fieldById` map `deserialize` already builds for its other
cross-references, after `world.regenerate()` has rebuilt fresh (unblocked)
field records. `SCHEMA_VERSION` goes 3 → 4; the field is simply absent on
older saves, restoring exactly the unblocked world those saves described.

`stateHash.js` gains one line per *blocked* field (most fields have none, so
nothing is added for the common case). This is the same judgment call
recently made for `kills`: a block is now load-bearing — two clients
disagreeing about it route their harvesters differently and diverge
economically within seconds, well before anything else being hashed would
show it. Team ids inside one field's part are sorted before joining, because
a `Set`'s iteration order is insertion order, and two clients that blocked
the same field in a different sequence must still hash identically.

## Found and deliberately not fixed

- **A currently-working harvester is not recalled when its field is
  blocked**, by design (see "what was added" above) — this is a scope
  decision, not a bug, but is worth flagging for anyone expecting "block"
  to mean "evacuate."
- **No world marker for a blocked field.** The only way to see the state is
  to reopen the field's menu. Also a scope decision (see the same
  discussion), not an oversight.
- **`harvestSelectMode`'s click handler now silently swallows a blocked
  field** rather than falling through to `applyIntent`'s own refusal. This
  duplicates the block check in two places (`main.js` and `intents.js`)
  rather than one, which is a real seam a future reader could get out of
  step — but the alternative (checking only in `applyIntent`) makes the
  harvest marker appear and then do nothing a tick later, a worse-feeling
  failure than the click simply finding nothing. Recorded here so the
  duplication reads as deliberate rather than missed.

## Verification

`npm test` — 297 pass, 2 fail (pre-existing, unrelated — `match-client-protocol`
and `match-room`, unchanged by this work).

New suite `tests/crystal-field-blocking.test.mjs`:
- `applyIntent`'s `blockField` case: sets and clears a team's own block;
  refuses to set another team's; is a no-op (not a throw) on an unknown
  field id; two teams can independently block the same field without
  clobbering each other.
- `applyIntent`'s updated `harvest` case: a blocked field refuses the order
  and leaves `targetField` untouched; a field blocked for a *different* team
  still succeeds; unblocking restores the order.
- `harvesterAI._idle`: a blocked field is never picked even when it's the
  only reachable one (all three tiers, not just the first); a nearer blocked
  field is skipped in favour of a farther open one; a block for one team has
  no effect on another team routing through the same field; unblocking makes
  a field selectable again.

**Negative controls run**, per `CLAUDE.md`, each confirmed to fail for a
behavioural reason:
- Removed the blocked check from `_idle`'s first reject tier → four tests
  fail, including the "only reachable field" and "skips a nearer blocked
  field" cases.
- Removed the blocked check from `applyIntent`'s `'harvest'` case → both
  harvest-refusal tests fail.

`npm run build` passes.

**Not verified:** manual play (double-click, toggle, confirm an idle
harvester detours and a manual order is refused) was not exercised in a
browser in this environment. `tests/e2e/`'s two-client match test — the only
check that can observe a real lockstep divergence — was not run, so the
`stateHash` addition is argued for above but not demonstrated between two
live clients.
