# Mobile drawers bury the HUD, the radio and the minimap

An investigation with a fix, prompted by "test a small mobile screen, check how
the hamburger menus affect on-screen text".

## Evidence

Chromium at 320×568, 360×640, 375×667 and 390×844 with touch emulation,
driving a real sandbox match, intersecting the rect of every content element
with the rect of every open drawer. Percentages are of the *content* element's
own area:

| Element | Covered by | 320px | 360px | 390px |
|---|---|---|---|---|
| Radio feed (unit callouts) | **both** drawers | 88 / 100% | 88 / 100% | 86 / 100% |
| HUD (credits, health, load) | right drawer | 90% | 90% | 90% |
| Minimap | left drawer | 78% | 74% | 67% |
| Version badge | draws **over** both | 100% | 100% | 100% |

The worst case is the default first run: `beginMatch` ends with
`if (!isSkirmish()) vehiclePicker.setOpen(true)`, so a new player on a phone
starts the game with the HUD and the radio feed already buried. At 320px the
radio feed is reduced to a ~28px sliver reading "Re…", "pos…".

## Root cause — one thing, not four

Each overlay was taught to dodge only the drawer sharing **its own screen
edge**: `body.settings-open #hud` (left drawer, and the HUD is bottom-left),
`body.drawer-open #minimap` (right drawer, and the minimap is bottom-right).

That is exactly right while a drawer is a 320px panel against one edge. Under
720px the drawer becomes `min(88vw, 340px)` and spans nearly the whole width,
so it covers **both** edges — and the opposite-edge pairing was never written.
`.radio-feed` had no rule at all and, at z-index 12 against the drawers' 15,
simply vanishes underneath whichever one opens.

The version badge fails the other way. At z-index 45 it is *above* the drawers,
so an open drawer does not cover it — the build hash lands directly on the
panel's own "Menu" heading and both become unreadable.

Two of the three narrow-viewport overrides in `style.css` already say in their
own comments that there is nowhere to slide to on a phone and fade instead.
They each reached that conclusion in isolation; nothing generalised it.

## A second, unrelated loss: text inside the drawer, on touch only

- `.vehicle-card-stats` was `max-height: 0; opacity: 0`, revealed **only** by
  `.vehicle-card:hover`. There is no hover on a phone, so speed and turning
  circle were unavailable to every touch player — measured `clientHeight: 0`.
- `.vehicle-card-lock` was `white-space: nowrap` + `text-overflow: ellipsis` in
  a 63–82px cell holding 120px of text, so "Locked — chart 15% of the island"
  rendered as "Locked — char…". That string is the *unlock condition* — the one
  thing telling a player how to earn the vehicle.

## The fix

1. **One cross-cutting rule** at ≤720px fading `#hud`, `.radio-feed`,
   `#minimap` and `.hint-layer` together for `body.settings-open` **or**
   `body.drawer-open`. Fade, not shift: at 320px an open drawer leaves ~38px of
   world, so there is no destination. The wide-screen slide-aside rules are
   untouched and asserted to still work.
2. **Version badge** hidden while either drawer is open (at every width — the
   collision is not phone-specific), and the same string appended to the
   panel's own diagnostics line via `menu.setStats` in `main.js`, read from the
   `getBuildVersion()` the badge itself uses so the two cannot disagree.
   Opening the drawer now *reveals* the build instead of scribbling over it.
3. **Card text** wraps: `.vehicle-card-stats` un-collapsed and wrapped under
   `@media (hover: none)`, `.vehicle-card-lock` wrapped with a two-line clamp.

`@media (hover: none)` is a fourth platform predicate in a file that already
has three that disagree (`core/platform.js`'s `IS_MOBILE`, `main.js`'s
`input.tapToMove`, `radialMenu.js`'s `maxTouchPoints`). It earns its place by
being the only one CSS can ask unaided, with no JS round-trip to style a static
card — but it is a fourth, and worth knowing about.

## Verified

`tests/e2e/mobile-drawer-overlap.mjs`, added here — the same instrument that
produced the table above, turned into assertions. Zero overlaps above 5% at all
three phone widths in every drawer state, chrome restored on close, the build
string present in the panel, both card lines un-clipped, and the desktop
slide-aside intact.

**Negative controls, and one that mattered.** Each fix reverted in turn:
removing the fade rule reproduced all four overlaps; restoring hover-only stats
reproduced the collapse; removing the build string failed the panel check.

The lock-line control **passed** — meaning that assertion tested nothing. It
compared `scrollHeight` against `clientHeight`, but a `nowrap` + ellipsis line
never overflows *vertically*; the clipping is horizontal and only `scrollWidth`
exposes it. Sharpening it to check both dimensions immediately failed the
control **and caught a real bug in the fix itself**: un-collapsing
`.vehicle-card-stats` had made it visible while leaving it `nowrap`, so it
still rendered as "22 u/s · turning circ…" — visible and still unreadable.
Fixed by wrapping it too.

The desktop assertion had the same weakness: `transform !== 'none'` passes on
an identity matrix. It now requires a real translation (+328px for the HUD,
−312px for the minimap), which also exposed that headless swiftshader at ~5fps
needs seconds, not milliseconds, for a 250ms transition to settle — an earlier
run sampled stale transforms and looked like a regression that was not one.

`npm test` 592/592, `npm run build` clean.

## Deliberately not done

- **Full-screen sheet under 480px.** Considered — the 12vw strip of world left
  beside an open drawer is too narrow to read anything and arguably implies the
  game is still visible when it is not. Rejected as a larger UX change than the
  bug required; the fade makes the strip honest.
- **Pausing radio-line expiry while the feed is hidden.** Each line has its own
  9s timer, so callouts made during a long menu visit still expire unseen. Left
  alone: `radioFeed.js`'s header is explicit that it is a live channel and a
  line about a fight that ended is worse than silence.
- **Mirroring any of this into `itch.io/`**, which is a deliberate fork.
- **Hint pacing on mobile.** `HintSystem` refuses to raise a card while a
  drawer is open, and sandbox opens one at match start, so the first hint waits
  for the player to close it. That defers rather than loses, and the deferral
  is the intended "never talk over an open menu" behaviour — but it does mean
  hints start later on a phone than on a desktop.
