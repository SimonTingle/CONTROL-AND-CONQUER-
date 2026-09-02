# Synced vehicle headlights across players, and time-of-day fixed on rejoin

## Two reports, filed together

1. "when you are in control of vehicle at dusk, dawn or night. we see the
   vehicle lights cast light on terrain. however when other players see the
   same vehicle, they do not see the same vehicle cast light. we need this
   syncronized."
2. "also syncronize the time of day correctly between all players in online
   multiplayer"

## Part A — headlights only cast real light locally

`HeadlightPool` (`src/vehicles/headlightPool.js`) held exactly one real
light rig — 4 SpotLights (2 driving beams, tail, reverse) — parented to
`vehicles.active`, a **per-client, local-only** reference to whichever
vehicle *that client* happens to be piloting. Every other player's driven
vehicle showed only its static emissive lamp lenses to everyone else,
including that vehicle's own driver as seen by others. Deliberate,
documented perf tradeoff: the file's own header records going to 16+ real
lights costing 705ms of a 710ms frame in a full lobby (measured on the
deployed build), against 4 lights at ~0.8ms.

Clarified with the user: one real-lit vehicle per team, capped at a safe
total regardless of team count (now up to 20, per
`docs/plans/twenty-player-matches.md`), prioritized by distance to each
viewer's own camera.

### The fix

- **`headlightPool.js`** generalized from one `attachedTo` to `RIG_COUNT`
  (8) parallel rigs — 32 SpotLights total, still comfortably inside the
  measured flat part of the cost curve. `attach(instances)` takes a
  pre-sorted, pre-capped candidate array and re-parents whichever rigs
  changed; extras beyond `RIG_COUNT` are silently ignored (no error, no
  perf cliff — the array can be arbitrarily long). `update()` no longer
  takes a single shared boolean; each rig now reads its own attached
  instance's own `headlightsOn`/`braking`/`reversing`, since every vehicle
  already computes those for itself (`vehicleController.js`'s
  `updateLights`).
- **`main.js`**'s per-frame vehicle block builds the candidate list: the
  local `vehicles.active`, plus one vehicle per other team (resolved fresh
  by id every frame from `vehicles.instances`, never cached — same rule
  `harvesterAI.js`/`aiCommander.js` already follow, since the vehicle
  behind an id can die at any time), filtered to `headlightsOn`, sorted by
  squared distance to camera, handed to the pool uncapped (the pool caps
  internally).
- **Which vehicle each *other* team is piloting** is new, lightweight
  presence state — `remoteActiveVehicles` (`teamId -> vehicleId`), fed by a
  new `activeVehicle` message. **Deliberately not routed through
  `src/net/intents.js`/the lockstep turn system**: this is a rendering
  decision (which vehicle gets a real light), not simulation state — it
  never changes vehicle stats, hashes, or anything gameplay-affecting, so
  CLAUDE.md's "render-only code may use whatever it likes" carve-out
  applies. It rides the existing match WebSocket as its own message type,
  relayed by the server outside the turn/release/quorum machinery entirely
  (`server/src/ws/match.js`'s `activeVehicle` case, `matchClient.js`'s
  `sendActiveVehicle`/`onActiveVehicle`) — the same shape as `playerJoined`/
  `playerLeft`, not `input`/`hash`. This was a deliberate deviation from the
  plan's first draft (which proposed a full `Intent.setActiveVehicle`
  through the deterministic tick system) — tracing `setActive`'s real call
  sites (`vehicleController.js`, spawn/death/picker-selection) showed it is
  purely local input-focus logic with several call sites, and routing all
  of them through the tick-locked intent system would have been far more
  invasive for a value that never needs to agree bit-for-bit across clients
  or replay deterministically.
- Sent once per change (a plain reference/id compare each frame, not every
  tick), not continuously — `lastSentActiveVehicleId` guards it.

## Part B — time-of-day desyncs specifically on rejoin

Traced every lighting/atmosphere call site first, same as
`docs/plans/online-multiplayer-lighting-desync.md` (a different, earlier,
already-fixed report about the debug-only force/flood toggles). Confirmed:
`Atmosphere.update(dt)` (`src/sky/atmosphere.js`) is a pure accumulator —
`phase += dt / periodSeconds` — called only from inside the deterministic
sim tick (`world.update(dt, ...)`, driven by `advanceSimClock()`). For two
clients continuously connected since match start, this already keeps them
in lockstep automatically; **not** the bug.

The actual gap: `world` (and its single `Atmosphere` instance) is
constructed once, at module load, and persists for the page's lifetime —
`world.regenerate()` only touches terrain/water/fog, never atmosphere. So a
transient reconnect (`matchClient.js`'s bounded retry after an abnormal
close) never rebuilds `Atmosphere` at all — `cycle.phase` simply freezes
while disconnected (no new turns arrive to tick it) and resumes correctly
from where it was. **That path was never broken.**

