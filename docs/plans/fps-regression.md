# The engine audio was doing 14 automation events a frame, per vehicle, to be silent

## The report

A ~50% FPS drop in the built web bundle, appearing across the 2026-08-25
commits. The shape of the drop was not known — the reporter had noticed the
number, not characterised it — so this started by measuring rather than by
picking a suspect.

## The measurement that did not work, and why it is worth recording

The obvious approach is to bisect on frame rate: build each commit from
`9fa69d2` (08-24) to `f98a452` and run a fixed scene. The repo already has
everything for it — `?benchmark=<n>` gives a fixed seed, fixed camera and a
deterministic vehicle grid, and `window.__tickProfiler` breaks a frame into
~20 labelled CPU segments.

That was built (`scripts/perf-bisect.mjs`) and then abandoned as a bisect
driver, because **this sandbox has no GPU.** Headless Chromium falls back to
SwiftShader, and the numbers say plainly that nothing else matters:

| viewport | frame time | accounted CPU | unaccounted |
|---|---|---|---|
| 1280x800 | 817 ms | ~8 ms | ~810 ms |
| 480x360 | 366 ms | ~6.5 ms | ~360 ms |

Shrinking the viewport 7.4x barely halved the frame time — it is not
fill-bound, it is 566 draw calls through a software rasteriser. At 1.2–2.7fps
every CPU-side difference is inside the noise, and `dt` is so large that
dt-dependent logic stops behaving like it does at 60fps. **A bisect run here
would have produced a confident-looking table that meant nothing.**

Two other things the harness had to get right before any number was
trustworthy, both of which caught real mistakes on the first run:

- **`autoQuality` had already tripped to low** before the measurement began,
  which had shrunk the engine-loop pool from 16 to 6 and pinned pixel ratio to
  1. The first run therefore measured the *degraded* regime — precisely the
  path that does less of the work under investigation. Stubbing `update()` is
  not enough; the fix was to force `low = false`, call `setLowPower(false)`,
  and tear down the existing loops so they rebuild uniformly at full quality
  (`panningModel` is only set at creation, so surviving loops would otherwise
  keep the cheap `equalpower` path).
- **The benchmark scene leaves the vehicle drawer open**, and
  `vehiclePicker.update()` does a full `WebGLRenderer.render()` plus a
  `drawImage` *per card, per frame* — 50ms/frame, an order of magnitude above
  every other CPU segment. Real, but not gameplay: nobody plays with the
  drawer open. Left open it swamps everything else. (Recorded below as a
  separate finding.)

## The measurement that did work

Automation-event counts are a property of the code, not the machine — the same
number on a workstation and in a GPU-less container. `scripts/audio-load-probe.mjs`
patches `AudioParam.prototype` and friends before any node is constructed and
counts what the audio system actually asks the Web Audio engine to do.

On the 40-vehicle benchmark scene, **every vehicle parked, silent, and
stationary**:

```
229.7 AudioParam events per frame   (14.4 per engine loop, 16 loops)
  param.linearRamp      196.4/frame
  param.setTargetAtTime  33.0/frame
```

At 60fps that is **~13,800 scheduled automation events per second to describe
a fleet that was not moving and could not be heard.**

## Where they came from

`updateEngineLoop` ended with three unconditional writes:

```js
loop.presence = stepEnginePresence(loop.presence, speedFrac, dt);
loop.audio.setVolume(engineVolume * loop.presence);   // 1 setTargetAtTime
loop.audio.position.copy(anchor.position);
loop.engine.setSpeed(speedFrac);                      // 4 linearRamps
```

No dirty check, no distance culling, no early-out for a value identical to
last frame's. `setSpeed` schedules four ramps (two oscillator frequencies, the
filter cutoff, the gain) every single frame regardless.

The other six per loop are three.js's, from inside `renderer.render()` —
`PositionalAudio.updateMatrixWorld` ramps `positionX/Y/Z` and
`orientationX/Y/Z`. It has an early-out for a voice that is not playing, but
that guard reads `hasPlaybackControl === true && isPlaying === false`, and
`setNodeSource` — which is how an engine loop is wired — **sets
`hasPlaybackControl = false`**. So engine loops never take it. Those six are
also invisible to the tick profiler, because they are attributed to `render`.

