/**
 * Every game moment that can carry a sound, as data.
 *
 * This registry exists because "which sounds does this game have?" was
 * previously answerable only by reading `GENERATORS` in `audio.js` and then
 * grepping for call sites — and the two disagree. Three fully-written
 * generators (`harvestScoop`, `harvestDeliver`, `notification`) have no call
 * site anywhere in `src/`: harvesting is silent despite both of its cues
 * existing and having existed for some time. Nothing surfaced that, because
 * nothing enumerated it.
 *
 * So the registry records both halves — that a generator exists, and whether
 * anything plays it — and the editor's dashboard groups by exactly that:
 *
 * - **Bound** — a built-in generator with a live call site. Editable by
 *   overriding.
 * - **Silent** — a real game moment with no sound today. The interesting
 *   column: authoring here adds a cue the game has never had.
 * - **Mine** — the author's own saved recipes.
 *
 * `builtin: true` means `GENERATORS` has an entry, so "copy to edit" can seed
 * an approximation. `wired: true` means something calls `playAt`/`playGlobal`
 * with this id today. A `wired: false, builtin: false` row is a moment that
 * needs both a recipe and a one-line call site — the recipe is data and lands
 * without a deploy; the call site is code and does not.
 *
 * Keeping this a plain list, checked against `GENERATORS` by a test rather
 * than derived from it, is what lets it describe sounds that do not exist yet.
 */

/**
 * @typedef {object} SoundEvent
 * @property {string} id the key `playAt`/`playGlobal` is called with
 * @property {string} label human name, shown in the dashboard
 * @property {'combat'|'economy'|'ui'|'structure'|'match'|'vehicle'} category
 * @property {boolean} builtin a `GENERATORS` entry exists
 * @property {boolean} wired something plays it today
 * @property {string} [note] why it is silent, where that is not obvious
 */

/** @type {SoundEvent[]} */
export const SOUND_EVENTS = [
  // --- combat -------------------------------------------------------------
  { id: 'weaponFire', label: 'Weapon fire', category: 'combat', builtin: true, wired: true },
  { id: 'explosionGround', label: 'Ground impact', category: 'combat', builtin: true, wired: true },
  { id: 'explosionHull', label: 'Hull impact', category: 'combat', builtin: true, wired: true },
  { id: 'destroyed', label: 'Destroyed', category: 'combat', builtin: true, wired: true },
  {
    id: 'baseUnderAttack', label: 'Base under attack', category: 'combat', builtin: false, wired: false,
    note: 'No warning cue exists — a base can be dismantled off-screen in silence.',
  },

  // --- economy ------------------------------------------------------------
  { id: 'coinPickup', label: 'Bounty collected', category: 'economy', builtin: true, wired: true },
  { id: 'coinSpawn', label: 'Bounty dropped', category: 'economy', builtin: true, wired: true },
  {
    id: 'harvestScoop', label: 'Harvester scoops', category: 'economy', builtin: true, wired: false,
    note: 'Generator written, never called — harvesting is silent.',
  },
  {
    id: 'harvestDeliver', label: 'Harvester unloads', category: 'economy', builtin: true, wired: false,
    note: 'Generator written, never called — harvesting is silent.',
  },

  // --- ui -----------------------------------------------------------------
  { id: 'uiConfirm', label: 'Order confirmed', category: 'ui', builtin: true, wired: true },
  { id: 'uiCancel', label: 'Order cancelled', category: 'ui', builtin: true, wired: true },
  { id: 'uiRefused', label: 'Order refused', category: 'ui', builtin: true, wired: true },
  {
    id: 'notification', label: 'Notification', category: 'ui', builtin: true, wired: false,
    note: 'Generator written, never called.',
  },
  {
    id: 'unitSelect', label: 'Unit selected', category: 'ui', builtin: false, wired: false,
    note: 'Selection is silent; every RTS this game takes after acknowledges it.',
  },
  {
    id: 'moveOrder', label: 'Move ordered', category: 'ui', builtin: false, wired: false,
    note: 'A move order currently shares the generic confirm cue.',
  },

  // --- structures ---------------------------------------------------------
  { id: 'structureComplete', label: 'Structure complete', category: 'structure', builtin: true, wired: true },
  {
    id: 'repairTick', label: 'Repairing', category: 'structure', builtin: false, wired: false,
    note: 'The repair bay works in silence.',
  },
  {
    id: 'deploy', label: 'Deploy / undeploy', category: 'structure', builtin: false, wired: false,
  },

  // --- radio ---------------------------------------------------------------
  // The three artifacts the team radio plays around each spoken line. They are
  // listed here, rather than living privately inside radio.js, so they are
  // editable in the Sound Creator like any other cue — which matters more than
  // usual here: the voice itself cannot be processed at all (the Web Speech
  // API exposes no audio node), so these three ARE the radio's sound.
  { id: 'radioOpen', label: 'Radio squelch (open)', category: 'ui', builtin: true, wired: true },
  { id: 'radioStatic', label: 'Radio static bed', category: 'ui', builtin: true, wired: true },
  { id: 'radioClose', label: 'Radio squelch (close)', category: 'ui', builtin: true, wired: true },

  // --- match --------------------------------------------------------------
  { id: 'matchStart', label: 'Match start', category: 'match', builtin: true, wired: true },
  { id: 'victory', label: 'Victory', category: 'match', builtin: true, wired: true },
  { id: 'defeat', label: 'Defeat', category: 'match', builtin: true, wired: true },
];

export const SOUND_CATEGORIES = ['combat', 'economy', 'ui', 'structure', 'match', 'vehicle'];

export const soundEventFor = (id) => SOUND_EVENTS.find((e) => e.id === id) ?? null;

/** Events with a generator behind them — the ones "copy to edit" can seed. */
export const builtinEvents = () => SOUND_EVENTS.filter((e) => e.builtin);

/**
 * Events with no sound in the game today, whether or not a generator exists.
 *
 * A generator with no call site is silent in exactly the way a missing
 * generator is: the player hears nothing. Grouping them together is the point
 * — the dashboard should show what the game is missing, not what the code
 * happens to contain.
 */
export const silentEvents = () => SOUND_EVENTS.filter((e) => !e.wired);
