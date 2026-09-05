/**
 * What the game teaches a new player, and when.
 *
 * Data, not code, for the same reason `audio/chatter.js`'s CHATTER_LINES is
 * data: adding a hint later should be one entry here, not a change to the
 * engine that shows them.
 *
 * ## Every hint answers a question the player is already asking
 *
 * A hint that fires before its subject exists is noise — nobody needs to hear
 * about refineries while they are still working out how to steer. So each
 * entry's `when` is a *readiness* test against live match state, not a
 * timeline: the economy hint waits for a deployed base, the production hint
 * waits for credits to actually be accumulating. The player is told the next
 * thing at the moment it becomes the next thing.
 *
 * ## `retiredWhen` is what stops this being a tutorial
 *
 * If the player works something out before the hint gets its turn, the hint
 * drops itself, unfired and unrepeated. Competence is the real dismissal; the
 * OK button is only for the cases where we got in first. This is the single
 * most important field in the file — without it, a player who already knows
 * the game gets lectured about things they did two minutes ago, which is
 * precisely the failure that makes people switch tutorials off.
 *
 * ## Wording
 *
 * One sentence. `textTouch` overrides `text` on a coarse pointer, because the
 * gestures genuinely differ (press-and-hold vs double-click) and a hint that
 * names the wrong input is worse than no hint. Priority breaks ties when two
 * hints come due together; it is absolute, not recency-based, following the
 * same reasoning as chatter's.
 */

/**
 * @typedef {object} HintDef
 * @property {string} id stable, and persisted — never renamed once shipped.
 * @property {string[]} modes game modes this applies to.
 * @property {number} priority higher wins when several are eligible at once.
 * @property {string} title
 * @property {string} text
 * @property {string} [textTouch] replaces `text` on touch devices.
 * @property {(ctx: object) => boolean} when fire once this is true.
 * @property {(ctx: object) => boolean} [retiredWhen] drop unfired once true.
 */

const ALL_MODES = ['sandbox', 'multiplayer-ai', 'multiplayer-online'];

/** @type {HintDef[]} */
export const HINT_DEFS = [
  // ---- General: controls and the interface ----
  {
    id: 'move',
    modes: ALL_MODES,
    priority: 10,
    title: 'Getting around',
    text: 'Drag to look around, and drive your selected vehicle with W, A, S and D.',
    textTouch: 'Drag to look around, and tap the ground to send your selected vehicle there.',
    // The opening quiet period in hintSystem already holds this back; there is
    // no further readiness test to make, because moving is available from the
    // first frame and is the one thing every player needs immediately.
    when: () => true,
  },
  {
    id: 'command-ring',
    modes: ALL_MODES,
    priority: 9,
    title: 'Giving orders',
    text: 'Double-click a unit or building to open its command ring.',
    textTouch: 'Press and hold a unit or building to open its command ring.',
    when: () => true,
    // Opening the ring even once teaches this better than the card does.
    retiredWhen: (ctx) => ctx.hasOpenedRadial,
  },
  {
    id: 'drawers',
    modes: ALL_MODES,
    priority: 2,
    title: 'Menus',
    text: 'The left menu holds statistics and settings; the right one lists vehicles you can build.',
    when: (ctx) => ctx.elapsedSeconds > 90,
    retiredWhen: (ctx) => ctx.hasOpenedDrawer,
  },

  // ---- General: the economy, in the order it unlocks ----
  {
    id: 'deploy-base',
    modes: ALL_MODES,
    priority: 8,
    title: 'Set up a base',
    text: 'Your base station can Deploy from its command ring — that flattens a pad to build on.',
    when: (ctx) => !ctx.baseDeployed,
    retiredWhen: (ctx) => ctx.baseDeployed,
  },
  {
    id: 'harvester-facility',
    modes: ALL_MODES,
    priority: 7,
    title: 'Start earning',
    text: 'Build a Harvester Facility from the base command ring — nothing earns credits until one exists.',
    when: (ctx) => ctx.baseDeployed && !ctx.hasHarvesterFacility,
    retiredWhen: (ctx) => ctx.hasHarvesterFacility,
  },
  {
    id: 'harvesting',
    modes: ALL_MODES,
    priority: 6,
    title: 'Crystals pay',
    text: 'Harvesters drive to crystal fields and bring the load home; each round trip pays out on arrival.',
    when: (ctx) => ctx.hasHarvesterFacility && ctx.harvesterEarnings <= 0,
    retiredWhen: (ctx) => ctx.harvesterEarnings > 0,
  },
  {
    id: 'armed-factory',
    modes: ALL_MODES,
    priority: 5,
    title: 'Build an army',
    text: 'An Armed Factory turns credits into combat units. Queue them from its command ring.',
    when: (ctx) => ctx.harvesterEarnings > 0 && !ctx.hasArmedFactory,
    retiredWhen: (ctx) => ctx.hasArmedFactory,
  },

  // ---- General: reacting to trouble ----
  {
    id: 'first-loss',
    modes: ALL_MODES,
    priority: 4,
    title: 'You lost a unit',
    text: 'Damaged units do not heal on their own — a Repair Bay is what brings them back.',
    when: (ctx) => ctx.unitsLost > 0,
    retiredWhen: (ctx) => ctx.hasRepairBay,
  },

  // ---- Mode-specific ----
  {
    id: 'mode-sandbox',
    modes: ['sandbox'],
    priority: 3,
    title: 'Sandbox',
    text: 'Nobody is attacking you here. Build whatever you like and learn the economy at your own pace.',
    when: (ctx) => ctx.elapsedSeconds > 45,
  },
  {
    id: 'mode-ai',
    modes: ['multiplayer-ai'],
    priority: 3,
    title: 'You are not alone',
    text: 'The AI commanders are building at the same time. Scout early, and keep something at home.',
    when: (ctx) => ctx.elapsedSeconds > 45,
  },
  {
    id: 'mode-online',
    modes: ['multiplayer-online'],
    priority: 3,
    title: 'Live match',
    text: 'Every player simulates this match in step, so there is no pausing — leaving means leaving.',
    when: (ctx) => ctx.elapsedSeconds > 45,
  },
];
