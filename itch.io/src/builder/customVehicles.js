/**
 * Persistence for author-built vehicles, and the one place they are allowed
 * to reach the game's catalog.
 *
 * Rides the existing cloud-saves table rather than adding one: `POST /saves`
 * already stores arbitrary JSON per user, upserting on (user_id, name). The
 * only thing distinguishing a vehicle from a world snapshot is `mode`.
 *
 * The multiplayer rule lives here, in `catalogFor()`, because it is the single
 * point where a custom def can enter the game. Only `defId` strings cross the
 * wire (snapshot.js serialises `defId`, and the far end resolves it against
 * its own catalog), so a vehicle one peer has and the other does not is a
 * desync — restore skips the unknown id and silently drops the unit. Until the
 * full def is transmitted at match start, custom vehicles are single-player.
 */
import { api } from '../net/api.js';
import { DRAFT_SCHEMA_VERSION, validateDef, syncId } from './vehicleDraft.js';

// Re-exported so callers have one import for "custom vehicles", while the rule
// itself stays in a file `npm test` can load without Vite's injected globals.
export { catalogFor, OFFLINE_MODES } from './customCatalog.js';

/** Marks a save row as a vehicle rather than a world snapshot. */
export const VEHICLE_SAVE_MODE = 'vehicle-def';

/** List the signed-in user's vehicles. Returns [] when there is no backend. */
export async function listCustomVehicles() {
  if (!api.isConfigured) return [];
  const saves = await api.listSaves();
  return saves.filter((s) => s.mode === VEHICLE_SAVE_MODE);
}

/**
 * Fetch and unwrap every saved vehicle.
 *
 * A row whose payload no longer validates is skipped rather than thrown on:
 * one bad save must not stop the editor opening or the picker building. The
 * problems are returned alongside so the UI can say which vehicle is broken.
 *
 * @returns {Promise<{defs: object[], broken: {name: string, problems: string[]}[]}>}
 */
export async function loadCustomDefs() {
  const rows = await listCustomVehicles();
  const defs = [];
  const broken = [];

  for (const row of rows) {
    let payload;
    try {
      payload = (await api.getSave(row.id))?.payload;
    } catch {
      broken.push({ name: row.name, problems: ['Could not be loaded.'] });
      continue;
    }
    const def = payload?.def;
    // Ids are content-addressed, so one stored by an older build (when they
    // were name slugs) no longer matches its own contents. Re-derive before
    // validating rather than rejecting the row: the def itself is still good,
    // and the id was always derived data that happened to be persisted.
    if (def && typeof def === 'object') syncId(def);
    const problems = validateDef(def);
    if (problems.length) broken.push({ name: row.name, problems });
    else defs.push({ ...def, draft: payload.draft === true, saveId: row.id, saveName: row.name });
  }

  return { defs, broken };
}

/**
 * Save one vehicle. Upserts on the name, matching the saves API's own rule —
 * so renaming creates a new row and re-saving overwrites, which is what the
 * left-hand list already implies.
 */
export function saveCustomVehicle(name, def, { draft = false } = {}) {
  return api.putSave(name, VEHICLE_SAVE_MODE, DRAFT_SCHEMA_VERSION, { draft, def });
}

export const deleteCustomVehicle = (saveId) => api.deleteSave(saveId);
