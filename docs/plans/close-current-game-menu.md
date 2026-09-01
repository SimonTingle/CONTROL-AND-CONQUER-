# "Close current game" in the hamburger menu

## Context

Follow-up to `docs/plans/orphaned-match-hijack.md`, which the user confirmed
fixed in production ("it works"). Two requests once that was resolved:

1. Record the fix as a milestone somewhere durable — added to
   `bug-fixed.md`'s "Online multiplayer" section, since it is the resolution
   of the very first entry that section traces back to.
2. Add a manual way out of a live online match, reachable from the hamburger
   menu, alongside Statistics and World Settings: "Close current game",
   ending the match and returning to the lobby to create or join another.

## What already existed

`main.js` already had `leaveOnlineMatchDeliberately()` — used today from a
"Leave match" action inside stall-warning toasts. It tells the server (so
`match_players`/`matches.status` don't keep the match alive server-side,
which is exactly what `abandonOrphanedMatches()`'s fix is about — a
deliberate leave that skipped the server call is exactly the shape of bug
that produces a new orphaned row) and then does a full reload, which is the
established pattern here (`endOnlineMatch`'s own header explains why a
reload, not an in-place return to the portal).

This change just exposes that same function from a place the player can
reach any time a match is running, not only when the client itself has
already decided something is wrong.

## What changed

- **`src/ui/menu.js`**: `Menu`'s constructor takes an optional
  `{ isMatchActive, onCloseGame }`. `renderChooser()` — the hamburger's
  landing page — appends a third item, "Close current game", only when
  `isMatchActive()` is true at the moment the chooser renders (every time
  the drawer opens, per `setOpen()`'s existing "always land on the chooser"
  behavior). Clicking it calls `onCloseGame()`.
- **`src/main.js`**: passes `isMatchActive: () => !!match` and
  `onCloseGame: () => leaveOnlineMatchDeliberately()` into `Menu`'s
  constructor.
- **`src/main.js`, TDZ fix**: `Menu`'s constructor calls `renderChooser()`
  synchronously, which calls `isMatchActive()` immediately — and `match`
  used to be declared with `let match = null` much further down the file,
  in the "Online match session" section. Referencing `match` in a closure
  before that line is fine; *calling* that closure before the line has run
  throws `ReferenceError: Cannot access 'match' before initialization`
  (confirmed live — the very first browser check hit exactly this).
  Fixed by hoisting the bare `let match = null;` declaration up next to
  `chatter`'s construction, ahead of `new Menu(...)`, and leaving a comment
  at the old declaration site pointing to the new one.

## Verification

- **`npm run build`** (root) — passes.
- **Live browser check** (Playwright, sandbox mode — no server needed):
  before the TDZ fix, loading the page at all threw
  `Cannot access 'match' before initialization` as a page error. After the
  fix, the page loads cleanly and the hamburger chooser shows exactly
  `["Statistics", "World Settings"]` with no match active — confirming both
  the crash is gone and the new item does not appear when it shouldn't.
- **`npm test`** (root, dependency-free) — 518 pass, unaffected.
- `itch.io/` synced and built.
- **Not verified**: showing the item during a real live online match (would
  need two real accounts and a live server exchange, which this environment
  cannot do) or that clicking it actually reaches the lobby afterward end to
  end. The click path reuses `leaveOnlineMatchDeliberately()` verbatim — an
  existing, already-shipped, already-used function — so this only adds a
  second call site to it, not new match-ending logic.
