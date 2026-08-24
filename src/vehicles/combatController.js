/**
 * Weapons: who can see whom, who is shooting whom, and what that costs them.
 *
 * Resolution is **ballistic**. Pulling the trigger launches a shell into
 * `projectiles.js`, which carries it to its impact point over several ticks
 * and applies the damage there. This file therefore decides three things and
 * then lets go: whether a shot is taken at all, whether it will hit, and where
 * it is aimed.
 *
 * It used to be hitscan, and the header here used to argue for that on the
 * grounds that a travelling shell needs a per-tick loop and makes kill credit
 * ambiguous when a shooter dies mid-flight. `projectiles.js`'s own header
 * answers both in detail; the short version is that a shell decided at launch
 * needs no per-tick collision search, and copies its shooter's identity out at
 * launch so it never has to dereference an instance that may since have died.
 *
 * **Hit and miss are decided here, at launch.** `hitChance` scores the shot
 * from the shooter's rank, its team's weapon tier and the range, and
 * `shotRoll` turns that into a yes or no. A miss is not a shot that misses by
 * accident — it is aimed at a point on the ground beside the target, so the
 * shell visibly falls wide and craters where it lands. That is the whole
 * reason the decision happens at launch rather than at arrival.
 *
 * The same targeting discipline as everything else autonomous in this
 * codebase (see harvesterAI's header): a target is a *reference that can die*,
 * so it is revalidated from scratch every tick rather than trusted between
 * them. `_validTarget` is the single gate, and every path — reacquire, hold,
 * fire — goes through it.
 */

// Simulated time, never wall clock — threat memory is simulation state that
// must advance with the sim and match across clients. See core/simClock.js.
import { simClock } from '../core/simClock.js';
import { shotRoll, shotDamage } from './projectiles.js';
import { rankOfInstance, ACCURACY_PER_RANK } from './veterancy.js';

// Reacquisition is the expensive part (an O(targets) scan plus a line-of-sight
// march each), so it runs on a cadence rather than per frame, staggered across
// instances so they never all pay it on the same tick. Holding an existing
// target is cheap and happens every tick regardless.
const REACQUIRE_INTERVAL = 0.25;
// A target already acquired is kept until it is *clearly* out of reach, not
// the instant it crosses the range line — otherwise a target sitting exactly
// at the limit is acquired and dropped on alternating ticks and the turret
// visibly jitters between it and the idle scan.
const RANGE_HYSTERESIS = 1.15;
// How closely the barrel has to be on target before the shot counts. Wide
// enough that a slow turret still gets to fire while tracking a crossing
// target, tight enough that it never fires visibly sideways.
const AIM_TOLERANCE = 0.12; // radians
// Line-of-sight sampling. The heightfield is 513 samples across 1024 units,
// so ~2 units is exactly its own fidelity: sampling finer cannot reveal a
// ridge the terrain does not actually represent, and sampling coarser could
// shoot through one that it does.
const LOS_STEP = 2;
// Shots start and land at roughly turret height, not at the ground: a hull
// sitting in a shallow dip is still shootable, and a shot does not clip the
// lip of its own firing position.
const DEFAULT_TARGET_HEIGHT = 1.5;
// How long "I am under fire" lasts after the last hit. Long enough that a
// harvester commits to running rather than twitching in and out of flight
// between shots; short enough that it goes back to work once genuinely clear.
const THREAT_MEMORY = 6;

// --- accuracy ---------------------------------------------------------------
// A shot's chance to connect. Deliberately well below certainty at the base:
// the whole point of a travelling shell is that some of them land in the dirt,
// and a 95% base rate would make craters a curiosity rather than a feature.
const BASE_ACCURACY = 0.6;
// Per team weapon tier (core/team.js's WEAPON_TIERS). The tier already divides
// the fire interval; this makes it buy precision as well as rate, so upgrading
// reads as "my guns got better" rather than only "my guns got faster".
const ACCURACY_PER_WEAPON_TIER = 0.1;
// How much of the base accuracy is lost at maximum range. Applied as a scale
// rather than a subtraction so rank and tier bonuses degrade with distance too
// — an elite crew is still better at long range, just not immune to it.
const RANGE_ACCURACY_FALLOFF = 0.45;
// Floor and ceiling. The ceiling exists so no amount of stacking makes a unit
// unmissable; the floor so a maximum-range shot from a green crew is still
// worth taking.
const MIN_ACCURACY = 0.15;
const MAX_ACCURACY = 0.95;
// How far wide a miss lands, as a fraction of the distance to the target. Big
// enough that the shell visibly goes somewhere else, small enough that it
// still reads as a shot at *that* target rather than at nothing.
const MISS_SPREAD = 0.12;
// A miss never lands closer to the target than this, in world units — without
// it a close-range miss would land inside the target's own footprint and read
// as a hit that did no damage.
const MIN_MISS_OFFSET = 2.5;

