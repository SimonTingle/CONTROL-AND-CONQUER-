# Three gaps in the audio work: no volume control, a covered HUD, and a literal loop

## The problem

The spatial audio system that just landed had no player-facing volume
control at all, the World Settings drawer overlapped the HUD's credits/
vehicle-condition block when opened, and the ambience bed — despite the
design discussion's emphasis on "generative" sound — was in fact one 4-second
buffer on `Audio.setLoop(true)`. A loop of any length eventually shows its
seam to a listener who stays long enough; that's the literal thing "not
running on a loop" rules out, and the implementation didn't honour it.

## 1. Sound section in the settings pane

Four sliders — Master, Effects, Engines, Ambience — added to
`controlSchema.js`'s existing declarative section list, no new abstraction:
the `slider(label, min, max, step, get, set)` factory every other group
already uses takes `audio.js`'s new getter/setter pairs directly.

`masterVolume` is a thin wrapper over `listener.setMasterVolume(v)` — the one
point every voice's signal path already converges on, since every
`PositionalAudio`/`Audio` node's own gain connects straight to
`listener.getInput()` (confirmed by reading `three/src/audio/Audio.js`'s
constructor before relying on it). The other three are plain multipliers
applied where each category already computes its own gain: `effectsVolume`
in `playAt`/`playGlobal`'s `setVolume(Math.min(1, gain * effectsVolume))`,
`engineVolume` in `updateEngineLoop`'s per-frame `loop.audio.setVolume(...)`,
`ambienceVolume` in `updateAmbience`'s day/night gain calculation. Nothing
needed a new bus/gain-node topology — every category already had exactly one
place its final volume was decided, and the multiplier slots in there.

One thing worth being explicit about: `setEngineVolume` and `setAmbienceVolume`
apply immediately to whatever's currently playing (looping over `loops` /
re-calling `updateAmbience(lastNightFactor)`), not just to future sounds — a
vehicle already driving shouldn't need to stop and restart to pick up a
volume change, and a slider that only affects the *next* ambience segment
would have up to `AMBIENCE_SEGMENT_SECONDS` (5s) of lag, which reads as
broken.

## 2. HUD offset when World Settings opens

The vehicle-picker drawer (right-hand side) already had exactly this problem
solved for the minimap: it sets `document.body.classList.toggle('drawer-open', open)`,
and `style.css` has `body.drawer-open #minimap { transform: translateX(...) }`.
World Settings (`#panel`, left-hand side) had no equivalent — nothing reacted
to it opening at all.

Copied the pattern exactly rather than inventing a second one: `menu.js`'s
`setOpen` now sets `document.body.classList.toggle('settings-open', open)`
unconditionally (not just in the `open` branch — it has to clear on close
too), and `#hud` gets a `transform: translateX(calc(var(--panel-width) + 8px))`
rule under `body.settings-open`, plus the same narrow-viewport fallback
(fade instead of shift — there's nowhere to slide to on a phone-width panel)
the minimap's own media query already uses. Confirmed in a live browser: the
HUD's bounding rect moved from `left: 16` to `left: 344` (16 + 320 panel
width + 8 gap) the instant the panel opened, and back on close.

## 3. Ambience: a genuinely non-looping generative chain

**What was wrong:** `dayAmbience()`/`nightAmbience()` each baked one buffer
and played it via `Audio.setLoop(true)`. That's a loop by definition — the
word "generative" in the original request specifically excludes this.

**The fix — `AmbienceBed`** (`audio.js`), one per kind (day/night): two
alternating `THREE.Audio` voices. While one plays out a segment, the class
bakes and starts the *next* segment on the other voice, timed to begin
`AMBIENCE_CROSSFADE` (0.6s) before the current one finishes — a crossfaded
handoff, not a loop point. Each segment schedules its own successor from a
timer keyed to its own buffer duration, so the chain drives itself; nothing
in `renderTick` pumps it, the same "reacts to its own completion" shape
`ui/creditBurst.js`'s DOM particles already use via `animationend`.

