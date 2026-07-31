/**
 * Autonomous harvesting.
 *
 * The governing rule, and the reason this file exists rather than a few lines
 * in the controller: **it never infers anything from `hasOrder`, and never
 * trusts `blocked`.**
 *
 * `driveToTarget` calls the same `arrive()` whether it reached the goal or gave
 * up on an unclimbable slope, so from outside the two are indistinguishable —
 * `hasOrder` flips false identically. `blocked` looks like a discriminator but
 * goes stale: nothing clears it while coasting. So the driver measures its own
 * distance to its own destination. Success is defined by distance, which the
 * conflation cannot touch; anything else that drops the order is abandonment,
 * exactly.
 */

const IDLE = 'idle';
const TO_FIELD = 'to-field';
const FILLING = 'filling';
const TO_BASE = 'to-base';
const UNLOADING = 'unloading';
const PAUSED = 'paused';

// Comfortably larger than a harvester's own turning radius (~19u). Smaller than
// that and `driveToTarget`'s pure-pursuit steering can overshoot, lose speed —
// and with it, yaw authority, since the bicycle model only turns while
// moving — right as it needs to turn tightest, and drift off in a near-straight
// line instead of curling back. Arriving a little wide of the exact point is a
// far better failure mode than never arriving at all.
const DOCK_DISTANCE = 22;
const WAYPOINT_RADIUS = 16;
const RESUME_DELAY = 0.35; // seconds of quiet keys before the loop picks up again
const STALL_SPEED = 0.3;
const STALL_TIMEOUT = 3; // seconds barely moving in a driving state
const RETRY_PAUSE = 1.5;
const BAN_SECONDS = 45;
const TRANSFER_SPEED = 0.5; // must be near enough stopped to load or unload

// A fresh automatic pick prefers to leave a nearly-drained field alone and to
// spread out rather than pile onto one — both soft: see _idle()'s fallback.
const LOW_STOCK_FRACTION = 0.33;
const MAX_HARVESTERS_PER_FIELD = 2;

/** Widening, alternating. A straight retry cannot work: the heading is unchanged. */
const DETOUR_ANGLES = [0.9, -0.9, 1.6, -1.6, 2.4];

export class HarvesterAI {
  constructor({ vehicles, world, heightmap, structures, game }) {
    this.vehicles = vehicles;
    this.world = world;
    this.heightmap = heightmap;
    this.structures = structures;
    this.game = game;
    this.states = new Map();
  }

  stateOf(instance) {
    return this.states.get(instance) ?? null;
  }

  /** Terrain regenerated: every field reference and destination is meaningless. */
  reset() {
    this.states.clear();
  }

  update(dt) {
    for (const inst of this.vehicles.instances) {
      if (!inst.def.capacity) continue; // not a hauler
      this._drive(inst, this._stateFor(inst), dt);
    }
  }

  _stateFor(inst) {
    let s = this.states.get(inst);
    if (!s) {
      s = {
        state: IDLE,
        resumeState: IDLE,
        load: 0,
        field: null,
        dest: null,
        waypoint: null,
        detours: 0,
        stallTimer: 0,
        pauseTimer: 0,
        retryTimer: 0,
        bans: new Map(),
      };
      this.states.set(inst, s);
    }
    return s;
  }

  _drive(inst, s, dt) {
    // Runs after applyDriveInput, so this is *this frame's* input: never issue
    // an order the player has already cancelled.
    const driven = inst.throttle !== 0 || inst.steer !== 0;
    if (driven) {
      if (s.state !== PAUSED) {
        s.resumeState = s.state;
        s.state = PAUSED;
      }
      s.pauseTimer = RESUME_DELAY;
      return;
    }

    if (s.state === PAUSED) {
      s.pauseTimer -= dt;
      if (s.pauseTimer > 0) return;
      s.state = s.resumeState;
      s.dest = null; // the old order was nulled by the input; re-issue cleanly
      s.waypoint = null;
    }

    this._updateLoadCells(inst, s);

    if (s.retryTimer > 0) {
      s.retryTimer -= dt;
      return;
    }

    switch (s.state) {
      case IDLE:
        return this._idle(inst, s);
      case TO_FIELD:
        // Same overshoot risk as the dock: a field's own radius (14) can sit
        // inside the harvester's turning radius, so floor it at the dock
        // distance rather than trusting the field's physical size.
        return this._travel(inst, s, dt, Math.max(s.field?.radius ?? 12, DOCK_DISTANCE), () =>
          this._reachedField(inst, s)
        );
      case FILLING:
        return this._fill(inst, s, dt);
      case TO_BASE:
        return this._travel(inst, s, dt, DOCK_DISTANCE, () => {
          s.state = UNLOADING;
        });
      case UNLOADING:
        return this._unload(inst, s, dt);
      default:
        s.state = IDLE;
    }
  }

