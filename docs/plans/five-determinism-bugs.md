# Five ways two clients could reach different state

## The problem

The August audit found five places where the simulation could diverge between
clients. None of them threw, none appeared in any test, and each produced a
*plausible* wrong answer rather than an error — which is why they survived.

They share a shape worth naming, because it is the thing to look for next time:
**each let something the clients do not share reach a value the clients must
share.** Array position. A private counter. Which player clicked. Where a
camera was pointing.

## 1. Kill credit resolved in the wrong id namespace

`projectiles.js` recorded `shooterId` but not `shooterKind`, and the lookup
tried vehicles first:

```js
const shooter = this._lookup('vehicle', p.shooterId)
             ?? this._lookup('structure', p.shooterId);
```

`intents.js` states plainly that vehicle and structure ids are separate
counters that both start at 1. So a gun turret with structure id 3, killing
something, credited **vehicle id 3** — possibly an enemy harvester. That
vehicle gained veterancy, which feeds `hitChance` and `shotDamage`, and `kills`
is in the state hash.

Fixed by carrying `shooterKind` at launch and resolving by it. Saves written
before the field existed restore with `?? 'vehicle'` — they keep the old
ambiguity, which nothing can recover, but they load rather than throw.

The same collision existed in `shotRoll`, keyed on bare ids: a turret and a
vehicle sharing a number, firing at the same target on the same tick, drew the
identical roll. Both keys now include the kind.

*This one was mine, introduced with travelling shells.*

## 2. Reacquisition staggered by array position

```js
if (!inst.combatTarget && (this._tick + i) % … === 0)
```

`i` was the unit's index in `[...vehicles.instances, ...armedStructures]` —
spawn and removal history, which `stateHash.js`'s own header says is explicitly
*not* state clients must agree on. A client that resynced rebuilt its array in
snapshot order while the others kept their splice history, and from then on the
two disagreed about which tick each unit searched on. That tick is fed to
`shotRoll`, so the same shot rolled differently on different machines.

`this._tick` made it worse: a private counter, never serialized and never reset
by `deserialize`, so a resynced client's phase stayed offset permanently.

Replaced with `reacquiresThisTick(inst, tick)` — pure, exported, keyed on
`simClock.tick` and the unit's own id. `_tick` is deleted rather than left as
dead state that looks meaningful, and the loop is now `for..of` so nothing can
reach for an index again by accident.

## 3. The `k` debug key wrote simulation state directly

```js
if (k === 'k' && …) { const t = pickSelectable(…); if (t) entities.queueDestroy(t); }
```

No intent, no online gate. `queueDestroy` marks the instance dead
synchronously, so pressing `k` in a match killed the unit on one client while
the peer kept simulating it — unrecoverable, and precisely what CLAUDE.md warns
"has silently desynced matches before".

Gated to local play rather than routed through an intent, because it should not
be a player action at all. Its own comment justified it as the only way to
trigger the destroy pipeline "until combat exists" — combat exists now and
triggers it constantly, so the justification has expired even though the tool
is still handy.

## 4. Presentation wrote `menuOpen`; the simulation read it

`radialMenu` set `instance.menuOpen` straight from DOM handlers.
`harvesterAI` and `aiCommander` read it and stop for it — and opening a menu
nulls the unit's order and zeroes its speed outright. So opening a menu on a
harvester held it still on the opening client while the peer's copy drove
away.

Worse, `_reposition` contains `if (_anchor.z > 1) return this.close()` — a
*camera* test — and `radialMenu.update()` was being called from `simTick`. The
simulation was branching on where each client happened to be looking.

Two changes:

- **`radialMenu.update()` moved to `renderTick`.** It repositions a DOM element
  against the camera; it was never simulation. This removes the camera
  dependency at its root rather than working around it.
