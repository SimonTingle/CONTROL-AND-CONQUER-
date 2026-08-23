/**
 * Weapons: who can see whom, who is shooting whom, and what that costs them.
 *
 * Resolution is **hitscan** — a shot that clears line of sight lands the same
 * tick it is fired. At a 60-90 unit engagement range a real projectile would
 * be in flight about a fifth of a second, which is not long enough to dodge
 * and not long enough to read, but is long enough to need a per-frame
 * projectile-versus-everything loop and to make "who killed what" ambiguous
 * when a shooter dies mid-flight. The travelling tracer is therefore purely
 * cosmetic: it is drawn after the damage it represents has already been
 * applied, and nothing reads it back.
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

export class CombatController {
  /**
   * @param {object} opts
   * @param {object} opts.vehicles VehicleController
   * @param {object} opts.structures StructureController
   * @param {object} opts.heightmap for line-of-sight against terrain
   * @param {object} opts.entities destroy pipeline — a kill is queued, never
   *   spliced here, so it lands at the tick's single flush point like every
   *   other death
   * @param {object} opts.game for teamOf/teams
   * @param {(from, to, teamId) => void} [opts.onShot] cosmetic hook; the shot
   *   has already been resolved by the time this is called
   */
  constructor({ vehicles, structures, heightmap, entities, game, onShot = null }) {
    this.vehicles = vehicles;
    this.structures = structures;
    this.heightmap = heightmap;
    this.entities = entities;
    this.game = game;
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
    // individually harder-hitting.
    inst._fireCooldown = inst.def.turret.fireInterval / this.game.teamOf(inst).fireRateMultiplier;

    // Tell the victim it is under fire, and from where. Read by harvesterAI's
    // FLEEING state; anything that ignores these fields simply stands its
    // ground, which is the right default for something armed.
    target.threatUntil = simClock.time + THREAT_MEMORY;
    target.threatFrom = { x: inst.group.position.x, z: inst.group.position.z };

    const killed = target.takeDamage(inst.def.turret.damage);
    if (killed) {
      // Credited to the shooter for its Active-card "units destroyed" stat.
      // Counted at the kill site (not the destroy pipeline) precisely because
      // only here is the responsible vehicle known.
      inst.kills = (inst.kills ?? 0) + 1;
      // Team-level tallies for the Statistics screen, kept here for the same
      // reason the line above is: this is where the responsible shooter is
      // known. They are not derivable later — once this shooter itself dies,
      // vehicles.remove() splices it out and its `kills` goes with it, so a
      // total assembled by walking live instances would quietly under-count
      // every match. Only ever "is this run better than the best so far",
      // which is answerable now without any destroy-time bookkeeping.
      const shooterTeam = this.game.teamOf(inst);
      if (shooterTeam) {
        const stats = shooterTeam.stats;
        stats.killsByDefId[inst.def.id] = (stats.killsByDefId[inst.def.id] ?? 0) + 1;
        if (inst.kills > (stats.topKillsVehicle?.kills ?? 0)) {
          stats.topKillsVehicle = { defId: inst.def.id, kills: inst.kills };
        }
      }
      // Queued, not removed: the destroy pipeline's single flush point is what
      // guarantees nothing is spliced out of an array another system is still
      // walking this tick.
      this.entities.queueDestroy(target);
      inst.combatTarget = null;
    }

    this.onShot?.(
      inst.group.position,
      targetPoint(target),
      inst.teamId,
      inst.def.turret.muzzleHeight ?? DEFAULT_TARGET_HEIGHT,
      targetHeight(target),
      inst.def.turret
    );
  }
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
