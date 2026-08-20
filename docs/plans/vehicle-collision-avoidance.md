# Vehicle collision avoidance: swerve instead of stop

## The report

Vehicles were clumping and queueing instead of flowing around each other,
especially near chokepoints like repair bays and harvester docks.

## What was actually there

All vehicle-vehicle avoidance lives in `src/vehicles/trafficController.js`.
An autonomous vehicle (not the one the player is driving, and only while it
actually has an order) checks a 120° forward cone
(`AVOIDANCE_CONE_HALF_ANGLE`) out to `hullRadius(a)+hullRadius(b)+6`. If
something is inside it, `_resolveAvoidance` sets `inst.yielding = true` — and
that was the entire response. `vehicleController.js`'s `driveToTarget()` read
the flag and zeroed `forwardSpeed`/`speed`: a full stop, never a steering
change. A true head-on (both see each other) ties on `createdAt` so exactly
one yields, not both. If a vehicle sat yielding for `YIELD_REVERSE_THRESHOLD`
(2s) continuously, `beginReverse()` fired a blind timed reverse.

That's a hold, not a route-around — two vehicles converging on the same dock
would each stop, wait, and eventually reverse-shuffle past each other one at
a time rather than simply passing.

## The fix

Kept the cone-detection and tie-break entirely as-is — it already correctly
decides *who* yields. Replaced *what yielding means*: instead of a flat
stop, `trafficController.js` now also computes a lateral steering-offset
vector (`computeAvoidOffset`) and `vehicleController.js`'s `driveToTarget()`
bends its steering aim point by that offset (`steeringAimPoint`) rather than
zeroing speed. Arrival distance is always computed from the *real* target,
never the offset one, so a swerve can never cause a false arrival.

**Which side to swerve to** is the sign of (a's forward) × (bearing to the
obstacle) — a closed-form function of position and heading, no state to
carry between ticks. The one place that has no side to prefer from position
alone is dead on the centerline (`cross ≈ 0`); that falls back to the same
`createdAt` tie-break the head-on branch already uses, so every branch of
"which way" stays a pure function of simulated state, never arbitrary.
Magnitude scales with both hulls' radii and fades toward the edge of the
avoidance cone — a glancing sighting barely nudges the aim point, dead-ahead
gets the full swerve.

**The reverse backstop is untouched and still does its job.** It fires
purely off "how many consecutive seconds has `_resolveAvoidance` kept
flagging this pair" — a genuine chokepoint (a single-wide gap) keeps
re-triggering the cone check regardless of whether the vehicle is standing
still or swerving-and-failing-to-clear, so it still escalates to a reverse
exactly as before. The swerve is a first response, not a replacement for the
escape hatch.

## A correctness gap found before it shipped, not after

`driveToTarget` also uses the steering heading to probe terrain grade
(`readGrade`) and abandons the order if the direction it's about to steer
toward is unclimbable (`arrive('blocked')`). Once steering can bend away from
the real target, that probe can point somewhere the real target direction
never would — swerving right around another vehicle happens to face a rock
outcrop for exactly one tick, and without a guard the *entire multi-step
order* would be abandoned over a transient nudge that had nothing to do with
where the vehicle was actually trying to go.

Fixed by re-checking `readGrade` against the *unmodified* target heading
before abandoning, whenever the failing probe was offset-driven: if the real
direction is climbable, the tick just holds (same as any other yield) rather
than aborting. Only a real target direction that's genuinely unclimbable
still abandons the order, exactly as before. Verified with a dedicated test
pair — a swerve into a wall holds and keeps the order; a real target that's
actually blocked still abandons it — and a negative control that reproduces
the spurious abandonment when the guard is removed.

## Verification

- **`tests/traffic-avoidance-swerve.test.mjs`** (dependency-free, plain mock
  vehicles): `computeAvoidOffset` swerves away from the obstacle's side and
  fades toward the cone edge; `TrafficController.update()` sets `avoidOffset`
  on the yielding vehicle only, matching `computeAvoidOffset` exactly.
  **Negative control**: stripping the `avoidOffset` assignment out of
  `_yieldTo` (leaving only `yielding = true`, the old behavior) reproduces a
  null offset where the test expects a real one — restored.
- **`tests/vehicle-steering-aim.test.mjs`**: `steeringAimPoint` returns the
  raw vector unchanged with no offset, and adds the offset without touching
  the separately-computed arrival distance; the climbable-recheck guard
  holds on a wall-facing swerve but abandons a genuinely blocked real target.
  **Negative controls**: reverting `steeringAimPoint` to ignore its offset
  argument fails the offset-applied case; removing the climbable-recheck
  guard fails the "holds, doesn't abandon" case with `'blocked'` where
  `undefined` was expected. Both restored.
- `node --test tests/*.test.mjs`: **119/119**. `npx vite build` succeeds.
- **Driven in a real browser** (Playwright, headless Chromium), Sandbox
  mode: spawned one scout buggy through the actual drawer UI, a second via
  `vehicles.spawn()` directly (the drawer's own `onSelect` refuses to spawn
  a second of the same type — it reselects the existing one instead, a
  UI-level policy unrelated to what's being verified here), issued each a
  real `setTarget()` order crossing through the other's position, then
  stepped the live simulation and read back `yielding`/`avoidOffset`/position
  every half-second through a temporary console hook (added for this run,
  removed before commit). Confirmed directly from live sim state, not
  inferred: at least one vehicle was `yielding` with a non-null
  `avoidOffset` at some point, and position kept changing tick-to-tick
  during that window — a swerve, not a freeze. Both vehicles went on to
  satisfy their orders (`hasOrder` false by the run's end).

## What this does not cover

- No steering-around check for whether the swerve itself is also blocked by
  a third vehicle or terrain beyond the climbable-recheck guard above — that
  case still falls through to the existing stop-then-reverse escalation,
  unchanged from before this fix. Not separately exercised with a three-way
  cluster.
- Not verified in an online multiplayer match. The swerve math is a
  closed-form function of already-simulated, already-synced state
  (position, heading, hull dims, `createdAt`) with no new `Math.random`,
  `Date.now`, or `performance.now`, so there is no new mechanism for
  divergence — but that reasoning was not confirmed against a live two-peer
  match. Same gap `base-defenses.md` and `ai-defense-and-sell.md` both
  record for their own changes.
- The one AI-driven scenario actually exercised in the browser check above
  used two independently-ordered vehicles, not AI-commander-issued orders —
  `aiCommander.js`'s own units go through the identical `setTarget`/
  `driveToTarget` path, so the same mechanism applies, but that path itself
  was not separately driven end-to-end here.
