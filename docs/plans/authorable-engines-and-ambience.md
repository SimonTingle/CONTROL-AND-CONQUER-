# Authorable engines and ambience

The last item from *"I should be able to manipulate all audio and sound
effects"* — the Sound Creator gains a third recipe kind so vehicle engines and
the day/night ambience beds are authorable, without touching the per-frame
audio path that PR #91 already fixed once.

## Why this was the risky one

`updateEngineLoop` runs every frame for every moving vehicle. An earlier FPS
regression was traced to exactly this path (`docs/plans/fps-regression.md`),
so any change here had to be provably free at runtime, not just "probably
fine."

The seam that makes it safe already existed: `engineGraph` is called **once**,
at loop construction; every later frame only calls `setSpeed`, which was
already dirty-checked. So a recipe only ever needs to be *resolved* once, at
construction — never read again for the life of the loop. That's the whole
design.

Measured before and after, 40 vehicles, `scripts/audio-load-probe.mjs`:

| | before | after |
|---|---|---|
| `param.setTargetAtTime` /frame | 16.28 | 14.15–16.18 |
| `param.linearRamp` /frame | 38.5 | 36.6–37.8 |

Both runs bounce inside normal noise. No regression.

## What's new

**Recipes gain a `kind`** — `sfx` (default, unchanged), `engine`, `ambience`.
One editor, one persistence path, one id scheme; only the body and the binding
vocabulary differ per kind. A recipe with no `kind` field (every recipe saved
before this shipped) is `sfx` — `kindOf()` defaults it, and `loadCustomRecipes`
already re-derives ids on load, so the migration needed zero new code.

**`engineGraph(ctx, baseHz, spec)`** — oscillator count/wave, detune, filter
type/Q, cutoff ratio and rise, pitch rise, gain idle/rise/start. The exact
constants the hardcoded graph used are preserved as `DEFAULT_ENGINE_SPEC`, so
an unauthored vehicle sounds byte-identical to before. Pinned by test, per
field, not as one opaque snapshot — so a drifted constant names itself.

**`ambienceSegment(kind, spec)`** — base frequency, LFO rate/depth, gain,
filter Q, segment length, and (this is the part worth calling out) the jitter
*widths* as first-class fields rather than hidden constants. `variedSeed()` is
what makes the bed generative instead of a loop; hiding the jitter would let
someone flatten it to a loop by accident. `DEFAULT_AMBIENCE_SPEC.day/night`
reproduce the original ranges — verified by re-deriving the endpoints of the
old `0.85 + r*0.3` expressions and asserting they match the new
centre-and-width form exactly.

**Engine binding**: a recipe binds to a vehicle def id, or `*` for the whole
fleet. Resolution at loop construction is def-id-specific first, then `*`,
then the built-in default — so retuning the whole fleet is one recipe, not
eight.

**Ambience binding**: `day` or `night`, replacing one of the two existing beds.
No generalization to N beds — that's future scope, not touched here.

**The editor**: dashboard gains *Engines* (one row per vehicle + "All
vehicles") and *Ambience* (Day, Night) groups. Parameters switch on `kind` via
`groupsFor()`. An engine has no waveform to draw — it's a live graph, not a
buffer — so the preview instead plots pitch and filter cutoff against speed,
which is the actual thing being authored, and auditions at idle/half/full
through a new `bakeEngineSample()` that renders the *real* `engineGraph`
offline. Reusing the real graph rather than a second implementation is the
same rule that keeps the vehicle builder rendering with the real
`buildVehicleMesh` — an editor that can lie about its own output is worse than
one with no preview.

## A real bug caught by the browser probe, not the unit tests

`engineGraph`'s `setSpeed` clamped with `Math.min(1, Math.max(0, speedFrac))`.
`Math.max(0, NaN)` is `NaN`, and `NaN` reaching `linearRampToValueAtTime`
**throws**. Unit tests never exercise a live `AudioContext`, so this passed
every one of them; the extended browser probe's speed sweep (0, 0.25, ..., 1,
1.5, -1, NaN) caught it immediately as `engineSweepOk: false`.

This runs every frame for every moving vehicle. An exception here would have
permanently killed that vehicle's engine for the rest of the match — reachable
in practice from a custom vehicle def with `speed: 0` or missing, since the
division producing `speedFrac` is guarded today in `main.js` but nothing makes
that guarantee permanent. Fixed with an explicit finite check rather than
relying on the clamp.

## Verification

- `npm test` — 458 tests, 15 new, dependency-free.
- **Seven negative controls**, each failing its own test: `gainStart` drifted
  from 0.18; a bed's jitter width changed; `cutoffRise` changed (fails two
  tests — the value pin and the derived-response pin); `kindOf` stops
  defaulting to `sfx` (fails four tests, including two pre-existing sfx tests —
  the migration path is load-bearing more broadly than it looks); the
  mismatched-body check removed; `deriveBounds` reverted to sfx-only (engine/
  ambience become unbounded); a blank engine spec diverges from the built-in.
- **Browser probe**, extended: every layer/preset check from before, plus —
  engine spec changes are audible (default vs. authored RMS differ), the full
  speed sweep including NaN/negative/>1 doesn't throw, both ambience beds bake
  non-silent from a recipe. All green in the same run as the existing checks
  (cache-key, presets, radio, god-mode portal).
- **FPS**: `audio-load-probe.mjs`, 40 vehicles, before/after — unchanged
  within run-to-run noise. This was the one number that mattered most for this
  phase.
- `npm run build` passes.

## Deliberately not done

- **Named weather beds** (rain, storm, coastal) — explicitly out of scope by
  agreement. Would need the two-bed system generalized to N plus something
  deciding what's active, which is a gameplay system, not an audio one.
- **A curve editor for the speed response.** The response is a handful of
  scalars (pitch rise, cutoff rise, gain idle/rise) rather than an arbitrary
  curve — enough to cover the range the original graph actually spans, without
  a UI heavier than this phase earns.
- **Judged by ear**, as with every prior phase here. The non-regression guard
  (unauthored = byte-identical to before) is verified by test; whether any
  *authored* engine or bed sounds good is not, and can't be from this
  environment.
