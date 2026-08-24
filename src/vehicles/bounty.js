/**
 * Bounty coins — the salvage a destroyed vehicle leaves behind.
 *
 * A kill used to be worth nothing directly. The only credits it ever produced
 * were indirect, through `vehicleSellRefund`'s per-kill bonus when you later
 * sold the unit that made it. This turns a kill into something that happens
 * *on the battlefield*: a coin drops at the wreck, and it belongs to whoever
 * drives over it first.
 *
 * **Either team can claim it.** That is the whole point. A coin nobody has to
 * contest is just a delayed credit transfer with extra steps; a coin sitting
 * between two firing lines is a decision. The killer has the head start, not
 * the entitlement.
 *
 * ## Simulation state, not an effect
 *
 * A coin is worth credits, and credits decide matches, so this is simulation
 * state in every sense that matters: it ticks in `simTick`, it is serialized,
 * it is in the lockstep state hash, and nothing about it reads a wall clock or
 * a random number. Only the coin's *mesh* — the bobbing, the spinning, the
 * glow — lives on the render side, along with the credit flourish that plays
 * when the local player collects one.
 *
 * Coins follow the crystal-field convention from `terrain/blooms.js`: a stable
 * integer id, referenced by id anywhere it has to cross a save boundary, never
 * by object identity.
 */

import { simClock, SIM_DT } from '../core/simClock.js';
import { rankOf } from './veterancy.js';

/**
 * Fraction of a vehicle's build cost that drops as salvage. Well under half:
 * a bounty should reward aggression, not make killing more profitable than
 * harvesting, which would turn the economy inside out.
 */
export const BOUNTY_COST_FRACTION = 0.25;

/** Extra fraction per rank the dead vehicle had earned. */
export const BOUNTY_PER_RANK = 0.1;

/** World units. Generous — chasing a coin should not be a parking exercise. */
export const PICKUP_RADIUS = 6;

/**
 * Sim seconds before an unclaimed coin disperses. Long enough to be worth
 * fighting over, short enough that a stalled match does not leave the map
 * littered with free money nobody is contesting.
 */
export const COIN_LIFETIME = 20;

/**
 * What a destroyed vehicle is worth to whoever collects it.
 *
 * Pure, exported, and taking an instance rather than a controller so the tests
 * can drive it with a plain object.
 */
export function bountyValue(inst) {
  const cost = inst?.def?.cost ?? 0;
  if (cost <= 0) return 0;
  const rank = rankOf(inst.kills ?? 0);
  return Math.round(cost * BOUNTY_COST_FRACTION * (1 + BOUNTY_PER_RANK * rank));
}

let nextCoinId = 1;

export function reserveCoinId(id) {
  if (id >= nextCoinId) nextCoinId = id + 1;
}

export function resetCoinIds() {
  nextCoinId = 1;
}

export class Bounties {
  /**
   * @param {object} opts
   * @param {object} opts.vehicles VehicleController — scanned for collectors
   * @param {object} opts.game for `teamOf` and the credit award
   * @param {(coin, team, collector) => void} [opts.onCollected] cosmetic hook
   */
  constructor({ vehicles, game, onCollected = null }) {
    this.vehicles = vehicles;
    this.game = game;
    this.onCollected = onCollected;
    /** Uncollected coins. */
    this.instances = [];
  }

  /**
   * Drop a coin for a destroyed vehicle. Called from the destroy pipeline
   * while the instance still knows where it was and what it had done — both
   * are gone once `vehicles.remove` runs.
   *
   * Structures drop nothing: a building is not salvage you drive over, and a
   * base station worth 25% of its cost would make razing a base pay better
   * than taking it.
   */
  drop(inst) {
    if (inst.kind !== 'vehicle') return null;
    const value = bountyValue(inst);
    if (value <= 0) return null;

    const pos = inst.group.position;
    const coin = {
      id: nextCoinId++,
      x: pos.x,
      z: pos.z,
      value,
      // What died, and whose it was. Neither decides anything — a coin is
      // claimable by anyone — but both are worth carrying for the wreck's
      // readout and for anyone debugging a save.
      defId: inst.def.id,
      teamId: inst.teamId,
      // An absolute tick rather than a countdown, so it survives a save
      // without needing the elapsed time reconstructed. `resetSimClock` on
      // load restores the clock this was written against.
      expiresAtTick: simClock.tick + Math.round(COIN_LIFETIME / SIM_DT),
    };
    this.instances.push(coin);
    return coin;
  }

  update() {
    if (this.instances.length === 0) return;
    const radiusSq = PICKUP_RADIUS * PICKUP_RADIUS;

    // Backwards: a collected or expired coin splices itself out.
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const coin = this.instances[i];

      if (simClock.tick >= coin.expiresAtTick) {
        this.instances.splice(i, 1);
        continue;
      }

      // Nearest eligible vehicle wins, not the first one found in array
      // order: `vehicles.instances` is ordered by spawn history, which is not
      // something two clients need to agree on, and letting it decide a coin
      // would make the award depend on it. Distance is a fact about the world
      // and every client computes the same one.
      let best = null;
      let bestSq = radiusSq;
      for (const v of this.vehicles.instances) {
        if (v.dead) continue;
        const dx = v.group.position.x - coin.x;
        const dz = v.group.position.z - coin.z;
        const dSq = dx * dx + dz * dz;
        // Strictly nearer, then lower id: two vehicles at exactly the same
        // distance is vanishingly unlikely but must still resolve the same way
        // everywhere, and id is the only tiebreak that is not array order.
        if (dSq < bestSq || (dSq === bestSq && best && v.id < best.id)) {
          bestSq = dSq;
          best = v;
        }
      }
      if (!best) continue;

      const team = this.game.teamOf(best);
      if (!team) continue;

      this.instances.splice(i, 1);
      // `earn` rather than a raw `credits +=`, so the coin lands in the
      // Statistics screen's earnings total like every other source of income.
      team.earn(coin.value);
      this.onCollected?.(coin, team, best);
    }
  }

  restore(saved) {
    reserveCoinId(saved.id);
    this.instances.push({ ...saved });
    return saved;
  }

  clear() {
    this.instances.length = 0;
  }
}
