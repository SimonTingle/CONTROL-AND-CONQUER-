# Confirmed Bug Fixes

This lists bugs that were diagnosed, fixed, and **verified** — either live in the
browser/backend, with a real end-to-end test, or (for the multiplayer work) by the
user directly confirming the fix in production. Feature additions and pure
tuning/balance changes are not included unless they were fixing broken behavior.

---

## Online multiplayer

- **Cars in a live match didn't move in real time, crystal fields disagreed, and
  the sky differed between devices — while the sync readout falsely said
  "SYNC OK."** Root cause was two independent bugs: (1) the settings drawer wrote
  simulation state directly (Sun elevation, day length, sea level, terrain
  regeneration) outside the networked intent system, so one player's slider
  changes silently diverged the two simulations; (2) the server's desync detector
  kept only each player's *latest* hash, so a player who reported two turns before
  their peer reported the first had their comparison data overwritten before it
  could ever be compared — the check silently never ran. Fixed by disabling all
  11 simulation-affecting drawer controls during an online match, and rewriting
  the desync detector to bucket hashes by turn and only judge once two clients
  have reported the same turn. **User-confirmed live: both cars stayed
  synchronized while driving on the same map.**

- **Two players in the same match were on two different islands.**
  `startOnlineMatch` regenerated terrain from `{ ...heightmap.params, seed }` —
  spreading the *local* client's current terrain sliders and only overriding the
  seed. One player touching any world slider, ever, silently built a different
  island. Fixed to build from `DEFAULT_TERRAIN + seed` only. Verified directly:
  with one client's `size` nudged 25%, the same seed produced different heights
  at the same coordinates before the fix, and identical heights after.

- **A 2-player match deadlocked completely — both screens froze, no vehicle
  moved or was controllable, and desktop couldn't zoom.** Three separate causes:
  (1) the server released turns based on who was *currently connected* rather
  than who was *expected*, so the first player to connect could advance the turn
  clock alone and leave any later arrival permanently unable to catch up
  (mutual deadlock); (2) every human team's scout called `setActive`, so both
  players ended up driving whichever scout spawned last — usually the other
  team's; (3) `controls.update()` (with damping) lived inside the simulation
  step, so a lockstep stall froze the camera even though panning still worked.
  Fixed with a server-side start barrier that withholds all turns until the
  whole roster connects (or a 30s grace period expires), assigning `activate` by
  the client's own team id instead of "any human," and moving camera controls
  out of the simulation into the render step. Verified with the real lockstep
  session against the real relay: a lone client is held at the gate and
  simulates nothing; both clients begin together the instant the roster
  completes; both then run identical turn sequences.

- **All multiplayer teams spawned facing out to sea instead of facing the
  island.** `deployStartingForces` added `Math.PI` to the base station's
  spawn heading — a flip that is correct for the vehicle-picker's own base
  spawn (which faces a vehicle back at a reference point) but wrong here, since
  `findEdgeSpawnPointAtAngle` already returns a heading pointing inland. The
  scout had the same bug via a different path (`findSpawnPointNear`'s
  "face back at the base" heading). Fixed by dropping both flips. Verified by
  dotting every vehicle's forward vector against its direction to the island
  center across a 3-team match: all six vehicles read `dot = 1.00` (exactly
  inland) where the base previously read `-1.00`.

- **The WebSocket relay for online matches returned a 404 in production even
  though the endpoint existed and worked correctly.** CapRover's reverse proxy
  wasn't forwarding the `Upgrade`/`Connection` headers, so the request arrived
  as an ordinary GET; `@fastify/websocket`'s default HTTP fallback for a
  websocket-only route is a bare, bodyless 404 — indistinguishable from the
  route not existing. Fixed by declaring the route with an explicit HTTP
  fallback that returns `426 Upgrade Required` and names the likely cause
  (proxy not forwarding upgrades), and documented the required CapRover
  "Websocket Support" toggle. Verified: a plain GET to the endpoint now returns
  426 with an explanation instead of an empty 404; the user confirmed `101
  Switching Protocols` and real bidirectional frames after enabling the
  CapRover setting.

- **Vehicles stopped responding to WASD entirely, in every mode (sandbox,
  vs-AI, and online) — not just multiplayer.** Regression from routing drive
  input through the new networked-intent queue: drive state is latched and
  only sent when it *changes*, but the keydown handler set `driveKeys` without
  ever emitting that change — and the old per-tick polling that used to cover
  it had already been removed. Root cause of the edit failing silently: a
  string replace matched an outdated version of the line and applied a no-op
  everywhere it mattered, while still parsing cleanly. Fixed by emitting the
  drive intent from keydown as well as keyup/blur. Verified with real
  `KeyboardEvent`s: keydown correctly leaves throttle at 0 (intent applies at
  the next tick boundary), and four simulated seconds of "held W" moved the
  vehicle 68.7 units.

- **`window.__stepMatch`/`window.__hashState` and other dev-only hooks
  referenced state that didn't exist yet in a fresh session** — minor, but
  caught and fixed during testing so the verification harnesses themselves
  were trustworthy.

## Snapshot / save-load correctness (surfaced while building lockstep)

- **Harvester cargo silently vanished on every save/load.** The snapshot
  serializer never captured `state.load` (the harvester's carried crystal
  amount), so any run in progress lost its payload on reload. Fixed by adding
  `load`, `resumeState`, `waypoint`, `detours`, and the harvester's three
  timers to the snapshot; bumped schema to v2. Verified: harvesters restored
  from a save now resume with their actual cargo instead of empty.

- **Loading a save reset every AI opponent's build timer to the start of the
  match**, effectively restarting each AI's opening sequence regardless of how
  far the match had actually progressed. Fixed by serializing each
  `AiCommander`'s timers and latched counters. Verified live.

