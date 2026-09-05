# New players are taught nothing

## The problem

A first-time player is dropped into a full RTS with no guidance whatsoever.
Nothing in the game explains:

- that the command ring — the only way to issue any order more complex than
  "drive there" — opens on a **long-press** (touch) or **double-click**
  (desktop). There is no button, no menu entry, and no visible affordance. A
  player who never discovers the gesture cannot deploy their base, and
  therefore cannot play at all.
- that a `base-station` must **Deploy** before anything can be built.
- that credits only arrive once a **Harvester Facility** exists. Until then
  the HUD hides the economy block entirely (`Hud.update`'s `economyActive`),
  so the game looks like it has no economy rather than an unstarted one.
- what either drawer contains.

`deployStartingForces` gives every team a base station and a scout buggy. The
path from there to a working economy is four non-obvious steps, every one of
them behind the undiscoverable gesture.

## What was built

Short, dismissible cards, shown one at a time as a match progresses, to novice
players only, with an off switch in the hamburger menu.

New: `src/core/playerProfile.js`, `src/ui/hintDefs.js`, `src/ui/hintSystem.js`,
`src/ui/hintCard.js`, `tests/hint-system.test.mjs`. Modified: `src/main.js`,
`src/ui/controlSchema.js`, `src/ui/style.css`, and the group-list assertion in
`tests/skirmish-menu-restriction.test.mjs`.

## How comparable games avoid making this worse

This was surveyed before writing anything, because the failure mode of a hint
system is not "too few hints", it is "the player turns it off in the first
minute and never sees the one that mattered".

- **C&C / Red Alert (EVA)** — audio-first, just-in-time, zero modality. Never
  explains the refinery until you have one. This repo already has the pattern
  in `audio/chatter.js`.
- **Civilization advisors** — tiered off/minimal/full, and each popup fires
  once, ever.
- **StarCraft II** — tips are a corner panel, never a dialog; the campaign
  teaches, the skirmish does not interrupt.
- **Into the Breach / Slay the Spire** — one-shot contextual popups tied to the
  first encounter with a mechanic, persisted across runs.
- **Age of Empires IV** — contextual tooltips plus a global Tips toggle.

The rules that fell out, and which the code enforces:

1. One idea at a time, never a wall at match start.
2. Non-blocking. The game does not stop and the card does not eat input.
3. One-shot, persisted. A hint that reappears is a nag.
4. **Self-cancelling** — if the player does the thing before the hint gets its
   turn, the hint retires unfired. This is `retiredWhen`, and it is the single
   most important rule in the design: competence is the real dismissal.
5. Rate-limited and prioritised, so an urgent hint outranks a trivial one.
6. A findable global off switch.

## Design

### The engine observes; it never gets called into

`HintSystem.observe(ctx)` is handed a plain snapshot from the existing
half-second poll in `renderTick`, immediately after `chatter.observe`. It holds
no reference to `game`, `vehicles` or the DOM.

This shape is copied from `audio/chatter.js` deliberately, and its header
explains why: the natural way to fire "they just finished their first
refinery" is a callback from `structures.onComplete`, and running UI code from
inside sim code is exactly how a UI handler ends up writing simulation state —
the failure this codebase has already paid for repeatedly (`CLAUDE.md`, and
the `menuHold` trap documented in `net/intents.js`, which *looked* like pure
UI and was not). Diffing a snapshot cannot desync a match by construction.

Nothing here queues an intent, writes an `inst.*` field, or is serialised.

### One clock, and it is the render clock

`observe` accumulates the render `dt` it is passed and injects its own
`elapsedSeconds` into the context before evaluating definitions. Definitions
therefore *cannot* reach for `simClock` even by accident. Hints are
presentation: a player who reads slowly must not diverge from one who reads
quickly, and a hint timer on the sim clock is an invitation for somebody to
serialise it into the state hash later.

### The pacing constants are the whole design

| Constant | Value | What it defends against |
|---|---|---|
| `OPENING_QUIET_SECONDS` | 12 | A card during orientation reads as an obstacle. |
| `MIN_GAP_SECONDS` | 30 | Without it every already-true hint chains one click after another — the wall of text, delivered serially. |
| `MAX_PER_MATCH` | 4 | Nobody wants a fifth. The seen-list is persisted, so stopping loses nothing. |

Plus: one card at a time, highest priority wins, and total suppression while
`radialOpen || drawerOpen || underAttack` — never talk over a player who is
mid-decision or being attacked.

### Novice detection

A new `localStorage` key, `ptg-profile`, holding `matchesStarted`, `seenHints`
and a tri-state `hintsEnabled`. Hints offer themselves while
`matchesStarted <= NOVICE_MATCHES` (3); an explicit toggle outranks that in
both directions.

**Rejected: putting this on the account.** The `users` table would have been
the obvious home, and it is wrong here. Accounts are entirely optional — a
build with no API server hides every sign-in affordance — and a first-time
player is precisely the person least likely to have registered, so an
account-backed novice test would be blind to exactly the audience it exists to
serve. A dismissed hint reappearing because you signed out is also worse than
one that fails to follow you to a new device.

Every read is wrapped: Safari in private mode throws on `localStorage` access
(the reason `net/api.js`'s token accessor is wrapped), and a corrupt value is
repaired field-by-field rather than spread. That last part is not theoretical —
`seenHints.includes()` on a *string* silently succeeds and matches substrings,
so a bad stored value would have suppressed unrelated hints rather than
erroring. There is a test for it.

## Two bugs found by running the game, invisible to the unit tests

Both were caught by driving a real Chromium session, not by the suite, and
both came from the same line: `beginMatch` ends with
`if (!isSkirmish()) vehiclePicker.setOpen(true)`.

1. **Every hint was suppressed forever in sandbox.** The suppression gate
   includes `drawerOpen`, and sandbox opens the vehicle picker at match start
   and leaves it open. The first browser run produced a correct
   `matchesStarted: 1` and zero hints, ever.
2. **The "here are your menus" hint retired itself.** `setOpen(true)` fires the
   picker's `onOpen`, which latches `hintProgress.openedDrawer` — crediting the
   player with opening a drawer the game opened for them.

Fixed by resetting `hintProgress` at the *end* of `beginMatch`, after the
auto-open, so only a drawer the player opens themselves counts. The suppression
gate itself was kept: a card raised behind a drawer is invisible anyway (the
CSS hides the layer on `body.drawer-open`), so raising one would spend it for
nothing.

The general lesson is the one this repo keeps relearning, most recently in
`facility-clearance-control.md`: a unit test over injected state cannot see
what the real call order does.

## Verified

- `npm test` — 590/590. (The suite reports 26 failures with no `node_modules`
  present; those are missing-dependency errors, not test failures, and clear
  once `npm install` has run.)
- **Negative controls**, per `CLAUDE.md`. Eight guards were reverted one at a
  time; each failed **exactly one** test, and the right one, on a behavioural
  assertion rather than a missing import: the opening quiet period, the
  minimum gap, the per-match cap, the suppression gate, unconditional
  retirement evaluation, disable-clears-a-visible-card, the `seenHints` type
  repair, and the novice window.
- **Driven in Chromium** (`playwright-core`, swiftshader): portal → sandbox →
  match. Confirmed no card at 10s of render time and the first at 14s
  (`OPENING_QUIET_SECONDS` is 12); correct desktop wording; `.hint-layer`
  computed `pointer-events: none` with the card itself `auto`; OK dismissing
  and writing `seenHints: ["move"]`; nothing at +20s and the second hint
  ("Giving orders") at +34s, confirming both the 30s gap and the priority
  order; the layer going to `opacity: 0` when the settings drawer opens; and
  `openedDrawer` latching only on a player click. Screenshotted.
- `npm run build` clean.

Note for anyone doing the same: headless swiftshader runs at roughly half
speed, so wall-clock waits are misleading — the driver polls
`window.__hints.elapsed` instead. An early run looked like a total failure and
was simply still inside the quiet period.

## Deliberately not done

- **Radial-menu previews in hints.** Asked for, and deferred. `RadialMenu` has
  a single shared `#radial-menu` root and `openFor` fires `onHold`, which
  submits a `menuHold` intent — so a preview needs a `{preview: true}` path
  that skips the callback and the click handlers, or a second root. The hints
  teach the *gesture* instead and point at the real menu. Worth doing on top of
  a system already proven in play.
- **Cloud-synced hint progress.** Would need a new table and route; see the
  reasoning above for why the local store is the right default regardless.
- **Competence detection beyond `retiredWhen`.** Suppressing a hint because
  `structuresBuilt > 0` at match start (a returning player restoring a save)
  is a real improvement and is not implemented.
- **A low-power / low-credit warning hint.** There is no economy alert system
  to hook — `power-spire` is decorative — and inventing one for a hint would be
  the tail wagging the dog.
- **Hints for the crystal-field radial menu** (`fieldCommands`). Reachable, but
  a fifth hint in an already-capped match.
