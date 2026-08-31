/**
 * Shells in flight.
 *
 * This replaces hitscan resolution. combatController used to apply damage on
 * the same tick the trigger was pulled and hand main.js a cosmetic tracer to
 * draw afterwards; its header argued for that on two grounds, and both are
 * worth answering here rather than leaving the reasoning to a commit message.
 *
 *  - *"a per-tick projectile-versus-everything loop"*. There isn't one. A
 *    projectile does not test itself against every entity every tick. Its
 *    outcome is decided at launch (see `willHit` below) and it simply flies to
 *    a point; the only per-tick work is integrating a position and a single
 *    arrival comparison. The cost is O(shots in flight), not O(shots × world).
 *
 *  - *"who killed what is ambiguous when a shooter dies mid-flight"*. This is
 *    the real hazard, and the record below is shaped specifically to remove
 *    it. A projectile never holds a reference to its shooter — it copies the
 *    shooter's id, team, def id and damage at launch. A shell fired by a tank
 *    that is itself destroyed a tick later still lands, still deals its
 *    damage, and is still credited correctly, because everything it needs was
 *    copied out of an instance that was alive at the time. This is the same
 *    discipline harvesterAI's header sets out — never cache a reference to
 *    another entity across ticks — applied to the one system that previously
 *    sidestepped it by never spanning ticks at all.
 *
 * **Hit or miss is decided at launch, not at arrival.** Two reasons. It means
 * a miss can be *aimed* — the shell visibly flies wide or short and craters
 * the ground where it lands, instead of passing through the target and
 * vanishing. And it means the accuracy roll happens once, at a moment where
 * shooter, target and tick are all unambiguously known, rather than at an
 * arrival tick whose participants may have changed.
 *
 * **Determinism.** The roll is a hash, not a random number. See `shotRoll`.
 * Nothing in this file reads a clock, `Math.random`, or anything outside the
 * arguments it is given.
 */

import { fnv1a } from '../core/fnv1a.js';
import { rankOfInstance, rankDamageMultiplier } from './veterancy.js';

/** World units/second, for a turret that doesn't specify its own. */
export const DEFAULT_PROJECTILE_SPEED = 160;

/**
 * Downward acceleration on a shell, in world units/s². Not real gravity —
 * this is a legibility knob. At the speeds and ranges involved, true ballistic
 * drop would be invisible; this is tuned so a shell arcs just enough to read
 * as a thrown object against the terrain rather than a laser.
 */
const SHELL_GRAVITY = 26;

/**
 * A shell that somehow never arrives (an arrival test that never trips because
 * the target point sits inside terrain, say) must not accumulate forever.
 * Generous enough that no legitimate shot ever hits it.
 */
const MAX_FLIGHT_SECONDS = 12;

/** Height above ground a ground-impact resolves at. */
const GROUND_IMPACT_HEIGHT = 0;

/**
 * A deterministic roll in [0, 1) for one specific shot.
 *
 * There is no seeded PRNG anywhere in this simulation, and adding one would
 * mean a new piece of state to serialize, hash, and keep in step across a
 * lockstep match — a stream whose position is itself a desync surface, where
 * one client taking one extra draw silently diverges every roll thereafter.
 *
 * Hashing instead is stateless. Every client already agrees on the shooter's
 * id, the target's id and the tick; feeding those to the FNV-1a already used
 * for the lockstep state hash gives every client the same answer with nothing
 * to keep synchronised and nothing to restore on load. A resync that rewinds
 * the world reproduces the same rolls rather than desynchronising a stream.
 *
 * `salt` decorrelates rolls that share the same shot — the hit/miss decision
 * and the direction a miss goes must not be the same number.
 */
export function shotRoll(shooterId, targetId, tick, salt = '') {
  return fnv1a(`${shooterId}|${targetId}|${tick}|${salt}`) / 0x100000000;
}

let nextProjectileId = 1;

/** Restore-time hook: keep ids ahead of anything a save already contains. */
export function reserveProjectileId(id) {
  if (id >= nextProjectileId) nextProjectileId = id + 1;
}

/** Testing/new-game hook — ids restart with the world. */
export function resetProjectileIds() {
  nextProjectileId = 1;
}

