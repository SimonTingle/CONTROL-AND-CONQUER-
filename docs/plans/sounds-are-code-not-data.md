# Sounds are code, not data

*Phase 1 of the Sound Creator: recipes, the baker, the event registry, and the
editor.*

## The request

> In god mode, we have vehicle creator. I want to add a new separate app inside
> god mode. Sound creator. Each sound in game has been created. Some sounds
> still don't exist and some sounds need to be edited. […] Give me three
> options of technical abilities "low, medium, advanced" which i can switch
> between for each sfx or ambient or vehicle etc… how can i add new sounds that
> don't exist yet? […] This should not affect FPS of game development. Would we
> save to backend to make it world wide? Give me graphics to show sound source
> and how it may sound at various distances […]

Answered, in advance, by three decisions taken with the user: new sounds means
**wiring up silent game events**, not importing samples; acoustics are
**authored per sound**; and the sounds must work in **sandbox, multiplayer-ai
and online**.

## The obstacle, and why it is the whole design

Nothing in this feature is hard except one thing, and that one thing decides
everything else.

`src/audio/audio.js` holds `GENERATORS`: a hardcoded object mapping sixteen
string ids to sixteen JavaScript functions in `synth.js`.

```js
const GENERATORS = {
  weaponFire: (p) => synth.weaponFire(p?.calibre),
  explosionGround: (p) => synth.explosion(p?.intensity, true),
  …
};
```

A sound in this game **is a function**. There is no representation of a sound
that is not code. So "let the player edit a sound" is not a UI problem — there
is nothing for the UI to edit, nothing to save, and nothing to send to a peer.

Reframing a sound as *data* — a recipe the baker interprets — makes every other
requirement fall out almost for free:

| Requirement | Once a sound is data |
|---|---|
| Save it | A few hundred bytes of JSON on the existing `/saves` API. `mode` is free-form ≤32 chars, so **zero backend change**. |
| Share it in a match | Rides the existing `custom_defs` relay pattern (phase 3). |
| Three ability levels | One declarative schema, filtered by a `level` tag. |
| Zero effect on FPS | Bakes once to an `AudioBuffer` and then takes the *identical* path as a built-in through the same voice pool. |

And the alternative — audio *files* — fails all of them at once. It would be
megabytes per sound instead of hundreds of bytes, would need real asset
hosting, and would destroy the property `synth.js`'s header is proudest of:
this game ships no sound assets at all.

## Three findings from reading the audio system

### 1. Three sounds exist and have never once been played

`harvestScoop`, `harvestDeliver` and `notification` are fully written
generators. Grepping every `playAt` and `playGlobal` call site in `src/` finds
no caller for any of them:

```
$ grep -rn "playAt(\|playGlobal(" src --include=*.js | grep -v src/audio/audio.js
… uiConfirm, uiRefused, structureComplete, weaponFire, coinPickup,
  destroyed, coinSpawn, victory, defeat, matchStart
```

Harvesting — the economic centre of the game — is silent, despite both of its
cues having been written and shipped.

Nothing surfaced this because nothing enumerated it. Knowing which sounds the
game has required reading `GENERATORS` and then grepping for each id
separately. `src/audio/soundEvents.js` now records both halves — whether a
generator exists, and whether anything plays it — and the editor's dashboard
leads with **Silent moments** as a first-class category. The gap is visible
because a list makes it visible.

### 2. The buffer cache has been ignoring generator params

```js
const variation = Math.floor(synth.variedSeed() * 3);
const key = `${id}:${variation}`;          // params passed, params not keyed
…
const promise = generator(params).then(…)
```

`params` reaches the generator and never reaches the key. There are three
variations, so the first three plays of an id populate the whole cache — and
every play afterwards, at any intensity, returns whichever buffer was baked
first.

The consequence in the shipped game: a 5-damage plink and a base-station kill
make the identical noise. `explosion(intensity)` scales duration, filter
sweep and gain off `intensity`, and `craters.js` feeds it the same
`sqrt(damage / REFERENCE_DAMAGE)` that decides crater size — so the visual
still scales and the audio silently stopped.

Measured in the browser (`scripts/sound-editor-probe.mjs`), against the fixed
build:

| | measured |
|---|---|
| cache entries after 30 plays at one intensity | 3 (the three variations) |
| cache entries after 8 *distinct* intensities | 8 |

The negative control for this is a **unit test, not the browser probe**, and
that is a correction worth recording rather than quietly tidying away. The
first plan was to revert the key in the browser and watch the second number
fall to zero. Attempting it produced `"audio never initialised"` — the probe
failed, but for the wrong reason, and a negative control that fails for the
wrong reason has demonstrated nothing. (Two earlier runs *did* report 0, but
they were taken while Vite's HMR was reloading the page under the probe as
files were edited, so they cannot be trusted either.)

