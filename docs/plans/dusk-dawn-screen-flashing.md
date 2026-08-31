# The dusk/dawn screen flashing

## The report

> "during some hours of the day, especially dusk and dawn there is a flashing
> effect of the screen"

Narrowed with the player: **the whole screen pulses — the haze throbs in and
out** — on a **Retina Mac**. That description turned out to be the diagnosis,
because it names both halves of what auto-quality changes.

## Reproduced without a GPU

`src/core/autoQuality.js` is a feedback controller whose own action changes the
signal it measures:

- fps below 25 → go low: `setPixelRatio(1)` **and** `setFogDensity(base × 2.2)`
- low quality is ~2.7× faster (the file's own header measures DPR 2→1 as
  4.4ms → 1.65ms) → fps climbs past 32 → go high
- high quality is slow again → fps below 25 → go low → …

Nothing in that loop is damped, so it runs at frame rate. Feeding the controller
an fps that **depends on the state it just chose** — the coupling is the defect,
so the coupling has to be in the test:

```js
const fps = aq.low ? lowFps : highFps;
```

| high-quality fps | low-quality fps | state flips / 600 frames |
|---|---|---|
| 23 | 40 | **29** |
| 20 | 34 | **29** |
| 15 | 28 | 1 — settles low, correct |
| 50 | 60 | 0 — never trips, correct |

29 flips in 600 frames is **~1.5–3 Hz**, each jumping fog `0.0016 ↔ 0.00352`
and DPR `2 ↔ 1`. That is the throb, and it is why the player sees haze
specifically: the fog multiplier is the visible half.

**Why dusk and dawn.** Rows 3 and 4 above are stable — the oscillation exists
only in a *band*. Dusk is when the scene is most expensive (low sun, long
shadows, headlights lit, fog) so the framerate sits exactly in the 25–32 window
where the loop lives. Away from that band the controller behaves, which is why
the symptom is time-of-day specific rather than constant.

**Why the existing hysteresis did not prevent it.** The 25/32 gap is real and
was correctly reasoned — for *noise*. It defends against a jittering
measurement crossing a boundary. It cannot defend against a controller that
**moves the measurement by more than the gap**: when low-quality fps is 40 and
high-quality fps is 23, every threshold pair between those numbers oscillates by
construction. The fix had to be damping in *time*, not a wider gap.

## The fix

Four changes, all in `autoQuality.js`:

1. **Clear the sample window on every change.** After flipping, the 30-frame
   window still describes the quality state just left, so the next verdict is
   made from measurements of a state that no longer exists. This is a
   precondition for everything else.
2. **A minimum dwell in each state** (6s), comfortably longer than the window
   takes to refill — so a decision is always made on samples drawn entirely from
   the current state.
3. **Exponential backoff on the dwell** per flip, capped at 120s. Deliberately
   **not a permanent latch**: a device that oscillates cannot sustain high
   quality and should change ever more rarely, but a player whose framerate
   dipped during one heavy battle should still get their resolution back
   afterwards. A latch would trade a flashing screen for a permanently blurry
   one.
4. **Ramp the fog over ~0.8s instead of stepping it.** It is the most visible
   half of a change and, unlike pixel ratio, a continuous value. A legitimate
   quality drop should read as haze rolling in, not as a cut.

Pixel ratio stays a step — it reallocates the drawing buffer and cannot be
interpolated. Acceptable once changes are rare; it was the *repetition* that
read as flashing.

Result on the same closed-loop model:

| case | before | after |
|---|---|---|
| 23/40 (the bug) | 29 flips | **1** |
| 20/34 | 29 flips | **2** |
| 15/28 (slow) | 1, settles low | 1, settles low |
| 50/60 (healthy) | 0 | 0 |
| max fog step / frame | 1.92e-3 (instant) | **8.6e-5** |

`audio.setLowPower(autoQuality.low)` inherits the fix for free — it was flipping
at the same 3 Hz, tearing down and rebuilding the voice pool and switching
panning model each time. Nothing to change there; damping the source damps it
too, which is the point of it being one signal.

## Second defect: the shadow light went underground

Found while investigating the first, and also dusk/dawn-specific.
`sunLight.position` is the sun direction scaled out, so it followed the sun
below the horizon:

| elevation | shadow light Y | |
|---|---|---|
| +3° | +48 | fine |
| **0°** | **0.0** | **exactly coplanar with the terrain** |
| −2° | −32 | underground, still `castShadow = true` |
| −70° | −866 | underground all night |

At elevation 0 the shadow camera sits on the ground plane looking along it — the
degenerate case. Below that, the scene renders a shadow map from *under* the
terrain, every night frame, for half of every cycle.

**Fix: pin the shadow direction to a 5° minimum elevation**, leaving the sky's
visual `u.sunPosition` untouched. By the time the real sun is that low its
intensity is already at its 0.04 floor, so the direction it arrives from is not
readable — and the sky dome is driven by a separate uniform, so **the sunset
still sets**. Verified in the browser: with the sun at −30°, the sky's sun is at
y = −0.5 while the shadow light holds at +80.

**Deliberately not `castShadow = false` at night**, which is the obvious fix and
the wrong one here: toggling it changes the material defines and forces three.js
to re-link every material — the same stall `headlightPool.js`'s header documents
at 764ms. That would put a hard hitch at exactly the moment this is smoothing.

Also noted and **not** changed: shadow acne at grazing angles (`bias -0.0008`,
`normalBias 0.6`) would shimmer as the azimuth sweeps. Tuning shadow bias
without being able to see it is guesswork, and the pin removes the worst of the
grazing range anyway.

## Verification

- `npm test` — 482 tests, 12 new, dependency-free.
- **Five negative controls**, each failing its own tests and no others:
  the dwell removed (both strobe tests fail); the window clear removed; the
  backoff removed (dwell stays flat — three tests fail); the fog ramp removed;
  the shadow pin removed.
- The shadow test **imports `Atmosphere.MIN_SHADOW_ELEVATION`** rather than
  copying the number — a test that re-derived the threshold would keep passing
  if the production value drifted.
- **`scripts/dusk-probe.mjs`** — a real `Atmosphere` on a real scene, swept
  −70°…+70°: shadow light never below ground (min +80.3), daylight positions
  bit-identical above the pin, sky sun still sets, fog ramps (8.6e-5 vs 1.92e-3
  instant), zero page errors.
- `npm run build` passes.

## Honest limits

- **I have not seen the flashing, and cannot.** No GPU here — framerate is
  pinned far below the unstable band, so the browser simply settles low. The
  diagnosis rests on a reproduced closed-loop model plus the player's
  description matching its exact signature (haze throbbing, high-DPI display),
  and the fix is verified against that model. **Confirming it is gone needs the
  player at dusk on the Retina Mac.**
- The dwell (6s), backoff cap (120s) and ramp (0.8s) are reasoned defaults, not
  tuned by eye. All are named constants.
- The shadow pin is argued from computed geometry and verified numerically
  against the real class — not from a rendered frame.
- 5° is a judgement call: high enough to clear the ground plane and the worst
  grazing angles, low enough that shadows still lengthen convincingly toward
  dusk. Whether it lengthens *enough* to look right is a question only eyes can
  answer.