**What makes it generative, not just "a longer loop":** `synth.js`'s
`ambienceSegment(kind)` — the function `AmbienceBed` calls for every segment —
rerolls its own LFO rate, LFO depth and base filter cutoff via `variedSeed()`
on *every call*. Two consecutive segments are different takes on the same
character, not the same clip. A loop of any length still eventually repeats
itself exactly; this structurally cannot, because nothing is ever replayed —
every segment is freshly synthesized.

**Verified in a live browser**, since this is exactly the kind of claim that's
easy to get subtly wrong (e.g. accidentally leaving `setLoop(true)` on one of
the two voices, or a scheduling bug that makes the "chain" degenerate into
one voice looping while the other sits idle). Added `ambienceSegmentsPlayed`
to `debugState()` — a running count, incremented once per segment actually
started — and watched it advance over a 9-second wait (30 → 32) with no
audible-gap risk from the crossfade math checking out. A counter that keeps
climbing for as long as the bed runs is the observable proof that segments
are being *replaced*, not looped; a stalled or wrong number would have been
the tell that the scheduler broke.

**Also lowered by default**, independent of the new slider:
`AMBIENCE_BASE` dropped from the old flat `AMBIENCE_MASTER = 0.5` to `0.16` —
"low/very low" as requested, a bed under everything else rather than
competing with it. The `ambienceVolume` slider gives headroom back up to 1
for anyone who wants it more present; the default is deliberately quiet.

## Files touched

- `src/audio/synth.js` — `dayAmbience`/`nightAmbience` (single buffer each)
  replaced by `ambienceSegment(kind)` (repeatable, self-jittering).
- `src/audio/audio.js` — volume state + getter/setter exports; `AmbienceBed`
  class; `playAt`/`playGlobal`/`updateEngineLoop`/`updateAmbience` all read
  the new multipliers; `debugState()` gains `ambienceSegmentsPlayed` and a
  `volumes` snapshot.
- `src/ui/controlSchema.js` — new `Sound` section between Camera and
  Game/debug; imports `audio.js` directly (module-level state, same shape
  `net/api.js`'s `api` import already has in this file).
- `src/ui/menu.js` — one line in `setOpen`.
- `src/ui/style.css` — `#hud` transition + `body.settings-open #hud` rule +
  narrow-viewport fallback.

## Verification

`npm test` — 309 pass, 2 fail (pre-existing on `main`, unrelated, confirmed
by stashing). Extended `tests/spatial-audio.test.mjs` with the volume
controls' pure-state behaviour: defaults in range, round-trip through
get/set, clamping both directions, independence between the four controls,
and — specifically — that `setMasterVolume`/`setAmbienceVolume` don't throw
when called before `initAudio` has ever run (exactly the state `node --test`
itself is always in, since no `AudioContext` exists there; also the real
path a user dragging a slider during page load would hit).

**Negative control run**, per `CLAUDE.md`: replaced `clamp01` with an
identity function, confirmed the clamping test fails, restored.

Manual, live in a browser (Playwright + headless Chromium, same approach as
the original audio PR): spawned a vehicle (first real click, also the
`AudioContext` resume gesture), opened World Settings → Sound, confirmed all
four sliders render with correct default values (master shown at 0.90);
measured `#hud`'s bounding rect before/during/after opening the panel
(16 → 344 → 16, exact match to the CSS `calc`); watched `ambienceSegmentsPlayed`
climb over a 9-second wait. Zero JS errors throughout.

**Not verified:** what any of this sounds like, same limitation as the
original audio PR — this environment has no way to play or judge audio.
Whether the crossfade's 0.6s overlap is long enough to be genuinely
inaudible, and whether the new default ambience level (0.16 base) actually
reads as "low" rather than "silent," are both things to confirm with real
speakers before calling the tuning finished.