export class Projectiles {
  /**
   * @param {object} opts
   * @param {object} opts.vehicles VehicleController — for re-resolving a
   *   target by id at arrival, never for scanning
   * @param {object} opts.structures StructureController, same
   * @param {object} opts.heightmap ground height at the impact point
   * @param {object} opts.entities destroy pipeline; a kill is queued, never
   *   spliced here, exactly as combatController did before
   * @param {object} opts.game for teamOf/teams
   * @param {(impact) => void} [opts.onImpact] cosmetic hook — craters, scorch,
   *   explosions and lights all hang off this one call
   */
  constructor({ vehicles, structures, heightmap, entities, game, onImpact = null }) {
    this.vehicles = vehicles;
    this.structures = structures;
    this.heightmap = heightmap;
    this.entities = entities;
    this.game = game;
    this.onImpact = onImpact;
    /** In-flight shells. Plain array; render reads it directly each frame. */
    this.instances = [];
  }

  /**
   * Launch a shell. Called by combatController at the moment of firing, with
   * everything already decided.
   *
   * `damage` and `teamId` are values, not lookups — see the header. The only
   * live thing retained is `targetId`/`targetKind`, and that is re-resolved
   * from the owning collection at arrival precisely because it may be gone.
   */
  spawn({
    shooter,
    target,
    willHit,
    damage,
    turretDef,
    muzzleHeight,
    targetHeight,
    aimX,
    aimZ,
    aimY,
  }) {
    const from = shooter.group ? shooter.group.position : shooter;
    const x = from.x;
    const z = from.z;
    const y = this.heightmap.heightAt(x, z) + muzzleHeight;

    const dx = aimX - x;
    const dz = aimZ - z;
    const flat = Math.hypot(dx, dz);
    const speed = turretDef?.projectileSpeed ?? DEFAULT_PROJECTILE_SPEED;
    // Flight time comes from the flat distance rather than the 3D one so a
    // shot up a hillside doesn't slow down for the climb; the arc is a
    // presentational overlay on a straight horizontal path, not a solved
    // trajectory.
    const flight = Math.max(1e-3, flat / speed);

    // Vertical velocity chosen so the shell arrives at exactly `aimY` after
    // `flight` seconds under SHELL_GRAVITY. Solving it rather than picking a
    // lob angle keeps arrival time independent of the arc, which is what lets
    // the arc be a pure legibility knob.
    const vy = (aimY - y) / flight + 0.5 * SHELL_GRAVITY * flight;

    const p = {
      id: nextProjectileId++,
      teamId: shooter.teamId,
      shooterId: shooter.id,
      // Recorded alongside the id because the two id spaces are separate:
      // vehicle and structure ids are independent counters that both start at
      // 1 (see net/intents.js), so `shooterId` alone is ambiguous. Without
      // this, a turret structure's kill was credited to the *vehicle* of the
      // same number.
      shooterKind: shooter.kind ?? 'vehicle',
      shooterDefId: shooter.def?.id ?? null,
      damage,
      // Drives crater size, explosion scale and light radius downstream.
      // Copied rather than looked up so a shell outlives its turret def
      // changing under a hot reload.
      calibre: damage,
      color: turretDef?.projectileColor ?? null,
      x,
      y,
      z,
      vx: flat > 1e-6 ? (dx / flat) * speed : 0,
      vy,
      vz: flat > 1e-6 ? (dz / flat) * speed : 0,
      aimX,
      aimY,
      aimZ,
      targetId: willHit ? target?.id ?? null : null,
      targetKind: willHit ? target?.kind ?? null : null,
      targetHeight,
      willHit,
      elapsed: 0,
      flight,
    };
    this.instances.push(p);
    return p;
  }

