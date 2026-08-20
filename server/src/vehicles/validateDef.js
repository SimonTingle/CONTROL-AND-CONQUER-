/**
 * The server's half of vehicle validation.
 *
 * Deliberately *not* a copy of the client's `validateDef`. The two check
 * different things because they are defending against different failures, and
 * only one of them can be done here:
 *
 * - **The client** checks structural safety — that `buildVehicleMesh` will not
 *   throw on the def, that the axle arrays agree, that the lights block the
 *   renderer dereferences without a default is present. That needs
 *   `catalog.js` and `structures.js`, which are not in this image, and it
 *   protects the machine doing the rendering. Every peer runs it on the bytes
 *   it receives, and since those bytes are identical everywhere, so is the
 *   verdict.
 * - **The server** checks the stat bounds, because that is the only check a
 *   client cannot be trusted with. A def is authored on one machine and played
 *   on everyone else's; `speed: 1e6` is not a rendering problem, it is a
 *   fairness one, and the authoring client is exactly the party with a motive
 *   to skip the check.
 *
 * Bounds come from `vehicleBounds.js`, generated from the editor's own slider
 * ranges — see scripts/sync-vehicle-bounds.mjs. Nothing here invents a number.
 */
import { VEHICLE_BOUNDS } from './vehicleBounds.js';

/** Read `a.b.c`, undefined if any step is missing. Mirrors builderSchema's. */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Paths the mesh builder only reads when the matching shape flag is set.
 * Kept in step with the client's own list for the same reason it exists there:
 * two shipped vehicles carry zeroed turret dimensions because they have no
 * turret, and a validator stricter than the engine would reject them.
 */
const TURRET_ONLY = ['dims.turretRadius', 'dims.turretHeight', 'dims.barrelRadius', 'dims.barrelLength'];
const TRACKED_ONLY = ['dims.roadWheels', 'dims.trackWidth', 'dims.trackThickness', 'pivotRate'];

function isDormant(path, def) {
  if (!def?.shape?.turret && TURRET_ONLY.includes(path)) return true;
  if (!def?.shape?.tracked && TRACKED_ONLY.includes(path)) return true;
  return false;
}

/**
 * @returns {string[]} problems; empty means the def is within bounds.
 */
export function boundsProblems(def) {
  if (!def || typeof def !== 'object') return ['Not a vehicle definition.'];
  const problems = [];

  if (typeof def.id !== 'string' || !def.id.startsWith('custom:')) {
    problems.push('id must be a custom: id.');
  }
  if (typeof def.name !== 'string' || !def.name.trim()) problems.push('Needs a name.');

  for (const [path, { min, max }] of Object.entries(VEHICLE_BOUNDS)) {
    if (isDormant(path, def)) continue;
    const value = getPath(def, path);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${path} must be a number.`);
    } else if (value < min || value > max) {
      problems.push(`${path} must be between ${min} and ${max}.`);
    }
  }
  return problems;
}

/** Convenience predicate for filtering a host's loadout. */
export const isWithinBounds = (def) => boundsProblems(def).length === 0;
