# The game had no sound at all

## The problem

There was no `Audio`/`AudioListener` anywhere in `src/`, and no sound assets.
An earlier conversation (not itself worth a plan doc — it was a discussion,
not a diagnosis) inventoried roughly fifty distinct cues the game's mechanics
already call for and settled on procedural synthesis over sample files: zero
asset payload, and — the reason specific to this codebase — every parameter a
sound needs is already sitting in the simulation next to the code that draws
the matching visual. This plan adds that system, with a binaural, distance-
attenuated spatial layer on top: quieter far away, panned left/right, and
audibly different in front of the camera versus behind it.

## What was added

Two new files (`src/audio/synth.js`, `src/audio/audio.js`), and additive hooks
into thirteen existing callback sites in `main.js` — no simulation code
changed, because every event this needed already existed as a render-side
callback (`onShot`, `onImpact`, `onCollected`, `entities.onDestroy`,
`structures.onComplete`, `radialMenu`'s `onCommand`) or a per-frame array read
render-only code already had.

## The one finding that shaped the whole design: spatialization is free

The request was specifically binaural — distance falloff, left/right pan,
and audibly different in front of the camera versus behind it. That last part
is the hard one: stereo panning alone cannot distinguish front from behind
(both pan to "centre"), which is exactly what HRTF (head-related transfer
function) processing is for. Writing that from scratch would be a genuine
DSP undertaking.

It didn't need to be undertaken. `THREE.AudioListener` extends `Object3D`, so
adding it as a child of `camera` (`main.js:140`, right after `world` exists)
makes it inherit the camera's position and orientation automatically on every
matrix update — which `ChaseCamera.update`/`MapControls.update` already do
every frame in `renderTick`. **No per-frame listener code exists in this
codebase beyond the one-time `add()` call.** And every `THREE.PositionalAudio`
voice wraps a native Web Audio `PannerNode` with `panningModel: 'HRTF'` set by
default — genuine binaural spatialization, computed by the browser's audio
thread. `refDistance`/`rolloffFactor`/`maxDistance` give the distance falloff
the same way. The entire "spatial" half of the request turned out to be
configuration, not implementation; the actual engineering work is the
synthesis layer and the pooling.

## Synthesis: `src/audio/synth.js`

Pure DSP, no THREE, no positioning — deliberately separated from `audio.js`
so the two concerns (what a sound *is* vs. *where it plays*) can't leak into
each other. Every generator is a thin composition of three primitives (a
filtered noise burst, a pitched tone with a frequency slide, and an envelope)
rendered once into an `AudioBuffer` via `OfflineAudioContext` and cached by
`audio.js` — never re-synthesized per shot. A 40-shell barrage plays 40 cheap
`AudioBufferSourceNode.start()` calls against buffers that already exist.

The parameter vocabulary (wave shape, frequency slide, envelope, filter
sweep) follows `jsfxr`/Vlambeer-style procedural SFX generators — a small,
proven set that covers explosions, weapon fire and UI chimes with one engine,
rather than reinventing a DSP toolkit from nothing.

**Parameters come from the same numbers the visuals already use, not from
separately tuned constants.** `explosion(intensity, ground)`'s `intensity`
is fed `sqrt(damage / REFERENCE_DAMAGE)` at the call site in `main.js` — the
identical curve `core/craters.js`'s `Craters.shapeFor` uses to size a crater
— so a shell that digs a bigger hole also makes a bigger bang, from one
shared number instead of two independently tuned ones that could drift apart.
The engine loop's day/night-adjacent cousin, ambience, is driven by
`nightFactor(elevation)`, the exact function `render/projectileFx.js` already
exports and shares with the shell shadow/glow cross-fade and the headlight
gate — a fourth system now agreeing with the first three about when night
starts, rather than a fifth independently-tuned threshold.

The one generator that doesn't bake to a buffer is `engineGraph()` — a live,
persistent oscillator/filter graph, because an engine's pitch and filter
cutoff have to track vehicle speed continuously, which a fixed buffer can't
do without either constant re-baking or a playback-rate hack that still
needs a live filter alongside it. Simpler to just make it live.

## Voices: `src/audio/audio.js`

The only file that touches THREE or the scene graph. Copies
`render/projectileFx.js`'s pooling shape deliberately: a fixed-size array of
reusable nodes, round-robin slot reuse, no unbounded growth regardless of
battle size. A dropped voice under pool pressure costs nothing
correctness-wise, the same property that makes fixed pools safe throughout
this codebase's render layer.

Two pools, not one: `voices` (positional one-shots — weapon fire, impacts,
UI) and `globalVoices` (non-positional — match start/victory/defeat), since a
cue like "you won" has no meaningful world position and placing it at some
arbitrary point (the camera itself, say) would make it fall silent the
instant the camera panned. `loops` is a `Map` keyed by vehicle id for
persistent engine tones, reaped every frame by `updateEngineAudio()` in
`main.js` against the live `vehicles.instances` array — the same liveness
check pattern `ProjectileFx`/`BountyFx` already use for their own pools,
applied to `audio.js`'s key set instead of a local one.

## Mobile / overhead

- Web Audio's graph executes on the browser's own audio thread — cost to
  `simTick`/`renderTick` is calling `.start()` and updating a few
  `AudioParam`s for active voices, comparable to `ProjectileFx.updateEffects`.
- `setLowPower(autoQuality.low)` is called from the exact spot `main.js`
  already reads `autoQuality`'s verdict for the renderer — one quality
  signal driving both, not a second detector. Low power shrinks both pools
  (24→10 one-shots, 16→6 loops) and switches `panningModel` to `'equalpower'`
  (stereo pan + distance, no HRTF convolution) — cheaper, loses front/back
  disambiguation specifically, keeps everything else.
- `AudioContext` starts suspended and is resumed from the canvas's existing
  `pointerdown` handler (`main.js`) — no new interaction required, since the
  game already gates its first real action behind a click.
- No network payload: buffers are synthesized client-side once, in memory,
  never fetched.

## What was verified, and how

`npm test` stays dependency-free — `AudioContext`/`OfflineAudioContext` don't
exist under `node --test`, so only the pure-math slice is unit tested:
`nightFactor`'s clamping and monotonicity (what `updateAmbience`'s crossfade
rests on — a non-monotonic curve here would be an audible stutter through
dusk) and `variedSeed`'s range/variation. Buffer synthesis and the
`PositionalAudio` pool genuinely can't be exercised this way.

