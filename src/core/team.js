/**
 * A side in a match: one economy, one fog mask, one set of owned entities.
 *
 * Entities carry a numeric `teamId`, never a `Team` reference. Two reasons:
 * a reference makes the object graph cyclic, which the save/load work will
 * have to serialise; and an integer is a sound key for grouping maps, where
 * an object would quietly keep a destroyed team alive.
 *
 * Sandbox play is a one-team match, so nothing has to special-case "no teams"
 * — there is always exactly one team the player owns.
 */

/** The human is always team 0, so `teamId` sorts with the player first. */
export const PLAYER_TEAM_ID = 0;

const AI_NAMES = ['Crimson', 'Amber', 'Violet', 'Jade'];
// Deliberately far from the UI accent (a teal, --accent) so an owner tint can
// never be mistaken for a selection highlight.
const AI_COLORS = [0xd6455a, 0xd98c2b, 0x9457c9, 0x3fa66b];
const PLAYER_COLOR = 0x4fd1c5;

/**
 * Fire-rate upgrade, bought at an Armed Factory — team-scoped rather than
 * per-building or per-vehicle, because the scout isn't produced by any
 * structure and still has to benefit. `combatController` divides a shooter's
 * `fireInterval` by its team's current multiplier; every combat vehicle gets
 * faster automatically, present and future, with no per-vehicle wiring.
 */
export const WEAPON_TIERS = [
  { cost: 800, fireRateMultiplier: 1.25 },
  { cost: 1600, fireRateMultiplier: 1.55 },
  { cost: 2800, fireRateMultiplier: 1.9 },
];

export class Team {
  /**
   * @param {number} id
   * @param {object} opts
   * @param {string} opts.name
   * @param {number} opts.color
   * @param {boolean} opts.isHuman
   * @param {object} [opts.fog] per-team FogMask; assigned by the caller that
   *   owns the shared fog terrain.
   */
  constructor(id, { name, color, isHuman, fog = null }) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.isHuman = isHuman;
    this.fog = fog;

    // Set by match setup once this team's base is placed. A stable respawn
    // anchor that survives the base station itself dying.
    this.homePoint = null;

    this.credits = 0;
    // Latched, the same way the vehicle unlock is: relocating spends nothing,
    // so without a latch a team that crossed the threshold could spend back
    // under it and lose an option it had already earned.
    this.reachedRelocateThreshold = false;
    // Set when this team's base station is destroyed. A defeated team keeps
    // its wreckage in the world; it just stops being driven or counted.
    this.defeated = false;

    // Index into WEAPON_TIERS — see there for why this lives on the team
    // rather than a structure or a vehicle instance.
    this.weaponTier = 0;

    // Match record, for the end-of-match summary. `creditsEarned` is lifetime
    // income rather than the live balance — spending is what a team is *for*,
    // so a balance of zero says nothing about how well its economy ran.
    this.stats = {
      creditsEarned: 0,
      unitsBuilt: 0,
      unitsLost: 0,
      structuresBuilt: 0,
      structuresLost: 0,
    };
  }

  earn(n) {
    this.credits += n;
    this.stats.creditsEarned += n;
    if (this.credits >= 50000) this.reachedRelocateThreshold = true;
    return this.credits;
  }

  /** @returns {boolean} false when short, so the caller can explain why. */
  spend(n) {
    if (this.credits < n) return false;
    this.credits -= n;
    return true;
  }

  /** How much faster this team's combat vehicles fire than the catalog base rate. */
  get fireRateMultiplier() {
    return WEAPON_TIERS[this.weaponTier - 1]?.fireRateMultiplier ?? 1;
  }
}

/**
 * Build the team list for a match. Team 0 is always the human; the rest are AI.
 *
 * @param {number} aiCount 0 for sandbox, 1-4 for a Multiplayer AI match
 */
export function createTeams(aiCount = 0) {
  const teams = [
    new Team(PLAYER_TEAM_ID, { name: 'You', color: PLAYER_COLOR, isHuman: true }),
  ];
  for (let i = 0; i < aiCount; i++) {
    teams.push(
      new Team(i + 1, {
        name: AI_NAMES[i % AI_NAMES.length],
        color: AI_COLORS[i % AI_COLORS.length],
        isHuman: false,
      })
    );
  }
  return teams;
}