The break is specifically a **full page reload** — `endOnlineMatch`'s
`location.reload()`, used by every deliberate-leave and unrecoverable-error
path, and the mechanism `/matches/mine` (`docs/plans/orphaned-match-hijack.md`)
relies on to get a client back into a running match. A reload reconstructs
everything from scratch, including a brand-new `Atmosphere` at its fixed
`initialPhase` (a dawn-ish default) — regardless of how many turns the
match has actually reached. `LockstepSession.resumeAt(releasedTurn + 1)`
resumes the turn stream at the current turn without replaying the skipped
ones (that would mean re-simulating potentially thousands of ticks just to
reconnect), so `atmosphere.update()` is simply never called for
`0..releasedTurn`. Every continuously-connected peer has moved on to
whatever time of day the match has actually reached; the rejoiner is stuck
at dawn.

### The fix

`Atmosphere.seedFromElapsedTicks(elapsedTicks, simDt)` (new) — a
closed-form version of the same formula `update()` applies incrementally:
`phase += (elapsedTicks * simDt) / periodSeconds`, then re-derives
elevation/azimuth and re-applies, exactly like `scrubToElevation()`'s own
`update(0)` tail. Called unconditionally in `startOnlineMatch`, right after
`world.regenerate(...)`, using `welcome.releasedTurn * welcome.ticksPerTurn`
— safe for a fresh join too, since `releasedTurn` is at or near 0 there
(a no-op).

## Files

- `src/vehicles/headlightPool.js` — `RIG_COUNT`-many rigs; `attach()`/
  `update()` generalized.
- `src/main.js` — candidate-selection/sort/send block in the per-frame
  vehicle update; `remoteActiveVehicles`/`lastSentActiveVehicleId`;
  `onActiveVehicle`/`onPlayerLeft` cleanup in `startOnlineMatch`; the
  `seedFromElapsedTicks` call.
- `src/net/matchClient.js` — `sendActiveVehicle()`, `onActiveVehicle`
  handler case.
- `server/src/ws/match.js` — `activeVehicle` relay case (broadcast,
  excluding sender, `teamId` attached server-side from the roster, never
  trusted from the message — same trust boundary as every other case in
  this file).
- `src/sky/atmosphere.js` — `seedFromElapsedTicks()`.
- `tests/atmosphere-rejoin-sync.test.mjs` (new) — dependency-free, real
  `THREE.Scene`/fake renderer.
- `tests/headlight-pool-multi.test.mjs` (new) — dependency-free, real
  `THREE.Scene`/`THREE.Group`, minimal fake vehicle instances.
- `tests/e2e/two-client-match.mjs` (extended) — the only place that can
  verify the server relay over a real socket/server, since the relay logic
  lives inline in `match.js`'s connection-scoped closure rather than an
  isolated, unit-testable function.

## Verification

- **`node --test tests/*.mjs`** (root) — 527 pass (8 new: 3 atmosphere, 5
  headlight pool).
- **Two negative controls**, each by surgical edit (`cp` backup, never
  `git checkout`), each confirmed to fail for the right reason and
  restored:
  - `seedFromElapsedTicks` reduced to a no-op — 2 of 3 atmosphere tests
    failed (the two that actually exercise seeding; the "fresh join is a
    no-op" test correctly kept passing, since a no-op is indistinguishable
    from itself).
  - `headlightPool.update()`'s per-rig `on` forced to always-`true` — the
    "headlights off shows no beam" test failed for exactly that reason.
- **`node tests/e2e/two-client-match.mjs`** against a real local server +
  Postgres — 22/22 pass (3 new: activeVehicle reaches the peer, `teamId` is
  server-attached not sender-trusted, sender gets no echo). Negative
  control: the server's `activeVehicle` case reduced to a no-op relay,
  re-ran against a real server — 20/22, both new relay-dependent assertions
  failed for the right reason (empty array where a message was expected);
  restored, confirmed 22/22 again.
- Root `npm run build` and `itch.io/`'s build both pass; `itch.io/` synced.
- **Live browser check** (Playwright, sandbox mode): page loads and runs
  with zero new console/page errors from this change (one pre-existing,
  unrelated favicon 404, present in every browser check this session).

## Not verified

- **A real multi-human online match** with several players driving at
  night, confirming each sees real light cast from a teammate/opponent's
  vehicle and that farther-than-8th-nearest vehicles gracefully fall back
  to emissive-only — this environment cannot stand up multiple real
  connected game clients with rendered 3D output at once. Covered instead
  by: the e2e test proving the wire relay genuinely works over a real
  server, and the unit tests proving the pool's attach/cap/per-instance-state
  logic is correct in isolation. The two composed correctly is argued, not
  directly observed.
- **A real reload-mid-match-at-night rejoin**, confirming the sky visually
  matches on rejoin rather than resetting to dawn — same limitation; covered
  by the unit test proving `seedFromElapsedTicks` produces bit-identical
  results to continuous ticking, which is the actual mechanism that makes
  this correct.
- The exact perf cost of 8 real rigs (32 lights) in a genuinely large match
  was not independently re-measured against real hardware — inferred from
  the pool's own documented cost curve (4 lights ~0.8ms, "sharply
  nonlinear" only past 16), not re-run from scratch.
