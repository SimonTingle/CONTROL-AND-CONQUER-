/**
 * Two independent checks over the same vehicle-pair distances, once a tick:
 *
 * - Avoidance: an autonomous vehicle (not the one the player is currently
 *   driving, and only while it actually has somewhere to be) yields to
 *   anything genuinely ahead of it — moving or not — by steering around it
 *   rather than pushing through. `computeAvoidOffset` nudges the vehicle's
 *   steering aim point sideways (vehicleController.js's `driveToTarget`
 *   consumes it via `steeringAimPoint`); arrival distance is always measured
 *   against the real target, so a swerve can never cause a false arrival. A
 *   forward cone, not a "does the other vehicle also have an order" gate:
 *   the earlier version treated any arrived/parked vehicle as invisible to
 *   avoidance (`arrive()` nulls `target`, so a vehicle stopped on purpose
 *   dropped out of the check the instant it stopped) and got driven into.
 *   A true head-on — each inside the other's cone — ties on `createdAt` so
 *   exactly one yields, not both; two deadlocked forever is worse than one
 *   briefly stuck. The player's own vehicle never yields — ramming one is
 *   still possible, on purpose. Yielding that drags on past a short
 *   threshold triggers a reverse (vehicleController.js's `beginReverse`)
 *   rather than circling the same obstacle indefinitely — the same escape
 *   this always had, now the backstop for swerves that can't clear it too.
 * - Collision: any pair that actually makes contact — a much tighter radius
 *   than avoidance — takes a damage hit scaled by how fast they were closing
 *   (a slow jostle in a queue does nothing; a real ram still hurts) and a
 *   positional bump apart. The bump runs every tick contact persists, to
 *   keep the pair visibly separated; damage and its cooldown are strictly
 *   time-based and independent of the bump, on purpose — the previous
 *   version's "still overlapping" memory was erased by its own bump moving
 *   them apart the same tick, so a converging pair re-collided (and
 *   re-damaged) every few frames.
 *
 * Object identity, not array index, is what tracks cooldowns and contact —
 * instances aren't guaranteed to keep a stable index as the fleet grows.
 */

const AVOIDANCE_MARGIN = 6; // world units of clearance beyond both hulls before yielding
const AVOIDANCE_CONE_HALF_ANGLE = Math.PI / 3; // 60° either side of heading — a 120° forward arc
const AVOIDANCE_LATERAL_SCALE = 0.6; // fraction of (a's + b's) hull radius used as the aim-point nudge
const COLLISION_MARGIN = 0.5; // world units of tolerance before overlap counts as a hit
const COLLISION_COOLDOWN = 1.5; // seconds a pair is immune to re-damage after a hit
const MIN_IMPACT_SPEED = 1.5; // u/s of closing speed below which contact is harmless jostling
const DAMAGE_PER_SPEED = 0.8; // HP per u/s of closing speed above the threshold
const MAX_COLLISION_DAMAGE = 8; // cap for a genuinely fast ram
const DAMAGE_FLOOR_FRACTION = 0.15; // matches vehicleController's own blocked-damage floor
const BUMP_CLEARANCE = 0.3; // extra separation beyond "just barely not touching"
const YIELD_REVERSE_THRESHOLD = 2; // seconds continuously yielding before backing off
const REVERSE_DURATION = 1.5;
const REVERSE_BEHIND_CHECK = 8; // world units — don't back blindly into this

function hullRadius(def) {
  return Math.max(def.dims.hullLength, def.dims.hullWidth) / 2;
}

