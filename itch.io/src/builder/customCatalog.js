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
 * The catalog the game should use for a mode.
 *
 * Drafts never appear in-game whatever the mode — an unfinished vehicle is for
 * the editor's left column only. Returns a new array; the built-in catalog is
 * never mutated.
 */
export function catalogFor(mode, customDefs = []) {
  if (!OFFLINE_MODES.has(mode)) return VEHICLE_CATALOG;
  const usable = customDefs.filter((d) => !d.draft);
  return usable.length ? [...VEHICLE_CATALOG, ...usable] : VEHICLE_CATALOG;
}