- **A unit reloaded mid-combat could fire instantly and snap its turret to
  bearing** instead of resuming its cooldown and slewing normally, because
  `_fireCooldown` and `turretAim` weren't part of the snapshot. Fixed by
  adding both fields (with `turretBearing` correctly *excluded*, since it's a
  derived getter, not real state — confirmed by hitting a live
  `TypeError: Cannot set property turretBearing of #<VehicleInstance> which
  has only a getter` during verification and fixing the snapshot to match).

## Determinism (prerequisite for lockstep; also affected single-player)

- **The simulation ran on a variable timestep** (`clock.getDelta()` fed
  directly into the tick), meaning movement was subtly frame-rate dependent
  even in single player, and made networked lockstep impossible since two
  machines would integrate differently every frame. Fixed with a fixed-step
  accumulator (`simTick`/`renderTick` split); sim rate held at a constant 60Hz.
  Verified: `__determinismCheck()` produces identical state hashes across 900
  simulated ticks with 3 AI teams, run twice from the same snapshot.

- **Five harvester-AI behaviors (field bans, threat memory) and one
  combat-controller value read `performance.now()`**, a wall-clock value that
  does not advance during headless fast-forward (`__step`) and differs between
  machines — meaning these bans already behaved incorrectly under
  fast-forwarded testing before multiplayer even existed. Fixed by routing all
  six through a new simulated clock (`simClock.time`) that only advances with
  the sim tick.

## Tire tracks (visual feature, but the original implementation was actually broken)

- **Tire tracks were completely invisible during normal play**, despite the
  underlying data structure recording them correctly. Root cause was the
  decay rate: `Math.round(255 * dt / 75)` evaluates to `0` at any real frame
  time, so a `Math.max(1, ...)` guard silently turned the intended 75-second
  fade into ~4 seconds (60 units/sec at 60fps) — a mark was gone roughly 2
  seconds after being laid. Additionally, the tracking mask's resolution (256
  texels over a 1024-unit map) meant a single texel was wider than the entire
  2.6-unit scout buggy, so even a mark that survived could only ever render as
  an oversized blob. Fixed with a corrected decay accumulator that carries its
  fractional remainder (exact 75s fade, frame-rate independent), a 4x finer
  mask (1024 texels), and marks stamped as swept wheel-line segments instead
  of a single dot per frame. Verified: a 10-second drive produced a
  549-texel, 110×145-unit visible trail (previously 15 texels that decayed
  before they could be observed); screenshotted the two-rut trail directly
  behind a moving vehicle.

- **The grey-grid "under construction" visual disappeared after loading a
  save**, and a base station saved mid-deployment would freeze forever instead
  of finishing its deploy animation. Fixed by restoring the pad's shader
  uniforms on load and re-queuing an unfinished deploy job.

## Performance

- **The game ran at ~1.4fps (705ms/frame) in any scene with a meaningful
  number of vehicles**, previously misattributed to shadow-map cost. Root
  cause: every vehicle instantiated 4–5 real `SpotLight`s for its headlights
  and always forced them `visible = true` regardless of whether the lights
  were actually on — at 20 vehicles this meant 80 simultaneously "on" (zero
  intensity but still shader-compiled and per-fragment-evaluated) lights.
  Three.js keys shader compilation on `visible` light count, not on nonzero
  intensity. Fixed with a fixed 4-light pool re-parented onto whichever
  vehicle is actively driven, so light count never changes with vehicle count.
  Verified: 705ms → 5.88ms per frame (120x), confirmed flat at both 20 and 80
  vehicles, with the real headlight visuals (beams, brake lights, reverse
  lamps) still functioning on the driven vehicle.

- **`AiCommander._manageArmy`'s O(teams × entities) target-selection scan ran
  unthrottled every single frame** for every AI team, a real and measured
  contributor to multiplayer-AI slowdown. Fixed by throttling it to run on an
  interval instead of every tick.

## UI / interaction bugs

- **Long-pressing or double-tapping most vehicles and buildings to open their
  command menu failed almost every time**, because hit-testing raycast against
  literal rendered geometry — and most of a Repair Bay's or Power Spire's
  visual silhouette was empty air between thin support meshes (e.g. clicking
  the open interior of a Repair Bay's pad hit nothing). Fixed by adding
  invisible, appropriately-shaped hitbox meshes sized to each vehicle/building's
  real dimensions. Verified: raycasts at the exact points that previously
  missed (pad interior, mid-height on a tapering spire, the gap between a
  vehicle's wheels) now resolve correctly, with zero added render/draw-call
  cost confirmed via `renderer.info`.

- **Double-tap-to-open-menu did not work on touch devices at all** (an early
  bug, fixed before most of this session's work began).

- **The base-station relocate/repositioning grid sometimes rendered as a flat
  grey square with no visible grid pattern**, and Repair Bay placement was
  rejected everywhere on the map once any facility already existed. Both
  fixed and verified live.

- **Harvesters would repeatedly take collision damage, deadlock at the dock,
  or drive in endless circles** trying to reach a target. Fixed with
  reservation-integrity fixes, a self-healing sweep for stuck states, and a
  reverse-gear recovery maneuver for vehicles that got physically stuck.

- **Vehicle previews in the picker UI eventually broke the whole page** with a
  "too many active WebGL contexts" browser error, from each preview card
  creating its own renderer without disposing old ones. Fixed and verified.

## Backend / deployment

- **The production frontend build had no way to receive the correct backend
  API URL** through CapRover's GitHub-deploy path (no build-arg UI field
  available). Fixed by defaulting `VITE_API_URL` to the known production API
  URL directly in the Dockerfile, with an override still available via
  `--build-arg` for other build contexts.