/** Signed angle from `a` to `b`, wrapped to [-π, π]. */
function bearingDelta(a, b, fromHeading) {
  const dx = b.group.position.x - a.group.position.x;
  const dz = b.group.position.z - a.group.position.z;
  const bearing = Math.atan2(dz, dx);
  const delta = bearing - fromHeading;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

/**
 * Is `target` roughly ahead of `observer`, within the avoidance cone?
 * Deliberately ignores whether `target` has an order — a stopped vehicle is
 * still something to avoid driving through.
 */
function isAhead(observer, target) {
  return Math.abs(bearingDelta(observer, target, observer.heading)) <= AVOIDANCE_CONE_HALF_ANGLE;
}

/**
 * Lateral nudge for `a`'s steering aim point that clears `b`, rather than the
 * flat stop `yielding` used to mean on its own. Which side to swerve to is a
 * pure function of relative position (the sign of forward x bearing-to-b);
 * dead on the centerline has no side to prefer from that alone, so it falls
 * back to the same `createdAt` tie-break the head-on branch already uses,
 * keeping every branch of "which way" a function of simulated state, never
 * arbitrary. Magnitude scales with both hull radii and fades toward the edge
 * of the avoidance cone, so a glancing sighting barely nudges the aim point
 * while a dead-ahead one gets the full swerve.
 */
export function computeAvoidOffset(a, b) {
  const dx = b.group.position.x - a.group.position.x;
  const dz = b.group.position.z - a.group.position.z;
  const fx = Math.cos(a.heading);
  const fz = Math.sin(a.heading);
  const cross = fx * dz - fz * dx;
  const side = Math.abs(cross) > 1e-6 ? Math.sign(cross) : (a.createdAt <= b.createdAt ? 1 : -1);
  const bearingWeight = 1 - Math.abs(bearingDelta(a, b, a.heading)) / AVOIDANCE_CONE_HALF_ANGLE;
  const magnitude =
    (hullRadius(a.def) + hullRadius(b.def)) * AVOIDANCE_LATERAL_SCALE * Math.max(0.2, bearingWeight);
  // Right-perpendicular of a's heading (fz, -fx), scaled by side and magnitude.
  return { x: fz * side * magnitude, z: -fx * side * magnitude };
}

/**
 * Exported so harvesterAI and repairController can guard their own
 * `beginReverse` calls with it — reversing is "drive blind", and nothing
 * about backing away from one obstacle should walk it straight into another.
 */
export function hasVehicleBehind(inst, instances, checkDistance = REVERSE_BEHIND_CHECK) {
  for (const other of instances) {
    if (other === inst) continue;
    const dx = other.group.position.x - inst.group.position.x;
    const dz = other.group.position.z - inst.group.position.z;
    if (Math.hypot(dx, dz) > checkDistance) continue;
    if (Math.abs(bearingDelta(inst, other, inst.heading + Math.PI)) < Math.PI / 2) return true;
  }
  return false;
}

export class TrafficController {
  constructor({ vehicles }) {
    this.vehicles = vehicles;
    /** instance -> Map(other instance -> seconds of damage immunity left). */
    this._cooldowns = new Map();
  }

  /**
   * Candidate `[i, j]` index pairs close enough to be worth measuring, in
   * exactly the order the old nested loop would have produced them.
   *
   * The pass was O(U^2): every vehicle measured against every other, every
   * tick, at 60Hz. At the 40-unit matches it was written for that is 780
   * pairs a tick; a 20-team match pushes unit counts high enough for the
   * square to matter (200 units is 19,900 pairs a tick, 1.2M a second). A
   * uniform grid makes it O(U + pairs-actually-near).
   *
   * **Order is preserved deliberately, and that is the whole subtlety.**
   * `_resolveAvoidance` and `_resolveCollision` mutate the instances they are
   * given, so the sequence pairs are visited in is part of the simulation's
   * result, not an implementation detail. A spatial hash naturally yields
   * pairs in bucket order, which would be a different sequence and therefore
   * a different simulation — a desync between a patched and an unpatched
   * client, in a lockstep match. So candidates are collected and then sorted
   * back into ascending `(i, j)`, which is the order the nested loop emitted.
   * `tests/traffic-avoidance-swerve.test.mjs` checks this against a
   * brute-force reference.
   *
   * Cells are sized to the widest possible interaction, so a pair that can
   * interact at all is always in the same or an adjacent cell.
   */
  _nearPairs(instances) {
    let maxRadius = 0;
    for (const inst of instances) {
      if (inst.dead) continue;
      const r = hullRadius(inst.def);
      if (r > maxRadius) maxRadius = r;
    }
    // The largest distance at which any pair can do anything: two widest
    // hulls plus the avoidance margin (which exceeds the collision radius).
    const reach = maxRadius * 2 + AVOIDANCE_MARGIN;
    const pairs = [];
    if (reach <= 0) return pairs;

    const buckets = new Map();
    const key = (cx, cz) => `${cx},${cz}`;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      // Dead but not yet flushed — a corpse should not be yielded to, bumped
      // apart, or handed collision damage on its way out.
      if (inst.dead) continue;
      const cx = Math.floor(inst.group.position.x / reach);
      const cz = Math.floor(inst.group.position.z / reach);
      const k = key(cx, cz);
      let bucket = buckets.get(k);
      if (!bucket) buckets.set(k, (bucket = []));
      bucket.push(i);
    }

    const reachSq = reach * reach;
    for (let i = 0; i < instances.length; i++) {
      const a = instances[i];
      if (a.dead) continue;
      const cx = Math.floor(a.group.position.x / reach);
      const cz = Math.floor(a.group.position.z / reach);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = buckets.get(key(cx + dx, cz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue; // the old loop's `j = i + 1`, without the scan
            const b = instances[j];
            const ddx = a.group.position.x - b.group.position.x;
            const ddz = a.group.position.z - b.group.position.z;
            // Squared compare, so the broad phase costs no square roots; the
            // exact distance is measured once, in update(), for pairs that
            // survive. Anything beyond `reach` could not have triggered
            // either branch there, so dropping it changes nothing.
            if (ddx * ddx + ddz * ddz <= reachSq) pairs.push([i, j]);
          }
        }
      }
    }

    pairs.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
    return pairs;
  }

  update(dt) {
    const instances = this.vehicles.instances;

    for (const inst of instances) {
      inst.yielding = false;
      inst.avoidOffset = null;
    }
    this._tickCooldowns(dt);

    for (const [i, j] of this._nearPairs(instances)) {
      const a = instances[i];
      const b = instances[j];
      const dist = Math.hypot(
        a.group.position.x - b.group.position.x,
        a.group.position.z - b.group.position.z
      );

      const avoidRadius = hullRadius(a.def) + hullRadius(b.def) + AVOIDANCE_MARGIN;
      if (dist < avoidRadius) this._resolveAvoidance(a, b);

      const hitRadius = hullRadius(a.def) + hullRadius(b.def) - COLLISION_MARGIN;
      if (dist < hitRadius) this._resolveCollision(a, b, dist, hitRadius);
    }

    // A vehicle that's been yielding continuously for a while — not just this
    // tick — backs off rather than sit frozen indefinitely next to whatever's
    // in its way (which, with a stationary obstacle now avoidable too, can
    // genuinely never move on its own). `_yieldTimer` lives directly on the
    // instance, the same pattern repairController uses for its own
    // per-instance bookkeeping (e.g. a bay's `_repairQueue`).
    for (const inst of instances) {
      if (!inst.yielding) {
        inst._yieldTimer = 0;
        continue;
      }
      inst._yieldTimer = (inst._yieldTimer ?? 0) + dt;
      if (inst._yieldTimer >= YIELD_REVERSE_THRESHOLD && inst.reverseTimer == null) {
        if (!hasVehicleBehind(inst, instances)) inst.beginReverse(REVERSE_DURATION);
        inst._yieldTimer = 0;
      }
    }
  }

  _resolveAvoidance(a, b) {
    const aSeesB = this._isAutonomous(a) && isAhead(a, b);
    const bSeesA = this._isAutonomous(b) && isAhead(b, a);
    if (aSeesB && bSeesA) {
      // True head-on: both see the other as blocking. Yielding both would
      // deadlock forever, so break the tie deterministically.
      if (a.createdAt <= b.createdAt) this._yieldTo(a, b);
      else this._yieldTo(b, a);
      return;
    }
    if (aSeesB) this._yieldTo(a, b);
    if (bSeesA) this._yieldTo(b, a);
  }

  _yieldTo(inst, obstacle) {
    inst.yielding = true;
    inst.avoidOffset = computeAvoidOffset(inst, obstacle);
  }

  _resolveCollision(a, b, dist, hitRadius) {
    // Keeps the pair visibly separated on every tick they're still touching,
    // independent of the damage cooldown below — this is what lets the
    // cooldown stay purely time-based instead of "still overlapping", which
    // the bump itself would otherwise immediately falsify.
    this._applyBump(a, b, dist, hitRadius);

    if (this._onCooldown(a, b)) return;
    this._startCooldown(a, b);

    const damage = this._collisionDamage(this._closingSpeed(a, b, dist));
    if (damage <= 0) return; // contact happened, but too gentle to hurt — just the bump
    this._applyCollisionDamage(a, damage);
    this._applyCollisionDamage(b, damage);
  }

  /** Autonomous: not the vehicle the player is driving, and actually going somewhere. */
  _isAutonomous(inst) {
    return inst !== this.vehicles.active && inst.hasOrder;
  }

  /** Positive = closing (approaching along the line between them), negative = separating. */
  _closingSpeed(a, b, dist) {
    if (dist < 1e-4) return 0;
    const ap = a.group.position;
    const bp = b.group.position;
    const nx = (bp.x - ap.x) / dist;
    const nz = (bp.z - ap.z) / dist;
    const relVx = Math.cos(a.heading) * a.forwardSpeed - Math.cos(b.heading) * b.forwardSpeed;
    const relVz = Math.sin(a.heading) * a.forwardSpeed - Math.sin(b.heading) * b.forwardSpeed;
    return relVx * nx + relVz * nz;
  }

  _collisionDamage(closingSpeed) {
    const excess = Math.max(0, closingSpeed - MIN_IMPACT_SPEED);
    return Math.min(MAX_COLLISION_DAMAGE, excess * DAMAGE_PER_SPEED);
  }

  /**
   * Routed through the vehicle's own takeDamage so every path that lowers
   * health goes through one place. The floor is what keeps this *wear* rather
   * than violence: ramming can wreck a vehicle's day but must never destroy
   * it, or the cheapest way to kill anything would be to drive into it.
   */
  _applyCollisionDamage(inst, damage) {
    inst.takeDamage(damage, { floorFraction: DAMAGE_FLOOR_FRACTION });
  }

  /** Push both vehicles apart along the line between their centres, split
   * evenly, so neither is still overlapping the other afterward. */
  _applyBump(a, b, dist, hitRadius) {
    const ap = a.group.position;
    const bp = b.group.position;
    const dx = ap.x - bp.x;
    const dz = ap.z - bp.z;
    // Exactly coincident (dist ~ 0) has no direction to push along — pick an
    // arbitrary stable one rather than dividing by zero.
    const nx = dist > 1e-4 ? dx / dist : 1;
    const nz = dist > 1e-4 ? dz / dist : 0;
    const push = (hitRadius - dist) / 2 + BUMP_CLEARANCE;
    ap.x += nx * push;
    ap.z += nz * push;
    bp.x -= nx * push;
    bp.z -= nz * push;
  }

  _tickCooldowns(dt) {
    for (const [inst, others] of this._cooldowns) {
      for (const [other, remaining] of others) {
        const next = remaining - dt;
        if (next <= 0) others.delete(other);
        else others.set(other, next);
      }
      if (others.size === 0) this._cooldowns.delete(inst);
    }
  }

  _onCooldown(a, b) {
    return (this._cooldowns.get(a)?.get(b) ?? 0) > 0;
  }

  _startCooldown(a, b) {
    if (!this._cooldowns.has(a)) this._cooldowns.set(a, new Map());
    if (!this._cooldowns.has(b)) this._cooldowns.set(b, new Map());
    this._cooldowns.get(a).set(b, COLLISION_COOLDOWN);
    this._cooldowns.get(b).set(a, COLLISION_COOLDOWN);
  }

  /**
   * Drop this instance's cooldown bookkeeping immediately, both as an outer
   * key and as anything another vehicle's inner map still holds against it.
   * `_tickCooldowns` would eventually self-clean these anyway (every entry
   * decays to zero within COLLISION_COOLDOWN seconds), but there's no reason
   * to let a destroyed instance linger as a Map key even that briefly.
   */
  onDestroy(inst) {
    this._cooldowns.delete(inst);
    for (const others of this._cooldowns.values()) others.delete(inst);
  }
}
