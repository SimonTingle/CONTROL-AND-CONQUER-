/**
 * Persistence for authored sounds.
 *
 * Rides the existing cloud-saves table exactly as `customVehicles.js` does —
 * `POST /saves` already stores arbitrary JSON per user, upserting on
 * (user_id, name), and `mode` is free-form text up to 32 characters. So this
 * whole feature needs **zero backend change** to save and load; only the
 * online relay (a later phase) touches the server at all.
 *
 * The mode rule itself lives in `soundCatalog.js`, which does no I/O, so
 * `npm test` can exercise it without a backend or Vite's injected globals.
 */
import { api } from '../net/api.js';
import { SOUND_SAVE_MODE, SOUND_SCHEMA_VERSION, syncId, validateRecipe } from './soundRecipe.js';

export { SOUND_SAVE_MODE };
export { soundCatalogFor, OFFLINE_MODES } from './soundCatalog.js';

/** List the signed-in user's sounds. Returns [] when there is no backend. */
export async function listCustomSounds() {
  if (!api.isConfigured) return [];
  const saves = await api.listSaves();
  return saves.filter((s) => s.mode === SOUND_SAVE_MODE);
}

/**
 * Fetch and unwrap every saved sound.
 *
 * A row whose payload no longer validates is skipped rather than thrown on:
 * one bad save must not stop the editor opening. The problems come back
 * alongside so the dashboard can say which sound is broken and why.
 *
 * @returns {Promise<{recipes: object[], broken: {name: string, problems: string[]}[]}>}
 */
export async function loadCustomRecipes() {
  const rows = await listCustomSounds();
  const recipes = [];
  const broken = [];

  for (const row of rows) {
    let payload;
    try {
      payload = (await api.getSave(row.id))?.payload;
    } catch {
      broken.push({ name: row.name, problems: ['Could not be loaded.'] });
      continue;
    }
    const recipe = payload?.recipe;
    // Ids are content addresses, so one written by an older build may not
    // match its own contents. Re-derive before validating rather than
    // rejecting the row: the sound is still good, and the id was always
    // derived data that happened to be persisted.
    if (recipe && typeof recipe === 'object') syncId(recipe);
    const problems = validateRecipe(recipe);
    if (problems.length) broken.push({ name: row.name, problems });
    else recipes.push({ ...recipe, draft: payload.draft === true, saveId: row.id, saveName: row.name });
  }

  return { recipes, broken };
}

/**
 * Save one sound. Upserts on the name, matching the saves API's own rule — so
 * renaming creates a new row and re-saving overwrites, which is what the
 * dashboard's list already implies.
 */
export function saveCustomSound(name, recipe, { draft = false } = {}) {
  return api.putSave(name, SOUND_SAVE_MODE, SOUND_SCHEMA_VERSION, { draft, recipe });
}

export const deleteCustomSound = (saveId) => api.deleteSave(saveId);
