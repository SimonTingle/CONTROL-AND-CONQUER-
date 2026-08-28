# The Sound Creator's second pass

*God mode gets a portal; the editor gets somewhere to start and something to
start with.*

## Context

Three complaints, all from one session, after the Sound Creator shipped
(`sounds-are-code-not-data.md`, PR #96):

1. **God mode was two buttons.** "God Mode" and "Sound Creator" sat side by
   side in the portal's button row, next to the three play modes.
2. **"I am not happy with the SFX sound creator."** Narrowed with the user to
   two specific things: *no presets to start from*, and *too few layer types*.
3. **"I should be able to manipulate all audio."** Narrowed to engines per
   vehicle and ambience beds — both deferred to a later phase, and named here
   so the omission is deliberate rather than forgotten.

This document covers the first two. Radio chatter and the audio-scope work are
separate phases with their own documents.

## 1. One button, one level down

`portalScreen.js` already had the pattern in `showComingSoon()`: replace the
root's children with a panel ending in a `portal-back` button wired to
`buildGrid()`. `showGodMode()` is the same shape, so Back behaves identically
wherever it appears.

Two things worth recording:

- **The chooser re-checks the account.** `isGodModeAccount` is called again in
  `showGodMode()`, not just where the button renders. Same reasoning as the
  guards added to `game.openBuilder`/`openSoundCreator` in PR #97: a panel
  reachable only from a gated button is gated by accident.
- **The row needed its own class.** `.portal-button-row` is
  `position: absolute; bottom: 6%` — correct for the landing screen, where it
  sits on the backdrop image's lower third, and wrong inside a panel, where it
  would pull the buttons out of the panel they belong to. `.god-mode-row` is a
  plain flex row.

The app formerly labelled "God Mode" is now "Vehicle Creator". That label was
only ever accurate while it was the sole tool behind the button — and the
button it was named for still exists, one level up.

## 2. Four new layer types

`noise` and `tone` are both "one source through a lowpass". That is a narrower
vocabulary than it looks, and it excludes whole families by construction:

| Family | Why it was unmakeable |
|---|---|
| Bells, clangs, alarms | **Inharmonic** partials. Every partial a sum of `tone` layers can make sits at a whole-number multiple of the fundamental — that is the definition of *not* a bell. |
| Pass-bys, wind, whistles | Need a **moving resonant band**. A falling lowpass ceiling only ever sounds like something getting duller. |
| Alarms, geiger, squelch | Identity is a **rhythm**, not a timbre. No envelope on one tone produces a repeating pattern. |
| Trills, blips, birds | **Repeats**. Buildable as N `tone` layers, but a twelve-blip burst would spend the whole eight-layer budget. |

So: `fm` (carrier + modulator into `carrier.frequency`), `sweep` (noise through
a sweeping **bandpass**), `pulse` (tone gated by an LFO on its gain), `chirp`
(N pitch ramps sharing one oscillator).

Each is one extra Web Audio node over what already existed, and each unlocks a
family rather than one more variation. `noise` and `tone` are untouched, so
every existing recipe bakes identically — the same non-regression rule that
kept `GENERATORS` intact.

The extension point held: this was the `LAYER_CONTROLS` schema and the baker's
layer switch, exactly as the first plan predicted, plus `blankLayer`. Bounds
and validation followed automatically because they are derived from the
schema.

Two details that are not obvious:

- **`fm` takes a `ratio`, not a modulator frequency.** The character of an FM
  sound follows the carrier:modulator ratio: hold the ratio and a bell
  transposes and stays a bell; fix the modulator in Hz and it becomes a
  different instrument at every pitch.
- **The FM index sweeps down with the envelope.** A struck object gets duller
  as it decays. Holding the index constant reads as synthetic.
- **`sweep` needs makeup gain, and the probe is what found it.** The first
  browser run reported every kind's RMS at matched Level:

  | noise | tone | fm | sweep | pulse | chirp |
  |---|---|---|---|---|---|
  | 0.032 | 0.054 | 0.055 | **0.006** | 0.073 | 0.041 |

  Eight times quieter than its neighbours, and worse as Q rises. That is not a
  bug, it is physics — a bandpass of centre `f0` and quality `Q` passes a band
  of width `f0/Q`, so noise power through it falls as `1/Q` and amplitude as
  `1/sqrt(Q)`, while a lowpass passes the entire spectrum below its cutoff.
  Left uncompensated, "Level 0.5" would mean something completely different on
  a sweep than on a tone, and raising Q — which the author does to turn wind
  into a whistle — would silence the layer as a side effect of a control that
  says nothing about volume. Compensated by `sqrt(Q)` plus a measured constant
  for the lowpass-versus-bandpass gap.

  Worth noting *how* this was found: not by ear, which is impossible here, but
  because the probe printed a number per layer kind. A test that only asserted
  "sweep is audible" would have passed at 0.006 and shipped a layer type
  nobody could use.

## 3. A pre-existing bug the work surfaced

**The layer waveform dropdown had never worked.**

`soundSchema.js` has two control helpers. `pick()` emits `path` — right for the
fixed-path controls, whose paths are known in advance. `layerNum()` emits
`field` — right for layer controls, whose real path depends on the layer's
index. `LAYER_CONTROLS.tone` used `pick()` for its waveform select.

The editor's `buildLayerControl` reads `control.field` for **every** widget
type, so the select was writing to `layer[undefined]` and reading back blank.
It rendered correctly, responded to clicks, and changed nothing.

Nothing caught it because nothing tested it: the unit tests exercised the
recipe model, and the browser probe checked that sliders existed and that the
waveform *validated* — never that changing it in the editor changed the sound.

Fixed with a `layerPick()` helper that emits `field`, and pinned by a test
asserting **every** layer control is addressed by `field` and never `path`.
That test is the durable part; one helper per addressing mode is what stops it
recurring.

## 4. Presets

A blank noise+tone is a bad place to start for the same reason a blank page is:
the distance between it and anything recognisable is most of the work, and it
is exactly the part that needs the synthesis knowledge the editor was supposed
to make unnecessary.

Fourteen presets across combat / ui / world / radio. They are ordinary recipes,
so they cost nothing at runtime, are editable and forkable the moment they load,
and `npm test` can assert every one passes `validateRecipe` — a preset that
would refuse to save is worse than no preset.

They are **forked** on load, not loaded by reference: otherwise editing a sound
would mutate the preset for the rest of the session, and the next author would
get someone else's edits as their starting point.

Their second job is discovery. `fm`, `sweep`, `pulse` and `chirp` are useless
if nobody can find out what they sound like, and reading a slider called
"Modulator ratio" does not tell you. A test asserts every layer kind is
demonstrated by at least one preset, so a future kind cannot ship undiscoverable.

**The bounds caught one of the presets while it was being written** — a wind
gust asking for a 0.8s attack against a 0.5s ceiling. That is the derived-bounds
design working on its author, which is the best evidence it works at all.

## Verification

- `npm test` — 427 tests, 10 new, dependency-free.
- **Five negative controls**, each a surgical edit failing its own test and no
  other: the layer wave select reverted to `pick()` (the silent-dropdown bug,
  which fails two tests — the addressing test and the completeness test);
  wave validation hardcoded back to `tone` only; `blankLayer('fm')` omitting
  `ratio`/`index`; a preset's `fm` layer swapped for a `tone` (undiscoverable
  layer kind); a preset pushed outside the schema's bounds.
- **Browser probe** (`scripts/sound-editor-probe.mjs`) extended to check what
  unit tests structurally cannot: that each layer kind *renders audible audio*
  (a misconnected primitive validates perfectly and bakes silence), that every
  preset bakes non-silent, that the god-mode panel lists both apps, that Back
  returns to the landing grid, and that a non-admin calling `showGodMode()`
  directly gets nothing.
- `npm run build` passes.

## Deliberately not done

- **Still nothing judged by ear.** No audio hardware here. The presets are
  built from the acoustics of the thing they name — a bell is inharmonic FM
  with a falling index, a pass-by is a resonant band sweeping down — which is a
  sound basis for a *starting point* and is not the same as a finished sound.
  The probe proves each one is audible, not that any is good.
- **Engines per vehicle and ambience beds.** `engineGraph()` and
  `ambienceSegment()` are still hardcoded, so every vehicle shares one engine
  timbre. Asked for, scoped, deferred to its own phase — it touches the live
  per-frame engine path, which is where the earlier FPS regression came from.
- **Radio chatter.** Its own phase; see that document for why browser TTS
  cannot carry the radio filter.