The compounding part: `stepEnginePresence` already ramps a stopped vehicle to
presence 0. That was the deliberate intent of "silence engine when parked"
(commit `40ca724`). So a parked fleet was holding 16 pool slots, 32 running
sawtooth oscillators and 16 HRTF panners — convolving every audio quantum —
and spending ~14 automation events per vehicle per frame, **to render
silence.** Muting a loop was never the same as stopping it.

## The fix

Two changes in `src/audio/audio.js`, plus one shared elsewhere.

**1. Don't write what hasn't changed.** `engineWritesNeeded(last, next)` — pure
and exported, in the same spirit as `stepEnginePresence` — compares volume,
speed and position against the values last *written to the audio graph*, and
`updateEngineLoop` writes only what actually moved. Thresholds are chosen to
be inaudible rather than merely small (1e-3 volume ≈ -60dB, 1cm position).

The baseline is deliberately last-written rather than last-seen. Against
last-seen, a vehicle creeping at a hundredth of the threshold per frame would
never accumulate a write and its voice would silently detach from it forever.
There is a test for exactly that.

**2. A stationary vehicle gets no voice at all.** Creation is now gated on
`speedFrac > ENGINE_STOP_EPS`, and a loop that has been fully silent and
stopped for `ENGINE_IDLE_RELEASE_SECONDS` (2s) is released outright — nodes
stopped, removed from the scene, slot returned to the pool.

The creation gate is also what stops the release from thrashing: without it a
released loop would be rebuilt on the very next frame. The 2s hysteresis
covers a vehicle pausing at a waypoint rather than tearing down and rebuilding
five audio nodes on consecutive frames.

**3. `needsUpdate` only when `blending` actually changes**
(`src/render/projectileFx.js`, `src/render/bountyFx.js`). Both set
`material.needsUpdate = true` once per in-flight shell / visible coin, per
frame, which forces three.js through full program re-acquisition — 64 of them
a frame at the shell pool cap. Only `blending` needs it; colour, opacity and
scale are picked up without. It now changes at most once per shell, at the
day/night crossover.

## Verification

**Before → after, same scene, same pinned regime:**

| | before | after |
|---|---|---|
| AudioParam events / frame | **229.7** | **54.4** |
| engine loops (parked fleet) | 16 | 0 |
| scene children | 496 | 480 |
| `engineAudio` in top-6 CPU segments | yes | gone |

The residual 54.4 is the 24 one-shot pool voices and ambience; those use
`setBuffer`, keep `hasPlaybackControl === true`, and so *do* take three.js's
not-playing early-out when idle. That is the system working as intended.

**The behavioural check that mattered more than the counts.** A fix that
deletes engine audio entirely would also show 0 loops and a lovely event
count. Driven in a real browser (Playwright, sandbox → Scout Buggy → hold `w`):

```
parked before driving: {"loopCount":0,"presence":{}}
while driving:         {"loopCount":1,"presence":{"1":1},"speed":8}
after stopping:  speed 7 → 5.25 → 2.92 → 1.17 → 0 → 0 → loop released
```

No voice when parked, a voice at full presence when driving, released 2s after
reaching silence — exactly `ENGINE_IDLE_RELEASE_SECONDS`. Zero page errors.

Worth recording that the first version of this check asserted after a flat 5s
and reported a failure — the vehicle was still coasting at speed 1.58. The
assumption was wrong, not the fix. It now polls to a genuine stop.

**`npm test` — 343 pass, 0 fail** (9 new). **`npm run build` passes.**

**Negative controls**, all three applied by surgical string replacement (never
`git checkout`, which has clobbered uncommitted work in this repo before), each
confirmed to fail behaviourally and then restored:

| Reverted | Tests that failed |
|---|---|
| the dirty check (always return true) | unchanged loop writes nothing; parameters written independently; sub-threshold changes not written |
| the idle-window hysteresis | silent stopped loop released only after the idle window |
| y/z in the position compare | position is compared in three dimensions |

