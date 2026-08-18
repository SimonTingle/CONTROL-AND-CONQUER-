# Tracks: new geometry, and the steering model that had to come with it

## Context

The vehicle builder (`vehicle-builder.md`) shipped without tracks, recorded
there as out of scope: there was no `tracks` field in the def schema at all,
every vehicle being wheeled via `axles`/`axleFractions`. This adds them.

## Why this could not be geometry alone

The obvious plan — draw a belt, keep everything else — does not survive
contact with `steeringWheelbase()`:

```js
// No steered axle at all: the vehicle can only drive straight.
return num !== 0 ? den / num : Infinity;
```

That comment is correct about wheels and wrong about tracks. A track has no
steered axle by construction, so a tracked def's all-zero steer ratios give
`wheelbase = Infinity`, and every consumer that divides by it concludes the
vehicle can never turn:

- `VehicleInstance.turningRadius` → `Infinity / tan(δ)` → Infinity.
- `turningCircleOf(def)`, which the vehicle picker prints on every card.
- `applySteering`'s yaw term, `(forwardSpeed / wheelbase) * tan(δ)` → 0.

A tank does not turn *worse* than a lorry, it turns better — it pivots on the
spot. So tracks needed a second steering model, not a cosmetic layer.

## What was built

**Geometry** (`buildTracks` in `vehicleFactory.js`). Each side gets a belt, a
row of road wheels, and a drive sprocket and idler. The belt is a stadium
outline — an arc at each end joined by straight top and bottom runs — with the
same outline inset by the belt thickness punched out as a hole, extruded
across the track width. That is what makes it a loop with the running gear
visible inside rather than a slab that hides it. The shape's own XY plane is
already the vehicle's forward/up, so the extrusion along +Z lands on the
lateral axis with no rotation.

Heights are measured from the belt's **bottom**, which is the ground contact
surface: the arc centres sit at `wheelRadius + thickness`, putting the outer
edge of the loop exactly on local y = 0 — the same plane a wheeled vehicle's
tyres bottom out on. A new `rideHeight` drives the hull and the selection
hitbox off that instead of the bare wheel radius, so the hull does not sink
into the track.

Only road wheels are pushed as `wheelContacts`. That is the load-bearing
decision: suspension, the per-frame least-squares contact-plane fit, and
everything else downstream needs no special case, because a track is a
different *set of contact points*, not a different physics model. The
sprocket and idler sit up inside the end arcs and never touch ground, as on
the real thing.

**Steering** (`applySteering` in `vehicleController.js`). For a tracked
vehicle, `steerAngle` is reinterpreted as the *fraction* of full lock being
asked for, and yaw becomes `demand * pivotRate * dt` — with no `forwardSpeed`
term at all. Dropping that term is the whole character of the thing: it can
spin on the spot, which no amount of steering lock will do for a wheeled
vehicle. `turningRadius` returns half the track width (it pivots about its own
centre) rather than Infinity, because `harvesterAI` and `aiCommander` read it
to plan turns.

**Honest data.** Toggling tracks in the editor rewrites `steerRatios` to
all-zero, and toggling back restores front-axle-only. Leaving a steer ratio on
a tracked def would make `steeringWheelbase` report a finite wheelbase for
running gear that has none — the def would be describing a lorry.

## Scope

Additive. No shipped vehicle sets `shape.tracked`, and there is a test
asserting that, so no existing vehicle's geometry or handling moves. New
fields are all optional with defaults derived from the wheel
(`trackThickness` from `wheelRadius`, `trackWidth` from `wheelWidth`), matching
how `axles` and `axleFractions` are already optional.

## Verification

- **`tests/tracked-vehicle.test.mjs`** (9 cases). The two that matter:
  - *A track with no steered axle has an infinite wheelbase — and must not use
    it.* Asserts `steeringWheelbase` really does return Infinity for the
    all-zero ratios (the premise the override exists for, so if that ever
    changes the override shows up as dead code), then that `turningCircleOf`
    returns a finite circle equal to the track width.
    **Negative control:** deleting the tracked branch from `turningCircleOf`
    fails this test and only this test; restored, 9/9.
  - *A wheeled vehicle keeps the bicycle-model turning circle exactly.*
    Recomputes the old formula for every shipped vehicle and asserts the new
    code still returns it — the tracked branch must not have moved anything
    underfoot.
  - Plus: no shipped vehicle is tracked; road-wheel count floors at two; belt
    thickness must stay under the wheel radius or the punched hole collapses
    into a solid slab; a tracked def with `pivotRate: 0` is rejected because
    it would have no source of yaw at all; track dims are optional; and the
    `shape.tracked` flag — not the mere presence of track dimensions — is what
    switches behaviour.
- `node --test tests/*.test.mjs`: 61/61.
- `npx vite build`: succeeds.
- **Driven in a browser** (Playwright against `vite preview`): toggling
  *Tracks* in the editor takes the preview group from 15 children to 27,
  produces 10 contacts for 5 road wheels a side and **0** steered wheels,
  puts the contact plane at 0.98 = `wheelRadius 0.8 + thickness 0.18` as
  intended, and reports `wheelbase: Infinity` — i.e. the def stopped claiming
  a steered axle once the flag flipped. Screenshotted at 6 road wheels: belt
  loop with rounded ends, road wheels visible inside it, sprocket and idler in
  the trim colour, hull riding on top. No page errors.

Not verified: a tracked vehicle actually driven around the terrain in a
running match — the pivot-steer branch is covered by reading and by unit tests
on the values feeding it, but nothing here has spawned a tank and turned it on
a hillside. Suspension over uneven ground is likewise inferred from road
wheels being ordinary contacts, not observed.

## Still not built

- **Belt animation.** The track does not visibly scroll as the vehicle moves.
  Purely cosmetic and render-only, so it can be added without touching the sim.
- **Track marks.** `trackMask.js` draws from `weight` and `dims`; a tracked
  vehicle currently leaves the same marks a wheeled one would.
- **Skid-steer cost.** A real tank sheds speed while pivoting. Here, pivoting
  and driving are independent.
