# Sign In, Sandbox and Multiplayer AI were one-way doors

## Problem

Reported directly: opening Sign In, the Sandbox difficulty picker, or the
Multiplayer AI difficulty picker from the portal left no way back to the
portal short of a full page reload. `LobbyScreen` (Multiplayer Online) already
had a working `onBack` that rebuilt and re-showed the portal; the other three
screens simply never grew the equivalent.

Confirmed by grep before touching anything: `difficultyScreen.js` and
`aiDifficultyScreen.js` had zero matches for `onBack|Back|class=` — no back
mechanism existed at all, not a hidden or broken one. `authScreen.js` had a
`skip` button ("Continue without an account") that also returns to the
portal, but reads as a decision about the account, not as "I opened this by
accident."

## Fix

Same pattern in all three screens, following `LobbyScreen`'s existing
`onBack` precedent rather than inventing a new one:

- `DifficultyScreen` and `AiDifficultyScreen` constructors take an optional
  second `onBack` callback. A `back()` method, shaped identically to the
  existing `choose()`/`selectCard()` completion methods (same open-guard,
  same hide-then-callback order), hides the screen and calls it. A `← Back`
  button styled with the existing generic `.portal-card.portal-back` classes
  (already used by `portalScreen.js`'s god-mode screen and
  `matchEndScreen.js` — not previously used outside those two) is appended
  to each panel.
- `AuthScreen` gets a small `.auth-back` link in the corner of the panel,
  calling the same `close(null)` the existing skip button calls. Left `skip`
  untouched — the two buttons serve different intents and neither is
  redundant with the other.
- `main.js` extracts the three-line "rebuild and reveal the portal" sequence
  (previously duplicated inline in `LobbyScreen`'s `onBack` and its
  `onStart` failed-join `.catch()`) into one `returnToPortal()` helper, and
  wires it as the `onBack` for `DifficultyScreen`, `AiDifficultyScreen`, and
  both `LobbyScreen` call sites.

## Verification

- `node --check` on all four touched JS files.
- `npm run build` (root) and the `itch.io` fork's own build both pass after
  `sync-from-main.sh`.
- `npm test`: 527/527 passing, unaffected (no test coverage existed or was
  added for this — pure UI wiring, matching the precedent set by the earlier
  button-row/version-badge layout change).
- Live Playwright check at both a 1440×900 desktop viewport and a 390×844
  mobile viewport: opened Sandbox, clicked `← Back`, confirmed `#portal`
  lost its `hidden` class and `#difficulty` gained it; same for Multiplayer
  AI/`#ai-difficulty`; confirmed `.auth-back` renders in the Sign In panel.
  One transient click-interception timeout on the first mobile run reissued
  as a `force` click and passed identically — not a real bug, `#portal.hidden`
  already sets `pointer-events: none` in the stylesheet.

## Not investigated

`LobbyScreen`'s own back button and the portal's other entry points
(settings drawer, cloud-save prompts) were not touched — only the three
screens named in the report.