  // ---- states ----

  _idle(inst, s) {
    const now = performance.now() / 1000;

    if (s.load >= inst.def.capacity * 0.98) {
      s.state = TO_BASE;
      s.dest = null;
      return;
    }

    let field = this.world.blooms.nearestTo(inst.group.position.x, inst.group.position.z, {
      minStock: 1,
      reject: (f) => (s.bans.get(f.id) ?? 0) > now || this._isFieldCrowdedOrLow(f, inst),
    });
    if (!field) {
      // Nothing healthy and uncrowded reachable — fall back to the plain pick
      // rather than let the harvester idle just because every field is low
      // or already staffed.
      field = this.world.blooms.nearestTo(inst.group.position.x, inst.group.position.z, {
        minStock: 1,
        reject: (f) => (s.bans.get(f.id) ?? 0) > now,
      });
    }

    if (!field) {
      // Everything reachable is banned or empty. Forget the bans rather than
      // idling forever — a harvester that permanently gives up is just broken.
      if (s.bans.size) s.bans.clear();
      else if (s.load > 0) s.state = TO_BASE;
      s.retryTimer = RETRY_PAUSE;
      return;
    }

    s.field = field;
    s.detours = 0;
    if (this._order(inst, s, { x: field.x, z: field.z })) s.state = TO_FIELD;
    else {
      s.bans.set(field.id, now + BAN_SECONDS);
      s.retryTimer = RETRY_PAUSE;
    }
  }

  _isFieldCrowdedOrLow(field, inst) {
    if (field.capacity > 0 && field.stock / field.capacity <= LOW_STOCK_FRACTION) return true;
    return this._countHarvestersOnField(field, inst) >= MAX_HARVESTERS_PER_FIELD;
  }

  _countHarvestersOnField(field, excludeInst) {
    let count = 0;
    for (const [inst, s] of this.states) {
      if (inst === excludeInst) continue;
      if (s.field === field && (s.state === TO_FIELD || s.state === FILLING)) count++;
    }
    return count;
  }

  _reachedField(inst, s) {
    // The field may have been stripped or paved while we drove to it.
    if (!s.field || s.field.dead || s.field.stock <= 0) {
      s.bans.set(s.field?.id ?? -1, performance.now() / 1000 + BAN_SECONDS);
      s.state = s.load > 0 ? TO_BASE : IDLE;
      s.dest = null;
      return;
    }
    s.state = FILLING;
  }

  _fill(inst, s, dt) {
    if (inst.speed > TRANSFER_SPEED) return; // let it roll to a stop first

    const def = inst.def;
    const room = def.capacity - s.load;
    s.load += this.world.blooms.harvest(s.field, Math.min(def.fillRate * dt, room));

    const full = s.load >= def.capacity - 1e-6;
    const dry = !s.field || s.field.dead || s.field.stock <= 0;

    if (full || (dry && s.load > 0)) {
      s.state = TO_BASE;
      s.dest = null;
      s.detours = 0;
    } else if (dry) {
      s.bans.set(s.field.id, performance.now() / 1000 + BAN_SECONDS);
      s.state = IDLE;
    }
  }

  _unload(inst, s, dt) {
    if (inst.speed > TRANSFER_SPEED) return;

    const facility = this._facility();
    if (!facility) {
      s.state = IDLE;
      return;
    }

    const rate = Math.min(facility.def.unloadRate, inst.def.unloadRate);
    const moved = Math.min(rate * dt, s.load);
    s.load -= moved;
    this.game.earn(moved);

    if (s.load <= 1e-6) {
      s.load = 0;
      s.state = IDLE;
      s.dest = null;
      s.detours = 0;
    }
  }

  // ---- driving ----

  _facility() {
    return this.structures.instances.find((i) => i.mode === 'idle' && i.def.unloadRate) ?? null;
  }

  /** Where this state is trying to get to, recomputed so it can never go stale. */
  _destination(inst, s) {
    if (s.state === TO_FIELD) return s.field ? { x: s.field.x, z: s.field.z } : null;
    if (s.state === TO_BASE) {
      const f = this._facility();
      return f ? { x: f.dock.x, z: f.dock.z } : null;
    }
    return null;
  }