## Not verified

- **That this is the user's 50%.** It cannot be established from here. There is
  no GPU in this environment, so the reported symptom is not reproducible and
  the absolute fps numbers above predict nothing about real hardware. What *is*
  established, hardware-independently, is that the engine path was scheduling
  ~13,800 automation events a second for a silent fleet and now does not. The
  reporter should confirm on the build where the drop was seen.
- **Audio-thread cost is unmeasured.** The tick profiler sees main-thread CPU
  only. The 32 always-running oscillators and 16 HRTF convolutions that a
  parked fleet used to hold were an audio-thread load that nothing here can
  quantify — plausibly the larger share of the real-world cost, and a reason
  the main-thread profile alone understated the problem.
- No before/after was taken on the **itch.io fork**, which only received all of
  `audio/` in yesterday's sync (#88) and so went from not having this code at
  all to having it.

## Found and deliberately not fixed

Each is real, measured or code-confirmed, and separable from this change:

- **`vehiclePicker.update()` costs ~50ms/frame while the drawer is open** — a
  full `WebGLRenderer.render()` + `drawImage` per card, per frame, with no
  disposal on rebuild. Gated behind the drawer being open, so it is not the
  steady-state regression, but it is the single largest CPU number in the
  profile when it is open.
- **Ambience re-bakes forever.** `AmbienceBed._playSegment` renders a fresh
  5-second `OfflineAudioContext` every ~4.4s per bed, two beds — measured here
  at ~30 segments/minute — each preceded by a synchronous 110,250-sample
  `Math.random()` fill on the main thread. `AmbienceBed.stop()` exists and has
  **no call site**, so the chain outlives the match. A periodic hitch, not a
  steady drain; fixable by baking a small pool once and cycling it.
- **`leaveWreckage` is unbounded** (`src/main.js`): 1 Group + 3 Meshes + 3
  BoxGeometries + 1 Material per death, all `castShadow`, added straight to
  the scene with **no reference retained**, so removal is impossible even in
  principle. Neither `regenerate` nor `beginMatch` clears it — wrecks survive
  into a brand new match. Every one is in the sun's map-wide shadow frustum
  every frame, camera-independent. This predates yesterday, so it explains a
  long-session decay rather than a "since yesterday" cliff, but it is the only
  truly unbounded system in the render path.
- **`ScorchMask.decay` walks its entire `_hot` set** every ~2.35s — a set that
  grows monotonically for the first 10 minutes (`SCORCH_FADE_SECONDS = 600`) —
  then re-uploads 1MB. Also not cleared by `regenerate`/`beginMatch`.
- **The audio buffer cache key ignores its generator parameters**
  (`${id}:${variation}`), so the first three shots freeze each variant's
  calibre/intensity forever and the "a bigger hole makes a bigger bang"
  contract is silently dead. Note it is *also* what bounds the cache at 48
  buffers: fixing the key without adding a load-time pre-warm would move
  baking into gameplay frames and make performance worse.

## Ruled out — do not chase these

From a read of the combat-visuals path: `computeVertexNormals` appears nowhere
in `src/`; craters write a bounded sub-region and displace in the shader, with
no BufferGeometry rebuild; `applyShadowQuality`'s full-scene traverse is
reachable only from the settings toggle, not the frame loop; the shell, impact,
debris, coin and light pools are all fixed-size with nothing allocated at
runtime; and `stopEngineLoop` was already correctly wired for unit death, so
audio nodes were never leaking per kill.

## The tools

Both are committed and reusable, and neither is in CI — frame rate on a shared
runner is too noisy to gate on.

- `scripts/perf-bisect.mjs` — whole-frame profile against `?benchmark=<n>`,
  with the regime pinning described above. Useful on real hardware; read the
  per-section CPU numbers, not the fps, anywhere without a GPU.
- `scripts/audio-load-probe.mjs` — counts AudioParam scheduling, node
  construction and offline renders per frame and per second. Hardware
  independent, which is what made it the right instrument here.
