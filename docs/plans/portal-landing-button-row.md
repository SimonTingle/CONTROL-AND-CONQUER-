# Portal landing screen: image background and a five-button row

## Context

`public/landscape-game-photo.png` shipped in the repo but was never referenced
by any HTML, CSS, or JS — the portal (landing) screen instead rendered on a
flat `rgba(5, 8, 12, 0.94)` background with a 3-card grid (Sandbox Test,
Multiplayer AI, Multiplayer Online) plus a small "sign in / create account"
link tucked in the top-right corner. The photo itself is composed with its
lower third faded to black, clearly meant as a footer band for UI chrome.

The request was to put that band to use: make the photo the portal's
background, move sign-in into the button row alongside the three existing
modes (so it's "the same size as the rest"), and add a fifth button, God
Mode, visible only when signed in as `tingleteaching@gmail.com`. God Mode
itself does nothing yet — this change only gates its visibility.

## Design

**Layout.** `#portal` switched from `justify-content: center` (title, hint,
and grid all vertically centered as one block) to `flex-direction: column`
with the title block pinned near the top (`.portal-panel { margin-top: 9vh }`)
and the button row `position: absolute; bottom: 6%` within `#portal` itself —
independent of the title's flow, so it lands in the image's black band
regardless of title height. A `linear-gradient` layered under the
`url(...)` background darkens only the top ~62% of the image, where the
title sits on open sky/terrain; the image's own fade handles the bottom
third, so no separate overlay was needed there.

`#lobby` shared `#portal`'s block before this change (a deliberate "one
place to change how a full-screen screen looks," per the existing CSS
comment). Splitting `#portal`'s background out required giving `#lobby` its
own `justify-content` and `background`/`backdrop-filter` rules rather than
leaving it in the shared selector — `#lobby` keeps the original flat/blurred
look; only `#portal` picked up the photo.

**Five equal buttons, not four-plus-one.** `portalScreen.js`'s `buildGrid()`
previously built two independent things: `renderAccountBar()` (top-right,
tiny, always present when a backend is configured) and a `.portal-grid` of
three `.portal-card`s (name + blurb, cards). The button row is a new third
piece, `renderButtonRow()`, built from scratch rather than reusing
`.portal-card` — the request was for uniform, single-line buttons, and
`.portal-card`'s two-line name+blurb layout doesn't produce equal-height
buttons when one entry ("Sign in / create account") is longer than the
others. `.portal-card` itself was left alone: `showComingSoon()`'s "Back"
button still uses it, and it's otherwise dead now that the grid it styled is
gone, but removing it wasn't part of this change's scope. The corner
`renderAccountBar()` also stays — the button row's sign-in entry calls the
same `onSignIn`/`onSignOut` handlers, it's just a second, larger entry point
to the same flow, not a replacement.

**God Mode's gate is a display check, not an auth boundary.** It reads
`this.account.getAccount?.().email === 'tingleteaching@gmail.com'`, the same
pattern `renderAccountBar()` already uses to decide what to render. This
only controls whether the button is drawn — the account's email is supplied
by whichever session cookie the browser is holding, exactly like every
other piece of account-gated UI in this file (cloud saves, the corner
sign-out link). Nothing server-side is added or expected: the button does
nothing yet, so there's nothing to protect on the server side either. If a
future change wires it to an actual privileged action, that action needs
its own server-side check — this client-side conditional is not it.

**Reactivity.** `refreshAccount()` — called by `main.js` after sign-in,
sign-out, and the initial `api.me()` session restore — previously only
re-ran `renderAccountBar()`. It now also re-runs `renderButtonRow()`, since
God Mode's visibility depends on the same account state and needs to
appear/disappear at the same three call sites without `main.js` knowing
anything changed.

## What this does not cover

- **God Mode's actual behavior.** The button is inert by design (per the
  request); wiring it to a real feature is future work, and would need to
  decide whether "does nothing" becomes something server-enforced or purely
  client-side cosmetic.
- **`.portal-card` cleanup.** Dead as a grid style now that `buildGrid()`
  doesn't build a grid, but still used by `showComingSoon()`'s back button.
  Left in place.
- **Mobile-specific tuning beyond the existing breakpoint.** The 620px
  `flex-wrap` rule (two buttons per row, God Mode alone on its own row) was
  verified at a 400px viewport but not tuned further — see Verification.

## Verification

- `node --check src/ui/portalScreen.js` — no syntax errors.
- `npx vite build` — production build succeeds, `dist/index.html` and the
  hashed asset bundle are produced with no new warnings beyond the
  pre-existing >500 kB chunk-size notice (unrelated to this change).
- Visual, via Playwright against a throwaway `test-portal.html` harness (not
  committed) that imports `PortalScreen` directly with a fake `account`
  object, so all three account states could be exercised without a real
  backend or session:
  - **Signed out:** four buttons (sign-in, three modes) render on the
    image's black band, equal width, neon cyan glow matching the existing
    `.rm-item` radial-menu styling.
  - **Signed in as `tingleteaching@gmail.com`:** a fifth "God Mode" button
    appears; the row's five buttons share a common height via flexbox's
    default `align-items: stretch`, so the two-line "Sign in / create
    account" label doesn't produce a visibly shorter or taller button than
    its neighbors.
  - **Signed in as a different address:** four buttons only — confirms the
    gate checks the specific email, not merely "is someone signed in."
  - **400px viewport, God Mode visible:** the `@media (max-width: 620px)`
    rule wraps the row to two buttons per line, with the fifth (God Mode)
    alone on its own final row; all five remain legible against the image.
- `npm test` — 29/29, unchanged from before this change (no simulation code
  was touched, so no new unit tests were needed; there is nothing
  deterministic to check here — the change is DOM/CSS in an untested UI
  layer, same as the rest of `src/ui/`).

Not verified: an actual sign-in flow against a running API server (the
Playwright pass used a fake `account` object instead, since standing up
Postgres + the API server wasn't necessary to exercise `PortalScreen`'s own
rendering logic in isolation); cross-browser rendering (checked in Chromium
only, via the pre-installed Playwright browser).