  update(dt) {
    if (this.instances.length === 0) return;
    // Walk backwards so a shell resolving and splicing itself out cannot make
    // the loop skip the one that shuffles into its index.
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const p = this.instances[i];
      p.elapsed += dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.y += p.vy * dt;
      p.vy -= SHELL_GRAVITY * dt;

      // Arrival is a time comparison, not a distance one. Distance-to-target
      // is unreliable at these speeds: a shell moving 160 units/second covers
      // 2.7 units per tick and can step clean over any sensible radius, so a
      // proximity test would need a radius wide enough to trigger early.
      if (p.elapsed >= p.flight || p.elapsed > MAX_FLIGHT_SECONDS) {
        this.instances.splice(i, 1);
        this._resolve(p);
      }
    }
  }

  /** A shell arrived. Decide what it hit and tell everyone who cares. */
  _resolve(p) {
    if (p.willHit) {
      const target = this._lookup(p.targetKind, p.targetId);
      // The target died between launch and arrival — to another shell, a
      // collision, anything. The shot is not silently deleted: it becomes a
      // ground impact where the target used to be, which is both the honest
      // outcome and the readable one (a crater appears next to the wreck).
      if (target && !target.dead) {
        this._hit(p, target);
        return;
      }
    }
    this._groundImpact(p);
  }

  _hit(p, target) {
    const killed = target.takeDamage(p.damage);
    if (killed) {
      // Kill bookkeeping, moved wholesale from combatController._fire. It runs
      // here now because *here* is where a kill actually happens — and it
      // works without the shooter still existing, since everything it needs
      // beyond the tallies was copied into the shell at launch.
      // By kind, not by trying vehicles first and falling back — that fallback
      // silently mis-credited every turret kill to a same-numbered vehicle.
      // `?? 'vehicle'` covers a shell restored from a save written before
      // `shooterKind` existed; those carry the old ambiguity and nothing can
      // recover it, but they resolve the way they always did rather than
      // throwing.
      const shooter = this._lookup(p.shooterKind ?? 'vehicle', p.shooterId);
      if (shooter && !shooter.dead) {
        shooter.kills = (shooter.kills ?? 0) + 1;
        // Only ever "is this run better than the best so far", answerable now.
        const shooterTeam = this.game.teamOf(shooter);
        if (shooterTeam) {
          const stats = shooterTeam.stats;
          const defId = shooter.def.id;
          stats.killsByDefId[defId] = (stats.killsByDefId[defId] ?? 0) + 1;
          if (shooter.kills > (stats.topKillsVehicle?.kills ?? 0)) {
            stats.topKillsVehicle = { defId, kills: shooter.kills };
          }
        }
        if (shooter.combatTarget === target) shooter.combatTarget = null;
      } else {
        // The shooter is gone, so its per-instance `kills` has gone with it
        // (vehicles.remove splices the instance out). The team tally is still
        // owed the kill, and `shooterDefId` is exactly what it needs — this is
        // the case the old hitscan path could never produce and therefore
        // never had to handle.
        const team = this.game.teams?.[p.teamId];
        if (team && p.shooterDefId) {
          team.stats.killsByDefId[p.shooterDefId] =
            (team.stats.killsByDefId[p.shooterDefId] ?? 0) + 1;
        }
      }
      this.entities.queueDestroy(target);
    }

    const point = target.x !== undefined ? target : target.group.position;
    this.onImpact?.({
      x: point.x,
      y: p.y,
      z: point.z,
      ground: false,
      damage: p.damage,
      calibre: p.calibre,
      teamId: p.teamId,
      color: p.color,
      killed,
    });
  }

  _groundImpact(p) {
    const y = this.heightmap.heightAt(p.x, p.z) + GROUND_IMPACT_HEIGHT;
    this.onImpact?.({
      x: p.x,
      y,
      z: p.z,
      ground: true,
      damage: p.damage,
      calibre: p.calibre,
      teamId: p.teamId,
      color: p.color,
      killed: false,
    });
  }

  _lookup(kind, id) {
    if (id == null) return null;
    const pool = kind === 'structure' ? this.structures.instances : this.vehicles.instances;
    for (const inst of pool) {
      if (inst.id === id) return inst;
    }
    // A caller that doesn't know the kind (the kill-credit path above, where
    // a shooter may be either a vehicle or a turret structure) tries both
    // collections rather than expecting this to guess.
    return null;
  }

  /**
   * Put a saved shell back in the air.
   *
   * Nothing is recomputed: velocity, elapsed time and flight duration are all
   * restored as saved, so the shell resumes exactly where it was rather than
   * being re-launched from its current position (which would reset its arc and
   * could make it arrive somewhere else). `willHit` in particular is restored
   * rather than re-rolled — the roll is a hash of the *launch* tick, and that
   * tick is in the past by the time this runs.
   */
  restore(saved) {
    reserveProjectileId(saved.id);
    this.instances.push({ ...saved });
  }

  /** Terrain regenerated or a new game started: nothing in flight is meaningful. */
  clear() {
    this.instances.length = 0;
  }
}

/**
 * Effective damage for one shot, including the shooter's rank.
 *
 * Exported and pure so both combatController and the tests can reach it
 * without constructing a controller.
 */
export function shotDamage(inst) {
  const base = inst.def?.turret?.damage ?? 0;
  return base * rankDamageMultiplier(rankOfInstance(inst));
}
