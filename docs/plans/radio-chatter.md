# Radio chatter: vehicles that talk to each other

## Context

> "I also want to add audible messages where vehicles speak to each other and
> can be heard on radio. This should only be audible to your own team."

Four decisions were taken with the user. One of them carries a hard limitation
that was **confirmed by probing Chromium rather than assumed**, and it shapes
this entire file.

## The constraint

`speechSynthesis` output **cannot be routed into Web Audio.** Probed:

```
hasSpeechSynthesis: true
utteranceKeys:      text, lang, voice, volume, rate, pitch, onstart, onend, …
hasAudioOutputRoute: false        // no captureStream, no audioNode, no stream
voiceCount:          0
```

There is no AudioNode and no MediaStream anywhere on the API. So the voice can
never carry a filter, be positioned, reach the mixer, be compressed, or be
recorded. The user chose browser TTS knowing this, and the agreed resolution is
the **hybrid**:

> The voice is dry. Everything around it is real.

The squelch that opens the channel, the static bed under the line, and the
squelch that closes it are ordinary Web Audio sounds through the existing
global voice pool — filtered, mixed, and editable in the Sound Creator like any
other cue. **What a player hears as "a radio" is mostly those artifacts**; the
voice is the part in the middle. `utterance.volume`, `rate` and `pitch` do
exist and are what is left to work with: volume follows the radio slider, and
rate/pitch give each crew a recognisably different speaker.

### Zero voices is the normal case, not an error

`getVoices()` returned **0** here, and that is also true of stripped Linux
installs, locked-down browsers and headless containers generally. When it
happens, `speak()` still plays both artifacts and still emits the caption, so
the net reads as present and the information still arrives.

That is the primary path in every environment available to me, not a fallback
bolted on afterwards — which is also why `utterance.onend` cannot be trusted:
with no voice it may fire `onerror`, or nothing at all. Every utterance
therefore carries a timer that closes the channel regardless. Without it the
static bed would run forever on the first line ever spoken, and — worse —
`onDone` would never fire, wedging the queue permanently after one line.

## Design

### Observed, never called back into