export class CombatController {
  /**
   * @param {object} opts
   * @param {object} opts.vehicles VehicleController
   * @param {object} opts.structures StructureController
   * @param {object} opts.heightmap for line-of-sight against terrain
   * @param {object} opts.game for teamOf/teams
   * @param {object} opts.projectiles the Projectiles controller a fired shell
   *   is handed to. Damage is applied there, on arrival, not here.
   * @param {(from, to, teamId) => void} [opts.onShot] muzzle-flash hook, fired
   *   at launch. The shell's own travel and impact visuals come from the
   *   projectile array, not from this.
   */
  constructor({ vehicles, structures, heightmap, game, projectiles, onShot = null }) {
    this.vehicles = vehicles;
    this.structures = structures;
    this.heightmap = heightmap;
    this.game = game;
    this.projectiles = projectiles;
    this.onShot = onShot;
    this._tick = 0;
  }

  update(dt) {
    this._tick++;
    // Structures were always valid *targets* (see _candidates) but never
    // shooters — the loop below read only vehicles, so a defensive emplacement
    // would have sat there aiming at nothing. Concatenated rather than given
    // its own loop: every check in here is about `def.turret`, `heading`,
    // `mode` and `group.position`, all of which a turret structure carries
    // under the same names, so a second copy of this loop would be the same
    // code with a different array in front of it.
    const shooters = this._shooters();

    for (let i = 0; i < shooters.length; i++) {
      const inst = shooters[i];
      if (inst.dead || !inst.def.turret?.damage) continue;

      // Arming stays a deliberate act, exactly as it was before weapons
      // existed: `mode === 'armed'` is the capability gate and nothing here
      // sets it. Coupling it to target presence instead would make the
      // vehicle's own handling (armedSpeedFactor/armedSteerFactor) lurch every
      // time an enemy wandered in or out of range.
      if (inst.mode !== 'armed') {
        inst.turretAim = null;
        continue;
      }

      inst._fireCooldown = Math.max(0, (inst._fireCooldown ?? 0) - dt);

      // Held targets are revalidated every tick; only the *search* for a new
      // one is throttled. A dead or fled target must never survive even one
      // frame, and it costs nothing to check the one we already have.
      if (!this._validTarget(inst, inst.combatTarget, RANGE_HYSTERESIS)) {
        inst.combatTarget = null;
      }
      if (!inst.combatTarget && (this._tick + i) % Math.max(1, Math.round(REACQUIRE_INTERVAL * 60)) === 0) {
        inst.combatTarget = this._acquire(inst);
      }

      const target = inst.combatTarget;
      if (!target) {
        inst.turretAim = null;
        continue;
      }

      const from = inst.group.position;
      const to = targetPoint(target);
      inst.turretAim = Math.atan2(to.z - from.z, to.x - from.x);

      // Fire only once the barrel has actually caught up. updateTurret runs
      // later in the same tick, so this is deliberately checking where the
      // barrel is *now* — a shot is never credited to a turret that has not
      // yet physically come to bear.
      const aimError = Math.abs(wrapAngle(inst.turretAim - inst.turretBearing));
      if (aimError > AIM_TOLERANCE || inst._fireCooldown > 0) continue;

      this._fire(inst, target);
    }
  }

  /**
   * Everything that can shoot: every vehicle, plus any structure mounting a
   * turret. Rebuilt per tick rather than cached — both arrays change as things
   * are built and destroyed, and a stale shooter list would keep firing a gun
   * that no longer exists.
   */
  _shooters() {
    const armed = this.structures.instances.filter((s) => s.def.turret);
    return armed.length ? [...this.vehicles.instances, ...armed] : this.vehicles.instances;
  }

