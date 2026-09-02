# Confirmed Bug Fixes

This lists bugs that were diagnosed, fixed, and **verified** — either live in the
browser/backend, with a real end-to-end test, or (for the multiplayer work) by the
user directly confirming the fix in production. Feature additions and pure
tuning/balance changes are not included unless they were fixing broken behavior.

---

## Online multiplayer

- **MILESTONE: "when a secondary player connects, the first device is
  disconnected" / two devices going straight into a match instead of the
  lobby, appearing to be two separate games.** This was the original,
  long-running report this whole section traces back to. The final root
  cause turned out to be neither a disconnect nor a race condition:
  `server/src/ws/matchRoom.js`'s `rooms` map is purely in-memory, so a
  server restart (any deploy) silently ends a running match without ever
  telling the database — the match's row stays `status = 'running'` forever.
  `GET /matches/mine` (added earlier in this section to let a client find
  its way back into a match after a reload) has no way to distinguish a
  genuinely live match from one orphaned by a restart days earlier, so it
  kept returning the same stale match to one account on every lobby visit —
  and the lobby screen auto-redirects into whatever it returns, with no
  lobby ever shown and no way to decline. The other device, meanwhile, was
  creating and waiting in a real, fresh match the trapped account could
  never reach. Confirmed from two live screenshots: two different seeds, one
  a fresh match waiting for a second player, the other the actual stale
  match (`93d78dd3...`) from earlier testing in this section, still
  `running` at turn 283. Fixed with `abandonOrphanedMatches()`
  (`server/src/routes/matches.js`), called once at server boot: every
  `open`/`running` match is marked `abandoned`, which is safe
  unconditionally since a freshly started process's `rooms` map is always
  empty — there is categorically no live room any such row could still
  correspond to. See `docs/plans/orphaned-match-hijack.md` for the full
  investigation. **User-confirmed live in production: "it works."**

- **MILESTONE: matches were hard-capped at 2 players, with no way for a
  host to ask for more and no way for a 3rd player to ever join** (a
  3rd-player join attempt correctly, if confusingly, got "2/2 match full" —
  every match up to that point really had been created with the old
  hardcoded `maxPlayers: 2`, not a bug in the join check itself). Raised the
  cap to 20: a new `matches_max_players_check` migration, the create-match
  route's validation bound, and a player-count slider in the lobby's create
  flow (`src/ui/lobbyScreen.js`) so a host can actually ask for more than 2
  seats. The simulation side needed no changes — `findTeamSpawnPoints`
  (`src/core/pick.js`) already split a full circle into equal slices for any
  team count. See `docs/plans/twenty-player-matches.md` for the full
  change and its spawn-separation test coverage. **User-confirmed live:
  three real players joined and played correctly together on one shared
  map.**

- **After the fix below shipped, a follow-up redeploy showed the same match
  still split — this time each screen showed "waiting for the other player",
  then one client reached turn 14 (with 8 vehicles) while the other sat at
  turn 2 (with the correct 4), and both were ejected to the portal after
  ~15 seconds.** The start barrier from the entry below held — both clients did
  receive `begin` together — but the identical bug it had just fixed at match
  *start* was still present in the *running* match: `releaseReadyTurns` gated
  on the connected-player count rather than the roster, so the instant one
  socket dropped, the survivor alone satisfied the smaller quorum and was
  released to simulate every subsequent turn on its own — turn 14 vs turn 2,
  reproducing the original symptom from inside the match rather than at its
  start. Three more faults compounded it, two of them introduced by the
  previous fix: `LockstepSession.resumeAt` moved its bookkeeping past the
  input-delay window without ever sending anything for it, so a rejoining
  client could never actually report in; `matchClient.js`'s message switch was
  missing `case 'resyncNeeded'` entirely, so the resync handler already written
  for it was dead code; and the new `lastInputAt` reaper (added specifically to
  stop one kind of stall) ejected both players from any *legitimate* stall,
  since a client correctly waiting on a stalled peer stops sending input by
  design and looked identical to a dead one. Separately, `endOnlineMatch`'s new
  `returnToPortal()` made it trivial for a dropped player to click back into
  the same still-running match and call `beginMatch` a second time —
  `deployStartingForces` is purely additive, so the world doubled (8 vehicles).
  Fixed by gating the running-match quorum on the roster instead of the
  connection count (the running-match twin of the start barrier), having
  `resumeAt` actually send its primed window, wiring the missing message case,
  removing the reaper path that punished legitimate stalls, and replacing
  `returnToPortal()` with `location.reload()` plus a re-entry guard — the same
  remedy `matchEndScreen`'s "play again" already used for the identical reason.
  **Verified with the two-client end-to-end test extended to the drop/rejoin
  cycle, against a real relay and a real database: reverting the roster-based
  quorum alone reproduces the exact field symptom (the survivor free-runs from
  turn 42 to 61, unprompted, the moment its peer drops); with the fix, the
  survivor holds at 42 for as long as the peer is gone, the rejoining client is
  sent `begin{resuming}` and a relayed resync snapshot, and both converge on an
  identical turn again afterward.**

