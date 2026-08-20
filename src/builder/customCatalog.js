/**
 * Which vehicles a given game mode is allowed to see.
 *
 * Deliberately separate from customVehicles.js, which does the network I/O:
 * this is the rule that keeps an unshareable vehicle out of a lockstep match,
 * and it should be testable without a backend, a browser, or Vite's injected
 * globals. `npm test` must stay dependency-free, so the policy lives in a file
 * that imports nothing but the catalog.
 *
 * Why the rule exists: only `defId` strings cross the wire. snapshot.js
 * serialises `defId` and the far end resolves it against *its own* catalog,
 * skipping ids it does not recognise. A vehicle one peer built and the other
 * has never seen therefore doesn't error — it produces a unit that exists on
 * one screen and not the other, which is the silent divergence the last three
 * rounds of multiplayer work were spent removing.
 *
 * Online play is no longer barred by that, but the reasoning is unchanged: it
 * is allowed *because* the match now supplies one vehicle set to every peer
 * (pinned from the host's loadout at creation, relayed in `welcome`), not
 * because the risk went away. Local vehicles are still refused online — see
 * MATCH_SUPPLIED_MODES below.
 */
import { VEHICLE_CATALOG } from '../vehicles/catalog.js';

/**
 * Modes where a vehicle only this machine knows about is harmless, because
 * nothing about them is replicated to a peer.
 *
 * An allowlist rather than a `!== 'multiplayer-online'` test, deliberately.
 * Every desync this project has had came from a path that assumed anything it
 * did not recognise was safe; a mode added later must have to opt *in* to
 * custom vehicles, not inherit permission by not being named here.
 */
export const OFFLINE_MODES = new Set(['sandbox', 'multiplayer-ai']);

/**
 * Modes where the vehicle set is supplied by the match rather than by this
 * machine. Also an allowlist, and for the same reason: a mode nobody has
 * thought about must not inherit permission to replicate anything.
 */
export const MATCH_SUPPLIED_MODES = new Set(['multiplayer-online']);

/**
 * The catalog the game should use for a mode.
 *
 * Three cases, and which one applies is decided by allowlist in both
 * directions so an unrecognised mode still falls through to built-ins alone:
 *
 * - **Offline** — this machine's own finished vehicles are added. Nothing is
 *   replicated, so a vehicle only this machine knows about is harmless.
 * - **Match-supplied** — `matchDefs` is used and the local ones are ignored
 *   *entirely*. That is the load-bearing part: the host's loadout is pinned
 *   into the match and relayed identically to every peer in `welcome`, so
 *   every client resolves a given defId to the same bytes. Mixing in local
 *   vehicles would reintroduce exactly the divergence this file exists to
 *   prevent — one peer resolving an id nobody else has.
 * - **Anything else** — built-ins only.
 *
 * Drafts never appear in-game whatever the mode; an unfinished vehicle is for
 * the editor's left column. Returns a new array; VEHICLE_CATALOG is never
 * mutated.
 */
export function catalogFor(mode, customDefs = [], matchDefs = []) {
  const source = MATCH_SUPPLIED_MODES.has(mode)
    ? matchDefs
    : OFFLINE_MODES.has(mode)
      ? customDefs
      : null;
  if (!source) return VEHICLE_CATALOG;
  const usable = source.filter((d) => d && !d.draft);
  return usable.length ? [...VEHICLE_CATALOG, ...usable] : VEHICLE_CATALOG;
}
