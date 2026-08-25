# Engine loops idled instead of going silent when parked

## The problem

The engine/ambience volume sliders defaulted louder than intended (0.8 and
0.35), and — separately — a parked vehicle's engine loop was never actually
silent. `updateEngineLoop` called `loop.audio.setVolume(engineVolume)` flat,
every frame, regardless of speed. `engineGraph`'s `setSpeed` (`synth.js`)
does move pitch/filter/internal gain toward an idle floor as speed drops to
0, but that floor is `0.14`, not 0 — by design, since it's meant to be a
believable idle, not silence. Nothing above it ever decided "this vehicle
isn't moving, its engine loop shouldn't be audible at all."

## The fix

Lowered the two defaults (`engineVolume` 0.8 → 0.15, `ambienceVolume`
0.35 → 0.10) — confirmed live via `window.__audio.debugState().volumes`
immediately after a match starts.

Added a per-loop **presence** ramp (0..1), separate from and layered on top
of the existing pitch/filter tracking. The loop's actual volume becomes
`engineVolume * presence`. `presence` ramps toward 1 while `speedFrac` is
above a small stop epsilon (`0.02` — not exactly 0, so a vehicle that's
essentially stopped but not bit-for-bit at zero doesn't flicker between
ramping up and down) and toward 0 once it drops below it, at a fixed linear
rate (`1 / ENGINE_RAMP_SECONDS`, `ENGINE_RAMP_SECONDS = 0.8`). A brand-new
loop starts at `presence: 0`, not 1 — a vehicle that spawns already moving
fades its engine in rather than popping to full volume on its first frame,
the same "nothing pops in" rule every other voice in this file already
follows for the exact same reason.

The ramp step itself is `stepEnginePresence(presence, speedFrac, dt)`, pulled
out as a small pure function with no THREE and no module state — the only
reason being that `node --test` has no `AudioContext` to construct a real
`PositionalAudio` loop against, so the arithmetic needed to be separable from
the object it's applied to in order to be unit tested at all.

`setEngineVolume`'s existing "apply live to whatever's already playing" loop
needed the same `* loop.presence` multiplier — without it, dragging the
slider while a vehicle sat parked would have audibly un-muted it, which is
exactly backwards from what presence is for.

`updateEngineAudio()` (`main.js`) needed a `dt` parameter threaded through to
integrate the ramp; it's called from `renderTick(dt)`, where `dt` was already
in scope at the call site, just not passed into the function.

## A note on process, not the change itself

While iterating on the negative control for this change, `git checkout --
src/audio/audio.js` was used to revert a deliberately-broken test case back
to working — but the file had no commit of today's work yet, so that
reverted *all* of today's edits to it, not just the one-line break. Redone
from the plan (the file's other changes — defaults, `setEngineVolume`,
`debugState`, the ramp itself — were straightforward to reconstruct exactly
since they were just written and are documented above), and the negative
control was re-run afterward using a targeted string replace + restore
instead of `git checkout`, which doesn't have this failure mode against
uncommitted work. Recorded here because it's exactly the kind of "before any
command that could discard uncommitted work, check `git status` and prefer a
non-destructive revert" case that's easy to get complacent about mid-session.

## Verification

`npm test` — 316 pass, 2 fail (pre-existing on `main`, unrelated).

Extended `tests/spatial-audio.test.mjs`:
- The two new defaults, pinned explicitly so a future change to either has
  to be deliberate.
- `stepEnginePresence`'s own arithmetic: ramps fully to 1 given enough time,
  ramps fully to 0 given enough time, a single very large `dt` clamps at the
  target rather than overshooting past it in either direction, a speed at or
  below the stop epsilon heads toward silence even starting from full
  presence, a speed just above it heads toward full even starting from
  silence, and presence never leaves `[0, 1]` across a long zig-zagging
  sequence of speeds.

**Negative control run**, per `CLAUDE.md`: replaced the stop-epsilon
comparison with `speedFrac > 0` (i.e. any nonzero speed at all counts as
moving), confirmed the epsilon-specific test fails, restored.

`npm run build` passes.

**Verified live in a browser** (Playwright + headless Chromium): spawned a
vehicle, confirmed the debug snapshot shows the new default volumes (0.15 /
0.10); confirmed presence sits at exactly 0 while parked; drove forward and
sampled presence every 200ms, watching it climb `0 → 0.31 → 0.63 → 0.94 → 1`
— a clean linear ramp landing at 1 in almost exactly `ENGINE_RAMP_SECONDS`;
braked to an actual stop and sampled again, watching it descend
`1 → 0.69 → 0.38 → 0.06 → 0` once real deceleration brought speed below the
epsilon. Zero JS errors throughout.

**Not verified:** what the ramp sounds like — same limitation as the rest of
this audio work, this environment has no way to judge whether 0.8 seconds
reads as a natural fade or as sluggish/twitchy by ear.