So the pool/listener/context wiring was verified the way the plan's own
verification section said it would have to be: **in a real browser.** Chromium
was launched headless via Playwright against the dev server, driven through
the actual game (portal → sandbox → difficulty → spawn a scout → drive it →
open its radial menu), with console/page-error listeners attached throughout.
Zero JS errors at any step. `window.__audio.debugState()` (a new debug hook,
mirroring the existing `window.__hashState`/`window.__step` convention)
confirmed the `AudioContext` reached `'running'` after the first click, an
engine loop was live while driving, and both ambience buffers had baked and
cached — i.e. the actual runtime path, not just that the code parses.

**Not verified:** what the audio *sounds like* — this environment has no way
to play or judge synthesized audio, so the DSP parameters (envelope shapes,
filter cutoffs, the specific tone/noise mix per cue) are argued for from
first principles and precedent, not from listening. The first thing to do
with a real browser and speakers is tune them. Real mobile device behavior
(iOS Safari's gesture-resume quirks in particular) is also unverified here.

## Found and deliberately not fixed / left out of scope

- **Harvester mining/unload sounds are not wired.** Both generators
  (`harvestScoop`, `harvestDeliver`) exist in `synth.js` and are registered in
  `audio.js`'s `GENERATORS` table, but nothing calls them. The natural hook —
  `harvesterAI.js`'s unload tick (~line 541, where `team.earn(moved)` runs) —
  fires every tick while unloading a fractional amount, not once per
  delivery, so wiring it cleanly needs a small `onDeliver`-style callback
  added to `HarvesterAI`'s constructor, mirroring the convention
  `CombatController`'s `onShot`/`Projectiles`' `onImpact`/`Bounties`'
  `onCollected` already established. That's a real (if small) change to a
  simulation controller, not just a `main.js` hook, so it's deliberately left
  for its own pass rather than folded in here.
- **No generic notification/toast sound wired.** `notification()` exists in
  `synth.js` but there is no generic toast system in `main.js` to call it
  from — inventing one just to use the sound would be backwards.
- **Radial menu close has no sound.** Open does (`uiConfirm`, from
  `openMenuAt`). `RadialMenu.close()` is called from several incidental
  places (Escape, clicking elsewhere, driving away), and most of those aren't
  a deliberate "you closed a menu" moment — adding a sound to all of them
  would be noise, not feedback. Left silent rather than guessing which call
  sites deserve it.
- **`tests/e2e/` was not run.** Audio is purely presentational and touches no
  simulation or snapshot state, so it cannot desync a lockstep match — there
  is nothing for the two-client test to catch here that the browser smoke
  test above didn't already cover more directly.
