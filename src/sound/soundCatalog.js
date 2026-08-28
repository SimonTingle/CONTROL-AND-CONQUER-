/**
 * Which authored sounds a given game mode is allowed to play.
 *
 * Deliberately a mirror of `src/builder/customCatalog.js`, not a second rule
 * invented for sound. Reusing the same `OFFLINE_MODES` / `MATCH_SUPPLIED_MODES`
 * allowlists means there is one answer in this codebase to "may this
 * machine's own content enter this mode", and adding a mode later has to opt
 * in for both vehicles and sounds rather than half-inheriting permission.
 *
 * The reasoning that produced those allowlists is *stronger* here in one sense
 * and much weaker in another, and it is worth being precise about which.
 *
 * **Weaker: a sound cannot desync a match.** Audio is presentation-only
 * (CLAUDE.md, and `audio.js`'s own header) — it never reaches `stateHash`,
 * `snapshot` or a simulated value. A peer hearing a different explosion is a
 * cosmetic difference, not a divergence. So the desync argument that bars
 * local *vehicles* from online play does not apply.
 *
 * **Stronger: a sound is executable content in a way a vehicle def is not.**
 * A recipe is instructions to allocate an `OfflineAudioContext` and render a
 * graph on every peer that hears it. An unbounded recipe is a denial of
 * service against the whole lobby. That is why `validateRecipe` runs
 * server-side as well, and why the online path still takes its sounds from
 * the match rather than from whatever a peer happens to have locally.
 *
 * Separate from the persistence in `customSounds.js` for the same reason
 * `customCatalog.js` is separate: `npm test` must stay dependency-free, so
 * the policy lives in a file that imports nothing but the recipe model.
 */
import { OFFLINE_MODES, MATCH_SUPPLIED_MODES } from '../builder/customCatalog.js';

export { OFFLINE_MODES, MATCH_SUPPLIED_MODES };

/**
 * The recipes the game should install for a mode, as a list ready for
 * `audio.setRecipes()`.
 *
 * - **Offline** (`sandbox`, `multiplayer-ai`) — this machine's own finished
 *   sounds. Nothing is replicated, so a sound only this machine has is
 *   entirely harmless.
 * - **Match-supplied** (`multiplayer-online`) — the match's set, pinned from
 *   the host and relayed identically to every peer, and bounds-checked by the
 *   server before it is ever sent.
 * - **Anything else** — built-in sounds only.
 *
 * Drafts never play, whatever the mode: an unfinished sound belongs in the
 * editor's list. Recipes with no `event` are dropped here rather than at the
 * call site — an unbound recipe is a valid thing to have saved, it just has
 * nothing to override.
 */
export function soundCatalogFor(mode, customRecipes = [], matchRecipes = []) {
  const source = MATCH_SUPPLIED_MODES.has(mode)
    ? matchRecipes
    : OFFLINE_MODES.has(mode)
      ? customRecipes
      : null;
  if (!source) return [];
  return source.filter((r) => r && !r.draft && r.event);
}
