# Readd Save/Load to the vs-AI hamburger menu

## Context

`docs/plans/skirmish-settings-restriction.md` (PR #125) restricted the
hamburger menu's World Settings page to Performance/Camera/Sound in **both**
`multiplayer-ai` and `multiplayer-online`, hiding Save/Load along with the
genuinely world-authoring groups (Atmosphere, Terrain shape, Ground, Water,
Game/debug).

Follow-up report: bring Save/Load back for **AI multiplayer** specifically.

## Why this is safe for vs-AI but not online

The distinction the original restriction was actually protecting against is
in `simState()`'s own comment: a control that writes simulation state
mid-*online*-match mutates state the peer has no way of learning about, and
the two clients silently diverge — exactly the failure class
`docs/plans/split-brain-invisible-to-the-hash.md` (PR #124) closed for
structure positions and terrain. Loading a local snapshot is the same shape
of problem, worse: it doesn't nudge one value, it rewinds the whole world.

Vs-AI has no peer to disagree with. Checked directly: `core/snapshot.js`
serializes and restores `game.aiCommanders` in full
(`serializeAiCommanders(ctx)` / `ctx.game?.aiCommanders`, and the matching
restore block keyed by `saved.team.id`), so a save/load round-trip in that
mode leaves the AI's own state exactly as consistent as everything else —
there was never an actual desync risk here, just the same broad-brush "hide
everything but Performance/Camera/Sound" rule applied identically to both
modes when only one of them needed it.

## The change

`src/ui/controlSchema.js`: replaced the single `SKIRMISH_VISIBLE_GROUPS`
list with two explicit ones, since the modes now genuinely diverge:

```js
const ONLINE_VISIBLE_GROUPS = ['Performance', 'Camera', 'Sound'];
const AI_VISIBLE_GROUPS = ['Save / Load', 'Performance', 'Camera', 'Sound'];
```

`buildSchema()`'s trailing filter now looks up the right list by
`game.mode` (`visibleGroupTitles()`) instead of applying one list to both
skirmish modes via `isSkirmishMode()`. `isSkirmishMode` stays exported — it's
still a true, useful predicate ("no world-authoring context") — but no longer
drives the filter directly.

Also extracted `settingsHintFor(game)` into the same file, and had
`menu.js`'s chooser call it instead of its own hand-written ternary. The
previous PR's hint logic lived in `menu.js` with no way to notice if
`controlSchema.js`'s group list changed under it — this fix is exactly that
kind of drift (the hint would otherwise have kept saying "Shadows, camera,
sound" for vs-AI after Save/Load came back). Centralizing it in the file that
already owns the mode → visible-groups mapping removes the second place that
mapping had to be kept in sync by hand.

## Files

- `src/ui/controlSchema.js` — the split lists, `settingsHintFor`.
- `src/ui/menu.js` — one call site switched to `settingsHintFor`.

## Verification

`tests/skirmish-menu-restriction.test.mjs`, extended (dependency-free, same
technique as the original — `buildSchema()` only builds closures at
construction time, so minimal stub `world`/`view`/`game` objects suffice):

- `multiplayer-online` unchanged: exactly `Performance, Camera, Sound`, Save/Load
  still absent.
- `multiplayer-ai` now shows exactly `Save / Load, Performance, Camera, Sound`.
- Save/Load's own control list (its two `save-field` entries) is unchanged
  between sandbox and vs-AI — same parity check the original PR ran for
  Camera/Sound, extended to the newly-reinstated group.
- `settingsHintFor` covers all three modes directly, no DOM needed.

**Negative control**: reverted `AI_VISIBLE_GROUPS` to the old
`['Performance', 'Camera', 'Sound']` and reran — exactly the two Save/Load-
specific assertions failed (`multiplayer-ai shows Save/Load...` and the
control-parity test), all 9 others, including the untouched online tests,
kept passing. Restored, 11/11 green.

`npm test`: **575 passing** (573 before this change; 2 net new — the file
grew from 9 tests to 11).

Live check: sandbox and multiplayer-online behavior confirmed unchanged from
the original PR (same lists, same code path); multiplayer-ai's World Settings
now shows Save/Load first, followed by Performance/Camera/Sound, with the
chooser hint reading "Save/load, shadows, camera, sound".

Both root and `itch.io` fork builds pass.