- **The hold travels as `Intent.menuHold`.** Holding a unit still *is* a player
  action that changes the world, so by this codebase's own rule ("player
  actions are data") it belongs in the intent stream. `RadialMenu` no longer
  writes `menuOpen`; it reports through an `onHold` callback, which main.js
  turns into an intent. The crystal-field menu wrapper is skipped — it is a
  throwaway object with no presence in the simulation.

The menu still opens and closes instantly; only its *effect on the world* waits
for the tick boundary, which is the same deal every other order already makes.

## 5. UI-mode commands ran on every peer

`SELECT_TARGET_COMMAND.execute` set `ctx.targetSelectMode` — local UI state —
from inside the path `applyIntent` runs on **every** client. One player
choosing "Select target" put everyone else into target-select mode: their next
click was swallowed by the mode instead of issuing a move order, and the intent
it then tried to submit was rejected by the ownership check anyway. Same shape
at three `buildPlacementMode` sites and two `harvestSelectMode` sites.

These commands change nothing in the world. They only put *this* client into a
mode; the world change comes later, from the click, as its own
`Intent.build`/`harvest`/`target`. So they should never have been intents.

All six are now marked `local: true`. `main.js`'s `onCommand` runs them
directly and never submits. `applyIntent` also refuses them — a backstop, so a
future call site that forgets cannot resurrect the bug silently.

## Verification

`npm test` — **346 pass, 0 fail.**

New suite `tests/determinism-guards.test.mjs` (12 tests). The assertions are
mostly about *independence*: that reacquisition does not vary with array
position, that a turret's kill does not land on a same-numbered vehicle (and,
in the other direction, that a vehicle's still lands on the vehicle — so the
fix cannot be "always look in structures"), that a local command is refused by
`applyIntent`, that `menuHold` respects ownership.

**Negative controls run for all four testable fixes**, each confirmed to fail
for a behavioural reason and then restored:

| Reverted | Test that failed |
|---|---|
| `applyIntent`'s `local` guard | applyIntent refuses a command marked local |
| the vehicles-first shooter fallback | turret's kill is not credited to the same-numbered vehicle |
| `kind` in the reacquire stagger key | vehicle and structure sharing an id do not reacquire in lockstep |
| `menuHold`'s ownership check | menuHold cannot hold another team's unit |

**One of those controls caught a bad test rather than a bad fix**, and that is
worth recording. The first draft of "applyIntent refuses a command marked
local" used a made-up def id (`'scout'`). `commandsFor` returns an empty list
for an unknown def, so `applyIntent` bailed at "command not found" long before
reaching the guard — the test passed with the guard deleted. It now uses
`gun-platform`/`mobile`, which genuinely contains `select-target`, and a
companion test asserts that command is present and marked local, so the guard
cannot start passing vacuously if the command is later renamed or moved.

**Verified in a browser** (Playwright + headless Chromium): opened the radial
menu on a vehicle and confirmed `menuOpen` actually arrives on the *simulated
instance* (`true` after open, `false` after Escape) — i.e. the intent
round-trips rather than the flag simply never being set now that the direct
write is gone. That was the failure mode worth checking by hand, since a
silently-broken hold would look identical to a working one in any unit test.
Zero JS errors.

`npm run build` passes.

**Not verified:** none of this is demonstrated *between two clients*, which is
the only place a desync can actually be observed. `tests/e2e/` needs Postgres
and a running API server, neither available here. Every fix is argued from the
shared-state rule rather than shown; that argument is strong for four of them
(they remove a dependency on something demonstrably unshared) and weakest for
`menuHold`, where the new behaviour — a hold that lands a tick later and
travels to peers — has only been seen working on one client.

## Left open, deliberately

- **`lastX`/`lastY` go stale** (`main.js`'s `pointermove` returns early when
  no button is held), so the `k` pick and the build-placement ghost track the
  last *dragged* position rather than the cursor. Real, and adjacent to fix 3,
  but it is a UX bug rather than a determinism one and belongs in its own
  change.
- The audit's snapshot/hash gaps (structure `kills` and combat timers, crystal
  field stock, craters not hashed) are untouched here. They are a coherent
  group of their own.