  /** Everything that could be shot at, on any team but this one. */
  *_candidates(inst) {
    for (const v of this.vehicles.instances) {
      if (v !== inst && !v.dead && v.teamId !== inst.teamId) yield v;
    }
    for (const s of this.structures.instances) {
      // Decorations are scenery, not targets — shooting a power spire is
      // noise, and it would pull fire off the things that decide a match.
      if (s !== inst && !s.dead && s.teamId !== inst.teamId && !s.def.tags?.includes('decoration')) yield s;
    }
  }

  _acquire(inst) {
    let best = null;
    let bestScore = Infinity;
    for (const cand of this._candidates(inst)) {
      if (!this._validTarget(inst, cand, 1)) continue;
      // Nearest wins. Deliberately not "weakest" or "most valuable": a unit
      // shooting past the thing directly in front of it to plink at something
      // it has decided matters more reads as broken, whatever the spreadsheet
      // says.
      const d = flatDistance(inst.group.position, targetPoint(cand));
      if (d < bestScore) {
        bestScore = d;
        best = cand;
      }
    }
    return best;
  }

  /**
   * The single validity gate. Everything a target must satisfy to be worth
   * aiming at, in ascending order of cost — the line-of-sight march is last
   * because it is by far the most expensive check here.
   */
  _validTarget(inst, target, rangeScale) {
    if (!target || target.dead) return false;
    if (target.teamId === inst.teamId) return false;

    const from = inst.group.position;
    const to = targetPoint(target);
    const dist = flatDistance(from, to);
    if (dist > inst.def.turret.range * rangeScale) return false;

    // Inside the arc the turret can physically reach, measured from the hull's
    // heading — the same clamp updateTurret applies, so this never promises a
    // bearing the turret will then refuse to adopt.
    const bearing = Math.atan2(to.z - from.z, to.x - from.x);
    if (Math.abs(wrapAngle(bearing - inst.heading)) > inst.def.turret.fireArc / 2) return false;

    return this.hasLineOfSight(from, to, inst.def.turret.muzzleHeight ?? DEFAULT_TARGET_HEIGHT, targetHeight(target));
  }