- **Two players in one match each simulated a private world on the same island —
  both screens sat on "waiting for other team" first, then each played on alone
  with the opponent frozen at spawn.** Three fail-open paths, all of which had to
  line up. (1) The 30-second start grace began the match short-rostered, and
  turn release gates on who is *connected* rather than who is *expected*, so the
  first player to arrive was released to simulate by itself. (2) A client
  connecting after that was never sent `begin` — `welcome.started` and
  `welcome.releasedTurn` were transmitted for exactly this case but never read,
  and `LockstepSession.resetTo` was dead code — so it never reported input, sat
  on "waiting" forever, and its silence (masked by a healthy heartbeat) stalled
  the player who *was* running. (3) On disconnect, `endOnlineMatch` nulled
  `match` while leaving `game.mode` alone, and both the sim gate and the
  local-intent guard keyed off that object, so a dropped client silently
  promoted itself to authoritative local play at full speed — applying its own
  orders with `teamId = null`, which disables the ownership check and hands it
  command of both teams. Diagnosed from the two save files' tick counts:
  `11118 = 1853 × 6` exactly (stalled on a turn boundary) versus
  `14084 = 2347 × 6 + 2` (running ungated). Fixed by removing the grace period
  entirely, sending `begin` to late arrivals plus a host resync, timing
  participation separately from liveness, and keying both client-side gates on
  the mode rather than on an object. **Verified with a two-client end-to-end
  test against the real relay and a real database: reverting only the barrier
  reproduces the bug (lone client simulates 12 ticks by itself; the two clients
  end on different turn streams, 4 versus 0), and with the fix both run 40 turns
  on an identical stream and finish on the same tick.**

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

## AI units that stop permanently

Ten defects from one player-supplied diagnostic (expert, four AI teams, 44
simulated minutes). Verified by re-running that configuration headless and
checking the save's own failure signatures, plus 24 dependency-free tests with
twelve negative controls. Full investigation in
`docs/plans/ai-driving-fixes.md`.

- **A harvester could be "arrived" and "drifted" on the same tick.** Arrival was
  measured to `facility.dock` (22 units), the drift release to the building
  centre (33). With `dockOffset` 12, anything landing in (33, 34] from the
  centre satisfied both, and cycled arrive → `_atDock` → UNLOADING → release →
  TO_BASE → arrive forever. No order is issued anywhere in that loop, so the
  stall and no-progress timers — which sit behind `!inst.hasOrder` — never
  advanced and every transition re-zeroed them. Two AI teams finished the match
  on 320cr and 0cr; one of their harvesters carried a full 320 load for 44
  minutes on 92 units of odometer. Both sides now measure from the dock, so the
  overlap is arithmetically impossible rather than merely narrow.

- **Two controllers drove the same scout.** `aiCommander._driveOneScout` had no
  `inst.repair` guard, so every frame a repairing scout had no order it was
  handed a fresh explore target; `repairController._driveTo` then saw
  `hasOrder` and fell through to its stall tail, never reaching the
  `!inst.hasOrder` branch where both its detour ladder and its `_leaveBay`
  give-up live. Detour counts of 74, 56 and 50 against a six-angle ladder.
  `inst.repair` never cleared and the scout ground into terrain until it floored
  at 15hp holding a bay slot.

- **The clearance lease stopped one leg before service started.**
  `repairController._claimDock` called `markDocked` at the dock point and then
  still had to drive the `entering` leg to the pad. `_expireLeases` only
  inspects `entry.cleared`, so a vehicle stalled in `entering` held its bay with
  nothing able to reclaim it — observed at 372 seconds from 228 units away with
  seven vehicles queued behind it. Claimed on arrival at the pad instead, with a
  re-queue for a vehicle whose clearance was revoked mid-leg.

