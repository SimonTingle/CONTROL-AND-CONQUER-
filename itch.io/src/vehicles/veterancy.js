/**
 * Per-vehicle rank, derived from kills rather than stored alongside them.
 *
 * There is deliberately no `rank` field on an instance. Every vehicle has
 * carried a `kills` counter since weapons existed (vehicleController.js sets
 * it, snapshot.js saves it, combatController increments it at the kill site),
 * so a second field would be a denormalised copy of something already there —
 * one more thing to serialize, hash, keep in step across a lockstep match, and
 * get wrong. `rankOf(kills)` is a pure function of a number that is already
 * simulation state, which makes rank free to compute anywhere and impossible
 * to desync independently of the kills it comes from.
 *
 * The thresholds are cumulative kills, not kills-since-promotion: a unit that
 * has destroyed ten things is elite whether it did so in one engagement or
 * across a whole match.
 *
 * No THREE import, no clock, no I/O — this file is pure arithmetic so the unit
 * tests can exercise it directly (see CLAUDE.md on keeping `npm test`
 * dependency-free).
 */

/**
 * Cumulative kills needed for each rank above rookie. Index 0 is the
 * threshold for rank 1, and so on — `rankOf` counts how many of these have
 * been passed, so adding a fourth tier here is the whole change.
 */
export const RANK_THRESHOLDS = [2, 5, 10];

/** Display names, indexed by rank. Used by the picker card. */
export const RANK_NAMES = ['Green', 'Regular', 'Veteran', 'Elite'];

/** The highest rank reachable, derived so it can never disagree with the table. */
export const MAX_RANK = RANK_THRESHOLDS.length;

/**
 * @param {number} kills cumulative kills; missing/NaN is treated as zero so a
 *   structure or a freshly-restored v1 save never throws here.
 * @returns {number} 0..MAX_RANK
 */
export function rankOf(kills) {
  const k = Number.isFinite(kills) ? kills : 0;
  let rank = 0;
  for (const threshold of RANK_THRESHOLDS) {
    if (k >= threshold) rank++;
    else break; // table is ascending, so the first miss ends it
  }
  return rank;
}

/** Convenience for the common `rankOf(inst.kills)` — instances, not numbers. */
export function rankOfInstance(inst) {
  return rankOf(inst?.kills ?? 0);
}

/**
 * Damage multiplier for a rank. Deliberately small: rank's headline effect is
 * accuracy (see combatController's `hitChance`), because a unit that *hits*
 * more often already deals more damage per second, and stacking a large damage
 * bonus on top of that compounds into an elite unit that no fresh unit can
 * trade with at all.
 */
export function rankDamageMultiplier(rank) {
  return 1 + 0.05 * rank;
}

/** Accuracy added per rank, as a fraction. Consumed by `hitChance`. */
export const ACCURACY_PER_RANK = 0.08;