  /**
   * Does the terrain block the straight line between two points?
   *
   * A dedicated segment walk rather than pick.js's `raymarchTerrain`: that one
   * answers "where does this infinite ray first meet the ground" for a camera
   * pick, with early-outs tuned for a ray leaving the world. What is needed
   * here is the narrower question "does anything rise above this *finite*
   * segment", which is both cheaper and less prone to false negatives at the
   * far end.
   */
  hasLineOfSight(from, to, fromHeight, toHeight) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) return true;

    const y0 = this.heightmap.heightAt(from.x, from.z) + fromHeight;
    const y1 = this.heightmap.heightAt(to.x, to.z) + toHeight;
    const steps = Math.max(2, Math.ceil(dist / LOS_STEP));

    // Endpoints excluded on purpose: the ground directly under the shooter and
    // under the target is always "in the way" of a line drawn between points
    // that sit above it, and testing them would block every shot ever fired.
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = from.x + dx * t;
      const z = from.z + dz * t;
      const lineY = y0 + (y1 - y0) * t;
      if (this.heightmap.heightAt(x, z) > lineY) return false;
    }
    return true;
  }

  _fire(inst, target) {
    // Team-wide Weapon Tier upgrade (see core/team.js) — divides the interval,
    // not the damage, so a fully upgraded team's guns are simply faster, not
    // individually harder-hitting. It does buy accuracy, in `hitChance`.
    const team = this.game.teamOf(inst);
    inst._fireCooldown = inst.def.turret.fireInterval / team.fireRateMultiplier;

    // Tell the victim it is under fire, and from where — at *launch*, not at
    // impact. Read by harvesterAI's FLEEING state, and a harvester should
    // start running when it is shot at, not a third of a second later when the
    // shell happens to land. Anything that ignores these fields simply stands
    // its ground, which is the right default for something armed.
    target.threatUntil = simClock.time + THREAT_MEMORY;
    target.threatFrom = { x: inst.group.position.x, z: inst.group.position.z };

    const from = inst.group.position;
    const to = targetPoint(target);
    const dist = flatDistance(from, to);
    const tHeight = targetHeight(target);

    // One roll, one shot. `simClock.tick` is in the key so a turret firing at
    // the same target every second doesn't get the same answer every time;
    // shooter and target ids are in it so two units firing on the same tick
    // don't share a fate.
    const chance = hitChance(inst, team, dist);
    const willHit = shotRoll(inst.id, target.id, simClock.tick, 'hit') < chance;

    let aimX = to.x;
    let aimZ = to.z;
    let aimY = this.heightmap.heightAt(to.x, to.z) + tHeight;

    if (!willHit) {
      // Aim the miss. A second, differently-salted roll picks which way it
      // goes, so the direction is uncorrelated with the hit decision — reusing
      // the same number would make every miss from a given shooter fall on the
      // same side.
      const angle = shotRoll(inst.id, target.id, simClock.tick, 'dir') * Math.PI * 2;
      const spread = Math.max(MIN_MISS_OFFSET, dist * MISS_SPREAD);
      aimX = to.x + Math.cos(angle) * spread;
      aimZ = to.z + Math.sin(angle) * spread;
      // A miss lands on the ground, not at turret height — that is what makes
      // it crater.
      aimY = this.heightmap.heightAt(aimX, aimZ);
    }

    this.projectiles.spawn({
      shooter: inst,
      target,
      willHit,
      // Rank's damage bonus is baked in at launch alongside everything else the
      // shell carries, so a crew promoted mid-flight doesn't retroactively
      // strengthen a shell already in the air.
      damage: shotDamage(inst),
      turretDef: inst.def.turret,
      muzzleHeight: inst.def.turret.muzzleHeight ?? DEFAULT_TARGET_HEIGHT,
      targetHeight: tHeight,
      aimX,
      aimZ,
      aimY,
    });

    this.onShot?.(
      from,
      to,
      inst.teamId,
      inst.def.turret.muzzleHeight ?? DEFAULT_TARGET_HEIGHT,
      tHeight,
      inst.def.turret
    );
  }
}

/**
 * How likely this shot is to connect, in [MIN_ACCURACY, MAX_ACCURACY].
 *
 * Exported and pure — it takes the shooter, its team and a distance, and reads
 * nothing else — so the tests can assert the shape of the curve directly
 * rather than inferring it from observed hit rates.
 *
 * The three terms compose deliberately: rank and tier are *added* to the base,
 * then the whole thing is *scaled* by range. Adding the range term instead
 * would let a high enough rank cancel distance out entirely, which would make
 * an elite unit as accurate at the edge of its range as at point blank.
 *
 * @param {object} inst the shooter
 * @param {object} team the shooter's team, for `weaponTier`
 * @param {number} dist flat distance to the target, in world units
 */
export function hitChance(inst, team, dist) {
  const range = inst.def?.turret?.range ?? 1;
  const rank = rankOfInstance(inst);
  const tier = team?.weaponTier ?? 0;

  const skill = BASE_ACCURACY + rank * ACCURACY_PER_RANK + tier * ACCURACY_PER_WEAPON_TIER;
  // Clamped so a target held inside RANGE_HYSTERESIS — i.e. slightly beyond
  // nominal range — doesn't push the falloff past 1 and invert the curve.
  const reach = Math.min(1, Math.max(0, dist / range));
  const chance = skill * (1 - RANGE_ACCURACY_FALLOFF * reach);

  return Math.min(MAX_ACCURACY, Math.max(MIN_ACCURACY, chance));
}

/**
 * A structure's ground position is stored flat on the instance (`x`/`z`); a
 * vehicle's lives on its mesh group and moves every frame. Reading the
 * structure's own fields rather than its group also sidesteps the rise
 * animation, which drives `group.position.y` while a building is still
 * emerging.
 */
function targetPoint(target) {
  return target.x !== undefined ? target : target.group.position;
}

function targetHeight(target) {
  return target.aimHeight ?? DEFAULT_TARGET_HEIGHT;
}

function flatDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