`cacheKey` is a pure function, so exporting it and pinning it in `npm test` is
the better instrument in every respect: deterministic, dependency-free, and it
names the actual defect rather than a symptom that needs a working
`AudioContext`, a dev server and a rendered page to observe. Four tests, three
negative controls — params dropped from the key, param names left unsorted,
params keyed raw instead of quantised — each failing its own test.

Params are quantised to two decimal places rather than keyed raw. `intensity`
is a continuous square root, so keying the exact float would mean a fresh
offline render for practically every shell — trading a correctness bug for a
performance one.

This is a pre-existing bug, and it is **load-bearing for the editor**: without
it, an author drags a slider, re-auditions, and hears the stale bake. The one
feedback loop the whole application is built around would silently not work.

### 3. None of this can desync a match

Audio is presentation-only — `CLAUDE.md` says so and `audio.js`'s header says
so. Nothing here reaches `stateHash`, `snapshot`, or a simulated value.
`variedSeed()` is `Math.random()` by design. So the determinism rules that
dominate most work in this repository simply do not apply, and the desync
argument that bars local *vehicles* from online play does not carry over to
sounds.

A different argument does, and it is stronger — see **Hostile input** below.

## What was built

### Recipes — `src/sound/soundRecipe.js`

```
{ id, name, event, editorLevel, gain, layers: [...], acoustics: {...}, falloff: {...} }
```

`layers` are `noise` or `tone` entries whose fields map **1:1** onto the
existing `noiseBurst()` / `tone()` primitives. That correspondence is
deliberate and deliberately un-abstracted: it keeps the baker a thin
interpreter, guarantees the editor's output is playable by construction, and
makes a control that does nothing immediately obvious rather than subtle.

Ids reuse `customIdFor`/`fnv1a64`/`canonicalJson` from `vehicleDraft.js`
verbatim — same `custom:` prefix, same identity-key exclusion. One addition:
`event` is an identity key too, so re-binding a sound to a different game
moment does not mint a new id and orphan the buffer already baked for it.

**Built-ins are never rewritten.** `GENERATORS` is untouched; a recipe
*overrides* an event id. So the sixteen shipped sounds cannot regress as a side
effect of this feature existing, and deleting a custom sound restores the
original rather than leaving a hole.

The vehicle builder's "copy to edit" has **no honest equivalent here**, and the
UI says so. `GENERATORS` is JavaScript, so there is nothing to copy — a
built-in cannot be decompiled into layers. The dashboard offers *start a
replacement* instead: a fresh sound already bound to that moment, with the
original still playing until the replacement is saved and returning if it is
deleted. Seeding a hand-written "approximation" of each of the sixteen was
considered and rejected: nothing in this environment can judge by ear whether
an approximation is close, so shipping sixteen of them would be sixteen
unverifiable claims.

### The baker — `bakeRecipe()` in `synth.js`

Interprets layers through the same `bake()` / `noiseBurst()` / `tone()` the
built-ins use. One synthesis path, so the editor's preview cannot disagree with
what a match plays — the same discipline that made `BuilderPreview` use the
real `buildVehicleMesh`.

It deliberately does *not* apply `variedSeed()` jitter. An author needs the
change they hear to be the change they made; per-play variation would hide a
small edit behind noise. Variation for authored sounds is a per-play concern
that belongs on top of a stable bake.

### Three ability levels are one schema, filtered

Every control in `soundSchema.js` carries `level: 'low' | 'medium' |
'advanced'`, and switching level changes *which controls render*. Not three
editors, and not three recipe formats — a sound authored at `advanced` and
opened at `low` still has all its layers, the author is simply shown fewer
knobs. Measured in the browser: 5 sliders at low, 16 at medium, 24 at advanced,
strictly cumulative.

The `low` macros (Size, Brightness, Length) are the one subtle piece. They are
**written through to the layers and never stored**, and applied *from a
captured base* rather than accumulated. Both follow from the same requirement:
if macros were stored, a sound nudged at `low` and reopened at `advanced` would
show layer values disagreeing with the macro that produced them, and the author
would have two sets of numbers fighting over one sound. The cost, stated
plainly: a macro is not undoable by returning it to 1.0 after a reload, because
the base it was measured from is gone.

`Size` lowers pitch rather than raising volume — a larger radiating body
resonates lower — which is what makes the control read as mass.

### The graphics

`soundPreview.js` draws two canvases:

- **Waveform** of the baked buffer, as min/max peaks per pixel column rather
  than point sampling. A 22kHz buffer has far more samples than pixels, so
  sampling every Nth would alias away exactly the transient an author is
  shaping when they drag "attack".
- **The distance rig** — the gain-vs-distance curve the panner will actually
  apply, its `refDistance` and `maxDistance` markers, the listener's position
  on the axis, and the propagation delay (`d / 343`).

