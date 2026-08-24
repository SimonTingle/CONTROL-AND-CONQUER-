/**
 * A digest of everything the simulation is allowed to disagree about.
 *
 * Lockstep's whole premise is that identical inputs produce identical state on
 * every machine. That premise cannot be fully guaranteed here: the sim leans on
 * `Math.sin/cos/atan2` in dozens of places, and IEEE-754 pins the last bit only
 * for `+ - * /` and `sqrt` — transcendentals may differ between JS engines and
 * CPUs. So rather than assume convergence, we measure it: clients exchange this
 * hash periodically and resync from the host when it disagrees.
 *
 * Two design points matter for correctness:
 *
 *  - **Iteration is by id, never array order.** `vehicles.instances` is a plain
 *    array whose order depends on spawn/removal history, which is *not* part of
 *    the game state two clients need to agree on. Hashing it directly would
 *    report a desync where none exists.
 *
 *  - **Floats are quantised before hashing.** Raw bits would flag a 1e-16 trig
 *    difference as a full desync and trigger a pointless resync every few
 *    seconds. Quantising to QUANTUM means the hash only moves when something has
 *    drifted enough to matter. The tradeoff is real and worth stating: a value
 *    sitting exactly on a rounding boundary can still hash differently from a
 *    negligible difference. That is tolerable precisely because a hash mismatch
 *    triggers a snapshot resync rather than an error — a false positive costs
 *    one redundant state transfer, not a broken match.
 */

import { fnv1a } from './fnv1a.js';

/** World units (and hitpoints) per hash step. See the note on quantisation above. */
const QUANTUM = 100; // i.e. 0.01 resolution

/** Quantise a float to an integer, with NaN/undefined collapsing to a constant. */
function q(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'x';
  return Math.round(v * QUANTUM);
}

function byId(a, b) {
  return a.id - b.id;
}

/**
 * Hash the simulation state of a running match.
 *
 * @param {object} ctx `{ vehicles, structures, game }` — the same shape the
 *   command context and snapshot serializer already take.
 * @param {number} tick the sim tick this hash describes; included so a hash can
 *   never be compared against one from a different point in time.
 * @returns {string} `"<tick>:<hex>"`
 */
export function hashState({ vehicles, structures, game, projectiles, bounties }, tick) {
  const parts = [`t${tick}`];

  const vs = vehicles.instances.filter((v) => !v.dead).sort(byId);
  for (const v of vs) {
    const p = v.group.position;
    // `kills` joins the hash now that it decides something: veterancy scales
    // accuracy and damage (vehicles/veterancy.js), and the bounty a wreck
    // drops. Before that it was a display stat, and a client whose tally had
    // drifted still simulated identically; now a one-kill disagreement means
    // two clients rolling different hit chances from the same shot.
    parts.push(
      `v${v.id},${v.teamId},${q(p.x)},${q(p.z)},${q(v.heading)},${q(v.health)},${v.mode},${v.kills ?? 0}`
    );
  }

  const ss = structures.instances.filter((s) => !s.dead).sort(byId);
  for (const s of ss) {
    parts.push(`s${s.id},${s.teamId},${q(s.health)},${q(s.progress)},${s.mode}`);
  }

  // Shells in flight. Their `willHit` is the accuracy roll's verdict, decided
  // at launch, so two clients that rolled differently disagree here a whole
  // flight-time *before* the damage lands — which is the earliest a resync can
  // possibly catch it. Positions are quantised like everything else; the
  // integration is plain multiply-add, so they should agree exactly.
  if (projectiles) {
    const ps = projectiles.instances.slice().sort(byId);
    for (const pr of ps) {
      parts.push(`p${pr.id},${pr.teamId},${q(pr.x)},${q(pr.z)},${q(pr.y)},${pr.willHit ? 1 : 0}`);
    }
  }

  // Uncollected bounty coins. A coin is credits waiting to happen, so a client
  // that has one the others don't is already economically divergent.
  if (bounties) {
    const cs = bounties.instances.slice().sort(byId);
    for (const c of cs) {
      parts.push(`b${c.id},${q(c.x)},${q(c.z)},${c.value},${c.expiresAtTick}`);
    }
  }

  // Credits and elimination are the two team-level facts a divergence shows up
  // in fastest — an economy that drifts by one harvest load is already broken.
  for (const t of game.teams) {
    parts.push(`c${t.id},${q(t.credits)},${t.defeated ? 1 : 0},${t.weaponTier}`);
  }

  return `${tick}:${fnv1a(parts.join('|')).toString(16).padStart(8, '0')}`;
}