  /**
   * The shared driving step.
   *
   * Arrival is *our* distance test against *our* destination — never
   * `hasOrder`, which cannot tell success from a refusal.
   */
  _travel(inst, s, dt, arriveRadius, onArrive) {
    const dest = this._destination(inst, s);
    if (!dest) {
      s.state = IDLE;
      return;
    }

    const pos = inst.group.position;
    const d = Math.hypot(dest.x - pos.x, dest.z - pos.z);

    if (d <= arriveRadius) {
      inst.arrive('reached');
      s.dest = null;
      s.waypoint = null;
      s.detours = 0;
      s.stallTimer = 0;
      onArrive();
      return;
    }

    // Reached a detour waypoint: drop it and aim at the real goal again.
    if (s.waypoint) {
      const wd = Math.hypot(s.waypoint.x - pos.x, s.waypoint.z - pos.z);
      if (wd <= WAYPOINT_RADIUS) {
        s.waypoint = null;
        s.detours = 0;
        this._order(inst, s, dest);
        return;
      }
    }

    if (!inst.hasOrder) {
      // The controller dropped the order short of the goal. That is
      // abandonment — no need to consult `blocked`, which coasting never clears.
      this._onAbandoned(inst, s, dest, d);
      return;
    }

    // Stuck without abandoning: grinding at something with the order still live.
    s.stallTimer = inst.speed < STALL_SPEED ? s.stallTimer + dt : 0;
    if (s.stallTimer > STALL_TIMEOUT) {
      s.stallTimer = 0;
      this._onAbandoned(inst, s, dest, d);
    }
  }

  _onAbandoned(inst, s, dest, distance) {
    const pos = inst.group.position;

    if (s.detours < DETOUR_ANGLES.length) {
      const bearing = Math.atan2(dest.z - pos.z, dest.x - pos.x) + DETOUR_ANGLES[s.detours];
      s.detours++;
      const range = Math.min(35, Math.max(12, distance * 0.6));
      const wx = pos.x + Math.cos(bearing) * range;
      const wz = pos.z + Math.sin(bearing) * range;

      if (this._routeLooksDrivable(inst, pos, wx, wz)) {
        s.waypoint = { x: wx, z: wz };
        if (this._order(inst, s, s.waypoint)) return;
      }
      // Bad candidate — fall through and try the next angle next tick.
      s.retryTimer = 0.2;
      return;
    }

    // Out of detours.
    s.waypoint = null;
    s.detours = 0;

    if (s.state === TO_BASE) {
      // Home is never bannable: the pad is reachable by construction, the base
      // drove there. A harvester circling near home beats one frozen in a
      // canyon, so just keep trying.
      s.retryTimer = RETRY_PAUSE;
      s.dest = null;
      return;
    }

    // Ban the destination, not the route: the failure this handles is "that
    // field sits on ground I cannot climb", and moving on is what a player
    // would do.
    if (s.field) s.bans.set(s.field.id, performance.now() / 1000 + BAN_SECONDS);
    s.state = s.load > 0 ? TO_BASE : IDLE;
    s.dest = null;
    s.retryTimer = RETRY_PAUSE;
  }

  /** Cheap straight-line check before committing to a detour waypoint. */
  _routeLooksDrivable(inst, from, x, z) {
    const hm = this.heightmap;
    if (hm.heightAt(x, z) <= hm.seaLevelY + 1) return false;

    const samples = 5;
    let worst = 0;
    let prev = hm.heightAt(from.x, from.z);
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const px = from.x + (x - from.x) * t;
      const pz = from.z + (z - from.z) * t;
      const h = hm.heightAt(px, pz);
      const run = Math.hypot(x - from.x, z - from.z) / samples;
      worst = Math.max(worst, Math.abs(h - prev) / Math.max(run, 1e-3));
      prev = h;
    }
    return worst < inst.def.maxClimbGrade * 0.8;
  }

  _order(inst, s, point) {
    const ok = inst.setTarget(point.x, point.z, this.heightmap);
    if (ok) s.dest = point;
    return ok;
  }

  _updateLoadCells(inst, s) {
    const cells = inst.group.userData.loadCells;
    if (!cells) return;
    const lit = Math.ceil((s.load / inst.def.capacity) * cells.length);
    for (let i = 0; i < cells.length; i++) {
      cells[i].emissiveIntensity = i < lit ? 2.4 : 0;
    }
  }
}