The curve is drawn from `audio.js`'s own exported `linearGainAt`, not from a
formula restated in the preview. Restating it is the usual way a visualisation
starts quietly lying about the thing it depicts.

Full acoustic *processing* — air-absorption filtering, the shared reverb bus,
echo — is authored in the schema but not yet applied to the signal path. That
is phase 2, and the preview deliberately does not draw curves for it: a graph
of an inert control would be worse than no graph.

## Hostile input

This is the one genuine risk the feature introduces, and it is not the one the
vehicle builder had.

A recipe is not a description of a thing — it is **instructions to allocate an
`OfflineAudioContext` and render a graph, on every peer that hears the sound**.
`bake()` sizes that context at `duration * SAMPLE_RATE` frames. A recipe asking
for a 600-second render is a denial of service against the whole lobby.

So every bound in `soundSchema.js` is a real limit rather than a taste, and
`validateRecipe` is written to run server-side unchanged (phase 3). The bound
that matters most is not per-layer: `recipeDuration()` accounts for
`startTime`, because eight individually-legal 4-second layers staggered end to
end would otherwise ask for a 32-second render while every layer passed its own
check. There is a test for exactly that, and its negative control confirms the
naive "longest layer" version lets it through.

`bakeRecipe` also restates the ceilings locally rather than importing them, so
a recipe that somehow slips past validation still cannot ask for an unbounded
allocation, and so `synth.js` keeps its one useful property: pure DSP with no
dependency on the editor.

## FPS

The user's stated hard requirement, so it gets numbers rather than a
reassurance.

- **Editor closed: exactly zero cost.** No module runs, no context exists.
- **Editor open:** the preview panel is *idle at zero* — `invalidate()`
  schedules a single one-shot `requestAnimationFrame`, so there is no permanent
  60Hz treadmill. `BuilderPreview` cannot be idle-at-zero because a spinning
  WebGL scene is genuinely animated; a waveform is a still image between edits.
  Baking is debounced at 120ms, because a slider drag emits hundreds of `input`
  events and each bake is an offline render.
- **Play time: no per-frame difference at all.** A recipe bakes once to an
  `AudioBuffer` and then takes the identical path as a built-in through the
  same pooled voices. There is no code that runs for an authored sound and not
  for a shipped one.
- The cache-key fix trades a small number of extra bakes for correctness. The
  measured bound is above: eight distinct intensities produce eight buffers,
  and thirty plays at one intensity still produce three.

## Verification

- `npm test` — 412 tests, 30 new, dependency-free.
- **Eleven negative controls**, each a surgical edit, each confirmed to fail the
  right test for a behavioural reason: `recipeDuration` ignoring `startTime`;
  `event` removed from the identity keys; macros accumulating instead of
  measured from a base; macro clamping removed; the layer-kind check accepting
  anything; the falloff-inversion check removed; `soundCatalogFor` using a
  `!== 'multiplayer-online'` test instead of allowlists; and drafts/unbound
  recipes not filtered; and three on `cacheKey` — params dropped from the key,
  param names left unsorted, params keyed raw instead of quantised.
- **Browser verification** — `scripts/sound-editor-probe.mjs`, run against the
  dev server. Every number it reports is a count or a comparison, not a timing,
  so it means the same in a GPU-less container as on real hardware (the
  property `audio-load-probe.mjs` was built around).
- The cache-key negative control is a **unit test**, not the browser probe —
  see the correction under finding 2 above. The probe verifies the fixed build
  reports 3 and 8; the defect itself is pinned by `cacheKey`'s own tests.
- `npm run build` passes.

## Deliberately not done

- **Nothing here has been judged by ear.** No audio hardware in this
  environment. Every DSP choice is argued from acoustics and from what the
  existing generators already do; a tuning pass by a human with speakers should
  be expected, not assumed done.
- **The acoustic signal chain** — air absorption, shared reverb bus, echo,
  propagation delay. Authored, bounded and validated; not yet applied. Phase 2.
- **Online relay** — migration, server-side bounds, `welcome` frame field.
  Phase 3. Until then `soundCatalogFor('multiplayer-online', …)` correctly
  returns nothing, because the match supplies no recipes yet.
- **Wiring the silent events.** The registry names them and the editor can
  author for them, but each needs a `playAt` call site, which is code. Phase 3.
- **Sample import** and a **public cross-user gallery** — both out of scope by
  agreement. The recipe format forecloses neither.
- **`busyUntil` is still written and never read** in `audio.js`, and the engine
  loop still computes an unused `falloffFor('default')`. Noticed, unrelated,
  left alone.

## Extending it later

A new layer type or acoustic module touches exactly two places: the
`SOUND_GROUPS` / `LAYER_CONTROLS` schema (the control plus its level tag) and
the baker's layer switch. Bounds and validation follow automatically, because
they are derived from the schema rather than restated — which is the same
property `deriveBounds()` gives the vehicle builder, and the reason it was
copied rather than reinvented.
