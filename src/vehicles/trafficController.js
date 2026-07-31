/**
 * Two independent checks over the same vehicle-pair distances, once a tick:
 *
 * - Avoidance: any autonomous vehicle (not the one the player is currently
 *   driving, and only while it actually has somewhere to be) holds in place
 *   rather than push through another vehicle nearby, resuming on its own once
 *   the way clears. The player's own vehicle never yields — ramming one is
 *   still possible, on purpose.
 * - Collision: any pair that actually makes contact — a much tighter radius
 *   than avoidance — takes a one-time damage hit and a positional bump apart,
 *   player included. Both only fire on the tick contact begins, not every
 *   tick two vehicles happen to still be overlapping, or a stuck pair would
 *   grind toward the floor in seconds (and the bump would fight itself).
 *   The bump is a snap, not a spring-animated bounce — the bicycle drive
 *   model has no lateral degree of freedom to inject a sideways velocity
 *   into, so separation is applied directly to position on the contact tick.
 *
 * Object identity, not array index, is what tracks "was this pair already
 * touching last tick" — instances aren't guaranteed to keep a stable index as
 * the fleet grows.
 */

const AVOIDANCE_MARGIN = 6; // world units of clearance beyond both hulls before yielding
const COLLISION_MARGIN = 0.5; // world units of tolerance before overlap counts as a hit
const COLLISION_DAMAGE = 15; // flat chunk per impact, not a per-second rate
const DAMAGE_FLOOR_FRACTION = 0.15; // matches vehicleController's own blocked-damage floor
const BUMP_CLEARANCE = 0.3; // extra separation beyond "just barely not touching"
const YIELD_REVERSE_THRESHOLD = 2; // seconds continuously yielding before backing off
const REVERSE_DURATION = 1.5;

function hullRadius(def) {
  return Math.max(def.dims.hullLength, def.dims.hullWidth) / 2;
}

export class TrafficController {
  constructor({ vehicles }) {
    this.vehicles = vehicles;
    /** instance -> Set of instances it was touching last tick. */
    this._colliding = new Map();
  }

  update(dt) {
    const instances = this.vehicles.instances;
    const nextColliding = new Map();

    for (const inst of instances) inst.yielding = false;

    for (let i = 0; i < instances.length; i++) {
      const a = instances[i];
      for (let j = i + 1; j < instances.length; j++) {
        const b = instances[j];
        const dist = Math.hypot(
          a.group.position.x - b.group.position.x,
          a.group.position.z - b.group.position.z
        );

        // Both ends need a live order, not just the one deciding whether to
        // yield — a vehicle that has already arrived and stopped on purpose
        // (docked, queued, parked) has `hasOrder === false` and is not an
        // obstacle to wait out, it's just standing where it means to stand.
        // Without this, a vehicle approaching a bay's queue ring yields
        // forever to whichever vehicle is already parked there and never
        // moving again — the exact close-quarters case the queue system
        // itself already resolves without help.
        const avoidRadius = hullRadius(a.def) + hullRadius(b.def) + AVOIDANCE_MARGIN;
        if (dist < avoidRadius && a.hasOrder && b.hasOrder) {
          if (this._isAutonomous(a)) a.yielding = true;
          if (this._isAutonomous(b)) b.yielding = true;
        }

        const hitRadius = hullRadius(a.def) + hullRadius(b.def) - COLLISION_MARGIN;
        if (dist < hitRadius) {
          this._markPair(nextColliding, a, b);
          if (!this._hasPair(this._colliding, a, b)) {
            this._applyCollisionDamage(a);
            this._applyCollisionDamage(b);
            this._applyBump(a, b, dist, hitRadius);
          }
        }
      }
    }

    // A vehicle that's been yielding continuously for a while — not just this
    // tick — backs off rather than sit frozen indefinitely next to whatever's
    // in its way. `_yieldTimer` lives directly on the instance, the same
    // pattern repairController already uses for its own per-instance
    // bookkeeping (e.g. a bay's `_repairQueue`).
    for (const inst of instances) {
      if (!inst.yielding) {
        inst._yieldTimer = 0;
        continue;
      }
      inst._yieldTimer = (inst._yieldTimer ?? 0) + dt;
      if (inst._yieldTimer >= YIELD_REVERSE_THRESHOLD && inst.reverseTimer == null) {
        inst.beginReverse(REVERSE_DURATION);
        inst._yieldTimer = 0;
      }
    }

    this._colliding = nextColliding;
  }

  /** Autonomous: not the vehicle the player is driving, and actually going somewhere. */
  _isAutonomous(inst) {
    return inst !== this.vehicles.active && inst.hasOrder;
  }

  _applyCollisionDamage(inst) {
    const floor = inst.def.maxHealth * DAMAGE_FLOOR_FRACTION;
    inst.health = Math.max(floor, inst.health - COLLISION_DAMAGE);
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

  _markPair(map, a, b) {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  }

  _hasPair(map, a, b) {
    return map.get(a)?.has(b) ?? false;
  }
}
