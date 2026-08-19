# Mobile UI: the vanishing hamburger, oversized panels, and a drawer collision found along the way

## The report

Three symptoms: the settings menu, vehicle drawer and minimap are too big on
mobile; shadows and vehicle lights must stay exactly as they are; and
sometimes pinch-zooming on mobile makes the hamburger menu buttons
unreachable in portrait mode, on unspecified devices ("adapt for all mobile
scenarios").

## The vanishing hamburger: a real bug, confirmed in the CSS before touching anything

The viewport meta tag was `width=device-width, initial-scale=1.0` — nothing
restricted pinch-zoom. `touch-action: none` existed only on `#viewport`
(`style.css`, pre-existing), scoped there specifically so a finger-drag orbits
the camera instead of the browser trying to scroll/pinch-zoom the page — but
that scoping means a pinch starting a few pixels off the canvas, e.g. right on
a toggle button, was never refused. It reached the browser's native page zoom,
which shifts the *visual* viewport under every `position: fixed` element:
both toggles, both drawers, the HUD, the minimap. Nothing in the app listens
for `visualViewport` changes, and there was no `env(safe-area-inset-*)`
anywhere either, so a notch could eat a hardcoded 16px inset independently of
zoom. Since `MapControls` already gives the player pinch-to-zoom-*camera* as
the in-game equivalent, native page zoom serves no purpose here at all.

Fixed with both mechanisms together, deliberately redundant: the viewport
meta gained `maximum-scale=1.0, user-scalable=no` (the one iOS Safari has
historically honoured most reliably), and `html, body` gained
`touch-action: none` to extend the canvas's own existing protection to the
rest of the page. Verified in a real browser rather than assumed: a synthetic
two-finger pinch dispatched via CDP, both over the canvas and directly on the
settings toggle, left `window.visualViewport.scale` at exactly `1` in both
cases, before and after.

**That broke scrolling**, predictably — `touch-action` set on an ancestor
restricts descendant gesture handling by default in every engine. The four
regions that were `overflow-y: auto` (`#panel`, `#vehicle-panel`,
`.save-field-suggestions`, `.builder-left`/`.builder-right`) each needed
`touch-action: pan-y` to opt back into vertical scrolling — deliberately not
`manipulation`, which would have let pinch-zoom back in on exactly those
elements. Verified with a synthetic touch-drag inside the settings panel:
`scrollTop` moved from 0 to 445px despite the page-wide `none`.

## Sizing: percentage-based, not a second guessed breakpoint

Only one mobile breakpoint existed anywhere in the stylesheet
(`max-width: 720px`), and it touched nothing but the minimap. Both drawers
were `width: var(--panel-width)`, a flat `320px` at every viewport size — on
a 320-375px phone that's most of the screen.

`--panel-width` is overridden inside that same breakpoint to
`min(88vw, 340px)`: a percentage scales correctly at any width under 720px
rather than assuming one particular phone, and the `340px` cap keeps a large
phone/small tablet close to the desktop size once there's room to spare. Since
the minimap's open-drawer shift-aside distance already reads this same
variable, it follows with no separate change. Confirmed directly: at a 320px
viewport the computed panel width was `281.59375px`, exactly `88vw` of 320.

The minimap's existing 132px step at 720px stays; a second step at
`max-width: 480px` shrinks it to 104px, confirmed to fire correctly at a
320px viewport.

The radial command wheel (`.rm-ring`, 196px) is different in kind: its button
positions are computed in `radialMenu.js` from a hardcoded `RING_RADIUS`
constant in pixels, so no stylesheet alone can resize it. It's scaled by
appending `scale(0.72)` to the same per-frame `transform` the component
already sets on its zero-size anchor, gated by a module-scope
`matchMedia('(max-width: 480px)')` in the same style as the file's existing
touch-detection check nearby. Scaling composes about the anchor's own local
origin correctly as-is — the anchor point doesn't move, only the ring shrinks
around it. Confirmed both directions: 141px (`196 × 0.72`) at a 375px
viewport, 196px unscaled at 1280px.

## A bug found during verification, not in the original report

Screenshotting the fix at 320px showed both drawers open and badly
overlapping. The settings menu and vehicle drawer are two independently
built components (`Menu`, `VehiclePicker`) with no awareness of each other.
On a desktop-width window that's harmless — two 320px panels from opposite
screen edges never meet — but sandbox mode opens the vehicle drawer
automatically at match start, so on a narrow phone the *default* state is
already both drawers fighting for the same space, and shrinking either one
further doesn't fix two of them stacked.

Fixed with an `onOpen` hook on each (`setOpen(true)` calls it), wired in
`main.js` only after both instances exist:

```js
const NARROW_VIEWPORT = matchMedia('(max-width: 720px)');
menu.onOpen = () => { if (NARROW_VIEWPORT.matches) vehiclePicker.setOpen(false); };
vehiclePicker.onOpen = () => { if (NARROW_VIEWPORT.matches) menu.setOpen(false); };
```

Gated on the same breakpoint the panel-width shrink uses, so desktop is
provably unaffected — confirmed both drawers stay open together at 1280px
with the flat 320px width unchanged. On mobile, confirmed both directions:
opening settings while the vehicle drawer was open (sandbox's default state)
closed it, and re-opening the vehicle drawer closed settings back.

## Verification

- No unit test is meaningful here — this is CSS layout plus one
  `matchMedia`-gated transform suffix and two `onOpen` callbacks, none of it
  logic with a behavioural assertion worth pinning, consistent with the
  existing mobile breakpoints in this file having none either.
- `node --test tests/*.test.mjs`: 100/100, unaffected (nothing here touches
  anything under test). `npx vite build` succeeds.
- **Driven in a real browser** (Playwright, device emulation — iPhone SE and
  iPhone 13 profiles), every claim above measured rather than assumed:
  visual-viewport scale pinned at 1 through a synthetic pinch on canvas and
  on a toggle button; drawer scroll still works under a page-wide
  `touch-action: none`; panel width computed exactly `min(88vw, 340px)` at a
  320px viewport; minimap steps to 104px at 480px and below; radial ring
  measured 141px (mobile) vs 196px (desktop), both settled past the
  pre-existing open-animation rather than caught mid-transition; mutual
  drawer exclusion confirmed in both directions on mobile and confirmed
  *inactive* on desktop.
- **Shadows and vehicle lights, the explicit constraint**: a before/after
  screenshot pair (stashed the change, rebuilt, screenshotted a scout buggy
  at forced dusk with headlights forced on; popped the stash, rebuilt,
  repeated) diffed pixel-for-pixel identical — `bbox: None`, max channel
  diff `0`, mean `0.0`. `renderer.shadowMap.enabled`/`.type` unchanged
  (`true` / PCFSoft). Nothing in this change touches `platform.js` or any
  lighting/shadow code, and the diff confirms it.

## What this does not cover

- Landscape-orientation phones were not separately profiled — the
  percentage-based sizing should degrade reasonably (it's width-driven, and
  landscape phones are usually wider than portrait ones), but no landscape
  screenshot was taken.
- Tablets in the 480-720px range get the drawer-width shrink but not the
  tighter minimap step or the radial scale — a deliberate reading of "phone"
  vs "small tablet" from the breakpoints already in the file, not verified
  against a real tablet.
- The drawer mutual-exclusion fix is scoped to `≤720px` alongside the sizing
  work it was found investigating; a device that reports a wider viewport
  but has a genuinely small physical screen (unusual, but not impossible)
  would still see both open.
