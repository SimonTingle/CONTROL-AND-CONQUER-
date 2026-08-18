# A vehicle builder, and the one line that keeps it out of multiplayer

## The question

Whether to author vehicles in a new standalone repo or inside this one, and
whether to build a Lego-style block editor or something else.

## What the codebase already decided

Three findings settled it before any code was written:

- **`catalog.js` defs are pure data.** No functions, no THREE objects. The
  round-trip test added here (`JSON.parse(JSON.stringify(def))` deep-equals
  the original for every shipped vehicle) is what keeps that true, because
  the save format depends on it.
- **`buildVehicleMesh(def)` has zero per-vehicle-id special cases.** Every
  mesh falls out of numbers — `dims`, `axleFractions`, `shape` flags,
  `lights`, `colors`. Nothing in it says `if (def.id === …)`. So a
  *parametric* editor is almost free: it edits numbers and calls the game's
  own mesh builder. A block editor would have needed a new assembly system
  plus new sim code to derive mass, wheel contacts and collision from blocks
  — `vehicleFactory.js` would not have been reusable at all.
- **`vehiclePicker.js` iterates the catalog.** Adding a vehicle is a push,
  not a UI change.

Hence: same repo, in-game screen, parametric. A separate repo would have had
to duplicate or link `vehicleFactory.js` and the def schema, and the two
copies would drift.

## The multiplayer constraint, which is the real design problem

Only `defId` **strings** cross the wire. `snapshot.js` serialises
`defId: inst.def.id`, and the receiving client resolves it against *its own*
catalog via `defOf`. A vehicle one peer authored and the other has never seen
does not raise an error — restore hits `if (!def) continue` and skips the
unit. One player has a tank; the other has empty ground; both simulate
happily. That is precisely the silent divergence the last three rounds of
multiplayer work existed to remove, and a vehicle editor is a machine for
producing it.

So custom vehicles are offline-only for now, enforced in exactly one place:
`catalogFor(mode, customDefs)` in `src/builder/customCatalog.js`.

It is an **allowlist**, not a `mode !== 'multiplayer-online'` test:

```js
const OFFLINE_MODES = new Set(['sandbox', 'multiplayer-ai']);
if (!OFFLINE_MODES.has(mode)) return VEHICLE_CATALOG;
```

The distinction matters and is not stylistic. Every desync this project has
had came from a path that let through whatever it did not specifically
recognise. With a denylist, a mode added later inherits permission to use
custom vehicles by nobody having remembered to name it; with an allowlist it
has to opt in. The test for this is the one with the negative control below.

`applyCustomCatalog()` is called from `beginMatch()` rather than once at
startup, because `game.mode` is only final by the time a match begins — a
sandbox session that added vehicles must get the built-in catalog back when
the player then starts an online match.

Two consumers are updated together, deliberately: `vehiclePicker.setCatalog`
decides what can be *chosen*, and `vehicles.setExtraDefs` decides what an id
can still *resolve to*. A mismatch between them would be a vehicle that can
be spawned but not restored, or listed but not built.

## Storage

No new table. `server/src/routes/saves.js` already upserts arbitrary JSON per
user on `(user_id, name)`; a vehicle is a row with `mode: 'vehicle-def'` and
payload `{ draft, def }`. Zero server changes.

Custom ids are namespaced `custom:<slug>` so they can never collide with a
built-in, and so an unresolvable `custom:` id elsewhere reads as "that peer
doesn't have this vehicle" rather than a corrupt save. Built-ins are offered
in the editor as *copy to edit* rather than editable in place — editing one
would change a vehicle every existing save and every peer already agrees on.

## Two things found by testing rather than by reading

- **`scout-buggy` ships with no `axles`, `axleFractions` or `steerRatios`
  at all**, relying on `axleOffsets()` defaulting to two. The first version
  of `validateDef` required them and rejected a fork of the game's own first
  vehicle. The validator now mirrors what the factory actually requires, no
  more — a validator stricter than the engine rejects vehicles that render
  perfectly well.
- **A one-axle vehicle produces NaN wheel positions.** `axleOffsets()`
  spreads axles above two with `2 * axleX * i / (count - 1)`, so `count = 1`
  divides by zero. The axle minimum is 2 in both the validator and the
  slider, for that reason and not for taste.

A third was found by looking at a screenshot: the parameter widgets are
created empty and were never read back from the def, so every slider sat at
its own midpoint and the first drag wrote that wrong value into the vehicle.
`syncParams()` is now called after building the panel and on every open.

## Verification

- **`tests/vehicle-def.test.mjs`** (13 cases): a blank def is valid and
  carries every block `buildVehicleMesh` dereferences without a default —
  notably `lights`, whose absence *throws* in `buildLights` rather than
  degrading; the axle fields are optional exactly as the factory treats them;
  one axle is rejected; `axles` disagreeing with `axleFractions` is caught;
  `steerRatios` is checked against the real axle count rather than the
  `axles` field; every shipped vehicle survives a JSON round trip; forking a
  built-in yields a valid, non-colliding, deep copy that cannot write back
  into the catalog.
- **`tests/custom-vehicle-catalog.test.mjs`** (5 cases): custom vehicles
  appear in sandbox and vs AI, never in an online match, never as drafts, and
  the built-in catalog is never mutated by merging. **Negative control:**
  replacing the allowlist with `mode === 'multiplayer-online'` makes the
  unknown-mode test fail (and only that one), then restored — so the test is
  demonstrably testing the fail-closed property and not merely the online
  case.
- `node --test tests/*.test.mjs`: 52/52.
- `npx vite build`: succeeds.
- **Driven in a real browser** (Playwright against `vite preview`), not just
  asserted: the editor opens with 10 parameter groups, 38 sliders and a live
  canvas; editing a slider rebuilds the preview and leaves validation
  reporting "Ready"; forking the Light Tank loads its real values
  (hullLength 9.4, hullWidth 3.2) under the name "Light Tank (copy)";
  raising the axle slider to 5 rewrites `axleFractions` to
  `[1, 0.5, 0, -0.5, -1]` and `steerRatios` to `[1, 0, 0, 0, 0]`; night mode
  dims the scene and the vehicle's own tail lamps light. No page errors.

Not verified: the save/load round trip against a live backend — the smoke
test ran with no API configured, so `listSaves`/`putSave` were never
exercised end to end. The payload shape is covered by unit tests and the
endpoints are pre-existing and unchanged, but nothing here has yet written a
vehicle to a real database and read it back.

## Deliberately not built

- **Block/Lego assembly.** The saved payload is `{ draft, def }`, so a block
  layer can be added as another payload field later without invalidating
  anything saved by this version.
- **Custom vehicles online.** Needs the full def shipped in the match
  handshake and a `PROTOCOL_VERSION` bump. The allowlist above makes the
  current limitation explicit rather than silent.
- **Tank tracks with suspension.** There is no `tracks` field in the def
  schema — every vehicle is wheeled via `axles`/`axleFractions`. Real tracks
  mean new geometry in `vehicleFactory.js`, which is a change to the game,
  not to the editor.
- **Sharing vehicles between accounts.** Saves are scoped by `user_id` in
  SQL; sharing is a new endpoint, not a UI feature.