The natural place to hook "a harvester is taking fire" is `markDangerZone`,
which is called from **inside** `harvesterAI` (`harvesterAI.js:354`). Running a
UI callback from sim code is precisely how a UI handler ends up writing sim
state — the failure this codebase has already paid for (CLAUDE.md, "player
actions are data").

So chatter *observes*. `Chatter.observe()` diffs world state and is driven from
the existing **half-second stats tick** in `renderTick` — the cadence main.js
already uses for everything that "only moves when something is structurally
wrong". Nobody needs telling at 60 Hz that a scout found something. All timing
is on the render clock, never `simClock`, so nothing invites anyone to
serialise it.

### Your team only

Every line is gated on `game.localTeamId`, which already exists and is set from
the `welcome` frame online. Because audio is presentation-only this can never
desync — a peer hearing different chatter is cosmetic by construction — but
hearing the enemy's net would be **free intelligence about where they are being
shot at**, which changes how the game is played. That is a design fault, not a
technical one, and one comparison is all that prevents it. It has a test and a
negative control.

### Why the scheduler is not optional

`speechSynthesis.speak()` **queues**. It does not drop and it does not
interrupt. Push twenty lines during a firefight and the browser is still
narrating a minute later, describing a battle that finished. So: one line at a
time, a global gap, a per-event cooldown, a bounded queue that **drops the
lowest priority rather than growing**, and priority ordering so "base under
attack" is spoken before "unit ready" regardless of arrival order.

### Speaking *to each other*

Most RTS radio is one unit announcing its own event. The user said units speak
*to each other*, so the important events carry a `reply` from a **different
crew**, scheduled as its own line a beat later. `contact` is a scout calling in
and armour or command answering. That is the difference between a radio net and
a notification queue, and it is tested (the two lines must come from different
voice classes).

### Voice classes need no new data

`def.tags` already distinguishes the fleet, so no vehicle def gains a field:

| tag | crew | pitch / rate |
|---|---|---|
| `recon` | Scout | 1.35 / 1.15 |
| `combat` | Armour | 0.80 / 0.95 |
| `economy` | Harvester | 1.05 / 1.00 |
| `support` | Engineer | 1.15 / 1.05 |
| `command` | Command | 0.70 / 0.90 |

One subtlety: `scout-buggy` is tagged `['recon', 'combat']`, so a naive
first-match would make the scout sound like a tank. The *preference* order
lives in `radio.js` rather than in the catalog, and has a test.

### The artifacts are built-in generators, not shipped recipes

Initially these were registered as events with `builtin: false`, expecting the
user to author recipes for them. That was wrong and caught before shipping:
`bufferFor` returns null for an id with neither a generator nor a bound recipe,
so **the radio would have been silent out of the box** — no squelch, no static
— which given the voice cannot be processed would have left it with no sound at
all. They are now real generators in `synth.js`, and a recipe bound to
`radioOpen`/`radioStatic`/`radioClose` still overrides them exactly as it does
for the other built-ins.

They are band-limited to roughly a voice channel (300 Hz–3 kHz). It is that
restriction, not the noise, that the ear identifies as "radio" — which is why
the static uses a **bandpass**: a lowpassed hiss sounds like wind.

### Captions are not decoration

`src/ui/radioFeed.js`, self-creating like `toast.js`. With no TTS voice it is
the **only** carrier of what was communicated, so it is built to stand alone.

Deliberately **not** inside `#hud`: `Hud.update` ends with
`root.classList.toggle('hidden', !economyActive && !vehicle)`, so a feed placed
there would vanish whenever nothing is selected — including the entire scouting
game, which is exactly when the radio has most to say.

## Verification

- `npm test` — 443 tests, 16 new, dependency-free (`Chatter` takes its `speak`
  and its clock by injection).
- **Seven negative controls**, each failing its own test: team gating removed;
  per-event cooldown removed; queue overflow dropping the newest instead of the
  lowest priority; FIFO instead of priority ordering; the busy check removed
  (overlapping speech); the team-switch re-baseline removed; the voice-class
  preference order putting `combat` first.
- **One negative control found a test that passed for the wrong reason.**
  Removing the team-switch re-baseline failed *nothing*. Tracing it: the global
  gap between lines was what kept the assertion true, not the re-baseline — the
  test never advanced the clock. Fixed by advancing it, after which the control
  bites. This is the entire argument for writing negative controls: the test
  was green, looked right, and was checking nothing.
- **Browser probe** — `ttsVoiceCount: 0`, i.e. the zero-voice path is what ran:
  the channel opened, `onDone` fired **exactly once**, the channel closed, a
  muted radio resolved its line without queueing, a caption was emitted and the
  feed element rendered. Same run also had `poolReady: true`, so the cache-key
  check ran (3 and 8) alongside.
- `npm run build` passes.

## Honest limits

- **Not one spoken word has been verified.** `voiceCount: 0` in every
  environment available to me. Artifacts, captions, gating, cooldowns,
  priority, exchanges and the close-the-channel guarantee are all confirmed;
  whether TTS actually says anything is unverified and belongs to a human with
  a real browser. No commit message here claims otherwise.
- **The voice cannot be processed or mixed.** A property of the Web Speech API.
  `utterance.volume` is crude level control and nothing else.
- **Nothing judged by ear**, including whether the chatter frequency is
  pleasant rather than irritating. That is what the Radio slider is for
  (0 = a real off switch: `speak()` refuses the line rather than queueing it,
  so turning it back on delivers no backlog). Expect a tuning pass.
- **The line writing is placeholder-grade.** Two or three phrasings per event
  is enough to prove the mechanism and not enough to stop repeating in a long
  match. Lines are data in `CHATTER_LINES`, so extending them needs no code.
