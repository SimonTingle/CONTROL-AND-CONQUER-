# Distant vehicles were audible because `maxDistance` was never wired up

## The report

Distant vehicles' engine audio was audible when it shouldn't be.

## The bug

`src/audio/audio.js` configures every spatial voice's falloff with
`refDistance`/`rolloffFactor`/`maxDistance` — the `FALLOFF` table for one-shots,
and the engine loop's own hardcoded `14`/`1.5`/`180` — and the header comment
describes `maxDistance` as the edge of audibility ("roughly that whole span
gets a `maxDistance` near it"). But **nothing anywhere set
`panner.distanceModel`**, so every `PannerNode` used the Web Audio default,
`'inverse'`.

That default breaks the intent two ways:

1. `'inverse'`'s gain formula approaches zero asymptotically and never reaches
   it, at any distance.
2. `maxDistance` **only affects the `'linear'` model.** Under `'inverse'` it
   is inert. Every `maxDistance` value in this file has done nothing since
   the feature shipped.

Confirmed empirically before touching any code (`OfflineAudioContext`, the
engine loop's actual values, `equalpower` panning to isolate distance gain
from HRTF convolution):

| distance | `'inverse'` (the silent default) | `'linear'` |
|---|---|---|
| 100 | 0.049 | 0.241 |
| 180 (= `maxDistance`) | 0.027 | **0** |
| 300 | 0.016 | **0** |
| 1000 | 0.0047 | **0** |

A vehicle 1000 units away — anywhere on the map, arbitrarily far outside the
chase camera's ~160-unit range — still carried ~1% of near-field amplitude.
With up to 16 concurrent engine loops (see `docs/plans/fps-regression.md`,
landed just before this), that's a wash of audible distant engine noise the
falloff config was clearly meant to prevent.

## The fix

`audio.panner.distanceModel = 'linear';` at both `PannerNode` construction
sites — the only two in the codebase (`grep -rn "new THREE.PositionalAudio"`):

- `initAudio`'s 24-voice one-shot pool. Set once at construction; the property
  lives on the panner and survives every future `setBuffer`/`play()` through
  that reused voice, so `playAt` needed no change.
- `updateEngineLoop`'s loop-creation branch, alongside the existing
  `setRefDistance`/`setRolloffFactor`/`setMaxDistance`/`panningModel` lines.

**Re-tuning risk, checked and ruled out before committing to this fix.**
`'linear'`'s formula (`1 - rolloffFactor*(distance-refDistance)/(maxDistance-refDistance)`)
is shaped differently from `'inverse'`'s, so switching models could have meant
retuning every `rolloffFactor` in `FALLOFF`. The empirical table above used the
engine loop's existing values completely unmodified and produced a sane curve
— full-ish near the source, smooth taper, exactly zero at `maxDistance`.
Chromium does not clamp `rolloffFactor` to `[0,1]` for the linear model, so
the tuned values already in `FALLOFF` (1.1–1.6) carry over directly. No
retuning needed anywhere.

## Verification

`node --test` cannot construct an `AudioContext`/`PannerNode` at all — this is
the same limit `tests/spatial-audio.test.mjs`'s header already documents, and
why that file scopes itself to pure math. So verification here is entirely
real-browser, following this file's own established pattern:

- **Repeated the distance-gain measurement against the fixed code's actual
  config** (refDistance 14, rolloffFactor 1.5, maxDistance 180,
  `distanceModel: 'linear'`): near-field (distance 20) gain 0.48, gain at
  `maxDistance` (180) **exactly 0**, gain far beyond (2000) **exactly 0**.
- **Engine loop lifecycle unaffected.** This change touches a different
  property on the same node than the FPS-regression fix touched, so the same
  interactive check was re-run: sandbox → drive a Scout Buggy → `loopCount: 1`,
  `presence: 1` while driving. Zero page errors.
- `npm test` — 343 pass, 0 fail, unchanged (no pure-math logic changed).
- `npm run build` passes.

**Not verified:** a live A/B of "does a vehicle actually go silent as I drive
away" was not captured on camera/by ear — the isolated PannerNode measurement
demonstrates the underlying gain curve directly and is the more precise check,
but a felt-experience confirmation on a real device is still worth doing.