- **`combatCap` was a per-unit-id allowance, not an army budget.**
  `scout-buggy` carries `tags: ['recon','combat']`, so once gun-platform hit its
  own cap the scout became the only combat-tagged candidate and was bought up to
  the cap as well: exactly 7 tanks and 7 scouts per team, ~2,450cr each on units
  `_manageArmy` explicitly refuses to field.

- **An escape cooldown shorter than the reverse it gates.**
  `escapeCooldown = SHARP_TURN_REVERSE * 0.5` — 0.6s against a 1.2s reverse — so
  it expired mid-manoeuvre and the escape re-armed on the tick the reverse
  ended, with no forward travel in between.

- **A mechanical hold with no bound.** `holding` (yielding, or mid-reverse)
  switches off both the stall and no-progress escapes. Both terms can re-arm
  indefinitely, so an unresolvable manoeuvre became permanent: a harvester was
  found with a live order, zero speed, odometer unmoved for fourteen simulated
  minutes and both timers reading 0.00, because `reverseTimer` was re-armed
  before it could expire. Bounded with a 10-second grace; `FLEEING` deliberately
  stays unbounded.

- **A waypoint leg with no order was completely inert.**
  `repairController._driveTo`'s waypoint branch returned whether or not the
  waypoint had been reached, so the order re-issue, the stall check and the
  no-progress check below it were all unreachable while one was live — and a
  leg change cancels the order without clearing the previous leg's waypoint.
  Two harvesters sat in a repair queue for eight minutes each, one with a full
  load, every timer at zero, while their team's income stayed exactly flat.

- **A hold that re-armed wiped the evidence against it.** `if (holding)
  noProgressTimer = 0` reset the counter, and the terrain-blocked escape cycles
  roughly every two seconds (drive at the grade, block, reverse, drive at it
  again). One harvester rode that loop for forty minutes at full speed, six
  units from where it started, with `stall` and `noProgress` both 0.00
  throughout, and its team finished on 320cr. A hold now *pauses* the timer
  instead of resetting it.

- **The detour ladder reset itself on success.** Reaching a detour waypoint set
  `detours = 0`, but reaching a waypoint means the manoeuvre worked, not that
  the leg is going anywhere — so a vehicle wedged short of its destination held
  the ladder at zero and never reached the give-up past it (the field ban,
  `abandonSweeps`, `_leaveBay`). `abandonSweeps` read 0 for the whole match,
  which is what that counter looks like when it is dead code. Progress, not a
  completed manoeuvre, now resets it.

- **A loaded harvester joined the repair queue instead of delivering.**
  `_maybeRetreatForRepair` fires from `TO_BASE`, so a damaged harvester one leg
  from home broke off carrying a full load and queued behind five damaged
  scouts for eight to ten minutes, during which its team earned nothing and its
  credits drained paying for those scouts' repairs. The delivery is now
  finished first; `IDLE` re-checks the retreat the moment the unload is done, so
  it is deferred rather than skipped, and `FLEEING` still owns actual danger.

---

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

- **A custom (author-built) vehicle's factory "Build" radial-menu button
  showed its raw id instead of its name** — e.g. "Build
  custom:834c51a4f58a34db" rather than "Build Devastator". `buildCommandFor`
  in `src/vehicles/commands.js` computed the button's `label` once, at
  command-generation time, by searching `VEHICLE_CATALOG` — the built-ins-only
  array — so the lookup always missed for a custom vehicle and fell back to
  the bare id. The adjacent `hint` field already resolved correctly through
  `ctx.vehicles.defOf` (which searches built-ins then custom defs); `label`
  had simply never been updated to match when that fix landed. Fixed by
  making `label` a function resolved the same way, at render time, in
  `commandsFor`'s existing `hint`-resolution step. Verified: a unit test
  spawning a real custom def on a real Armed Factory def confirms the
  returned command is `"Build My Tank"`, with a negative control (reverting
  to the eager `VEHICLE_CATALOG.find`) reproducing the exact reported id
  string; and confirmed live in a real browser — Multiplayer AI match, a
  custom vehicle named "Devastator" injected and wired to the Armed Factory,
  its radial menu button reads exactly "Build Devastator".

## Backend / deployment

- **The production frontend build had no way to receive the correct backend
  API URL** through CapRover's GitHub-deploy path (no build-arg UI field
  available). Fixed by defaulting `VITE_API_URL` to the known production API
  URL directly in the Dockerfile, with an override still available via
  `--build-arg` for other build contexts.
