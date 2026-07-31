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
const WAITING_FOR_DOCK = 'waiting-for-dock';
const UNLOADING = 'unloading';
const PARKED = 'parked';
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

/** Widening, alternating. A straight retry cannot work: the heading is unchanged. */
const DETOUR_ANGLES = [0.9, -0.9, 1.6, -1.6, 2.4];
const QUEUE_RING = 35; // distance from facility center to queue parking spots
const MAX_QUEUE_POSITIONS = 4; // max harvesters that can queue at a facility

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
    // Player-set targets live on the instance, not in `states`, so clearing the
    // map alone would leave a harvester holding a field from the old world —
    // still not `dead`, so it would pass validation and route to coordinates
    // that now mean nothing.
    for (const inst of this.vehicles.instances) inst.targetField = null;
  }

  /**
   * The player's chosen field, taken exactly once.
   *
   * One-shot on purpose: a target that stayed set would override the driver's
   * own choice of field for the rest of the game, turning "go to this one" into
   * "only ever use this one". Cleared whether or not it turned out to be usable,
   * so a stale pick cannot be retried forever.
   */
  _consumeTargetField(inst) {
    const field = inst.targetField;
    if (!field) return null;
    inst.targetField = null;
    return !field.dead && field.stock > 0 ? field : null;
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
    // an order the player has already cancelled. An open command menu counts as
    // the player's hand on this vehicle too — it holds still while they decide.
    // A repair in progress is also "someone else has the wheel" — the repair
    // controller is issuing its own setTarget() orders to the bay, and this
    // dispatch must stay out of the way rather than fight it for `target`.
    const driven = inst.throttle !== 0 || inst.steer !== 0 || inst.menuOpen || !!inst.repair;
    if (driven) {
      if (s.state !== PAUSED) {
        s.resumeState = s.state;
        s.state = PAUSED;
      }
      s.pauseTimer = RESUME_DELAY;
      // Dropping dispatch is not enough to stop it: the order lives on the
      // instance, and the physics step drives toward `target` whatever this
      // state machine thinks. Manual input already nulls the target itself,
      // and repair drives it on purpose, so only the menu case has to.
      if (inst.menuOpen) {
        inst.target = null;
        inst.forwardSpeed = 0;
        inst.speed = 0;
        inst.accelerating = false;
      }
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
        // Already on the way somewhere when the player picks a field: divert now
        // rather than finishing this run first. Waiting would look like the pick
        // was ignored, which is the whole complaint the one-shot target fixes.
        this._retargetInFlight(inst, s);
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
          this._atDock(inst, s);
        });
      case WAITING_FOR_DOCK:
        return this._waitingForDock(inst, s);
      case UNLOADING:
        return this._unload(inst, s, dt);
      case PARKED:
        return this._parked(inst, s);
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

    // A field the player picked wins over the driver's own judgement, once.
    let field = this._consumeTargetField(inst);
    if (!field) {
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

  /**
   * Divert a harvester already driving to a field onto a newly picked one.
   *
   * `s.field` moves only if the order is actually accepted, so the state machine's
   * idea of where it is going can never disagree with where the vehicle is
   * steering — a refused order leaves the original run untouched.
   */
  _retargetInFlight(inst, s) {
    const field = this._consumeTargetField(inst);
    if (!field || field === s.field) return;
    if (!this._order(inst, s, { x: field.x, z: field.z })) return;
    s.field = field;
    s.waypoint = null;
    s.detours = 0;
    s.stallTimer = 0;
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

    // Tier 0 (unupgraded) leaves the facility's own base rate untouched.
    const unloadMultiplier = facility.def.upgradeTiers?.[facility.upgradeLevel - 1]?.unloadRateMultiplier ?? 1;
    const rate = Math.min(facility.def.unloadRate * unloadMultiplier, inst.def.unloadRate);
    const moved = Math.min(rate * dt, s.load);
    s.load -= moved;
    this.game.earn(moved);

    if (s.load <= 1e-6) {
      s.load = 0;
      // Release dock bay for next harvester
      if (facility.dockedHarvester === inst) {
        facility.dockedHarvester = null;
      }
      // Go to parking bay if shouldPark is set, else idle
      if (inst.shouldPark) {
        s.state = PARKED;
        // Initialize parking position tracking
        if (!facility.parkedHarvesters) facility.parkedHarvesters = [];
        s.parkingBayIndex = facility.parkedHarvesters.length % MAX_QUEUE_POSITIONS;
        facility.parkedHarvesters.push(inst);
      } else {
        s.state = IDLE;
      }
      s.dest = null;
      s.detours = 0;
    }
  }

  _atDock(inst, s) {
    const facility = this._facility();
    if (!facility) {
      s.state = IDLE;
      return;
    }

    // Check if dock is occupied
    if (!facility.dockedHarvester) {
      facility.dockedHarvester = inst;
      s.state = UNLOADING;
    } else {
      s.state = WAITING_FOR_DOCK;
      s.queuePosition = 0;
    }
  }

  _waitingForDock(inst, s) {
    const facility = this._facility();
    if (!facility) {
      s.state = IDLE;
      return;
    }

    // Check if dock is now free
    if (!facility.dockedHarvester) {
      facility.dockedHarvester = inst;
      s.state = UNLOADING;
      return;
    }

    // Park in queue position around facility
    const angle = (s.queuePosition ?? 0) * (Math.PI * 2 / MAX_QUEUE_POSITIONS);
    const queueX = facility.x + Math.cos(angle) * QUEUE_RING;
    const queueZ = facility.z + Math.sin(angle) * QUEUE_RING;

    const pos = inst.group.position;
    const d = Math.hypot(queueX - pos.x, queueZ - pos.z);

    if (d > 1) {
      this._order(inst, s, { x: queueX, z: queueZ });
    }
  }

  _parked(inst, s) {
    // Picking a field is how a parked harvester gets called back to work —
    // otherwise parking is a one-way door and "Target Harvest" looks broken on
    // exactly the harvesters a player is most likely to be giving orders to.
    // Left for _idle to consume, so there is one place that chooses a field.
    if (inst.targetField) {
      inst.shouldPark = false;
      this._leaveParking(inst, s);
      s.state = IDLE;
      s.dest = null;
      return;
    }

    const facility = this._facility();
    if (!facility) {
      s.state = IDLE;
      inst.shouldPark = false;
      this._leaveParking(inst, s);
      return;
    }

    // Calculate parking bay position
    const bayIndex = s.parkingBayIndex ?? 0;
    const angle = bayIndex * (Math.PI * 2 / MAX_QUEUE_POSITIONS);
    const parkX = facility.x + Math.cos(angle) * 28; // parking bay ring at 28 units
    const parkZ = facility.z + Math.sin(angle) * 28;

    const pos = inst.group.position;
    const d = Math.hypot(parkX - pos.x, parkZ - pos.z);

    // Move to parking bay if not already there
    if (d > 1.5) {
      this._order(inst, s, { x: parkX, z: parkZ });
    } else {
      // At parking bay, idle here
      inst.arrive('parked');
    }
  }

  /** Give up a parking bay, so the next harvester to park can claim it. */
  _leaveParking(inst, s) {
    s.parkingBayIndex = undefined;
    for (const f of this.structures.instances) {
      const parked = f.parkedHarvesters;
      if (!parked) continue;
      const i = parked.indexOf(inst);
      if (i !== -1) parked.splice(i, 1);
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
