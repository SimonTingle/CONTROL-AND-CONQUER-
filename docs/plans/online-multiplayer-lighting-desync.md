# Vehicle/building lighting looked different between online players

## The report

"Vehicle and building lighting is not synced between players in online
multiplayer."

## Tracing every lighting path first

Before looking for a bug, every place lighting state is computed was traced
to see what actually drives it:

- Per-vehicle headlamp/brake/reverse emissive materials —
  `vehicleController.js`'s `updateLights(headlightsOn)`, called for every
  vehicle instance inside `VehicleController.update`.
- The power-spire beacon pulse — `structures.js`, `Math.sin(this._beaconPhase * rate)`,
  advanced by `dt` inside `StructureInstance.update`.
- The day/night elevation that gates headlights in the first place —
  `sky/atmosphere.js`'s `Atmosphere.update(dt)`, and `main.js`'s
  `headlightsWanted()`, which reads `world.atmosphere.params.elevation`.

All three are called from inside `simTick(dt)` (`main.js`), which in real
play only ever runs with the fixed lockstep `SIM_DT` from the
turn-gated accumulator loop (`match.session.beginStep()`/`endStep()`). So the
beacon phase, headlamp state, and the sun elevation driving it all advance
tick-for-tick identically on both peers — this part was already correctly
deterministic, not the source of the report.

## What actually diverges

Two "Game / debug" controls in `src/ui/controlSchema.js` write straight to a
plain local object (`view.lighting.forceHeadlights` / `.floodHeadlights`),
never routed through `src/net/intents.js`:

```js
toggle('Headlights (force on)', ...)
toggle('Flood: beams on ALL vehicles (test)', ...)
```

`headlightsWanted()` checks `forceHeadlights` first and, if set, forces every
vehicle's headlights on for *that client only* — regardless of the correctly
synced sun elevation. `floodHeadlights` similarly rigs extra per-vehicle
SpotLights (`headlightPool.js`'s explicitly-labelled testing-only flood
mode) on the local client alone. Flipping either mid-match changes only the
toggling player's screen — the exact symptom reported.

This is the same shape of problem the file already has a fix for: three
sibling controls (day/night cycle toggle, day-length slider, sun-elevation
slider) are wrapped in a `simState()` helper (`controlSchema.js:39-42`) that
locks a control during `multiplayer-online`, with a comment already naming
the failure mode — "a scrubbed sun changes `cycle.phase`... the peers
silently diverge." The two headlight toggles were simply never wrapped when
`simState()` was introduced for the day/night group.

## The fix

Wrapped both in `simState()`, matching the existing day/night pattern
exactly — no other file changed. `headlightsWanted()`, `headlightPool.js`,
and `vehicleController.js` were already correct; they just needed the
control that could desync them to be unreachable mid-match, the same way the
day/night sliders already are.

## What this does not cover

- Any lighting divergence *without* touching the debug panel — none was
  found; the "normal play" path was confirmed tick-deterministic by tracing
  every call site back to `simTick`. If a mismatch is still seen after this
  fix, the next place to look is the existing desync diagnostics
  (`hashState`/`desyncTurn`, `main.js`), for an unrelated tick divergence —
  not lighting code, which faithfully mirrors whatever sim state it's given.

## Verification

- `node --check src/ui/controlSchema.js` — syntax valid.
- `node --test tests/*.test.mjs` — 34/34, unaffected (this file has no
  dedicated test, and none of the three pre-existing `simState()`-locked
  controls do either — this change is structurally identical to an existing,
  already-accepted pattern, not new mechanism).
- Not verified: an actual two-browser online match confirming the two
  toggles render disabled with the lock hint during `multiplayer-online` and
  remain interactive in Sandbox/AI modes. Recorded here rather than claimed,
  per this repo's verification standard — the change is a direct,
  line-for-line copy of the existing `simState()` wrapping pattern already
  proven correct for the day/night controls in the same file, but it was not
  independently re-driven in a browser this session.
