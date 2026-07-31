/**
 * Drives any vehicle sent to a Repair Bay: queueing for the single dock slot,
 * charging for and timing the repair, and lighting the bay's LED ring in step
 * with progress.
 *
 * Much simpler than harvesterAI's driving loop — no bans, no per-field retry
 * pauses — but it keeps a trimmed version of the same detour idea: a vehicle
 * sent to repair is often exactly the one that's been grinding against a
 * slope (that's how it got damaged), so a straight line back to the bay can
 * easily be blocked. Without some fallback it would just sit there re-issuing
 * the same failing order forever, never arriving.
 *
 * State lives on the vehicle instance as `inst.repair = { bay, state, ... }`,
 * set by the shared Repair command in commands.js and cleared here once the
 * vehicle leaves the bay, one way or another.
 */

const MAX_QUEUE_POSITIONS = 4;
const QUEUE_RING_MARGIN = 10; // world units of clearance past the bay's own pad
// A wide-turning vehicle (a crystal-harvester's turning circle is tens of
// units) can overshoot a tight radius repeatedly without ever settling
// inside it — harvesterAI's own DOCK_DISTANCE (22) exists for the same
// reason. Generous, not exact: this is "close enough to be serviced," not a
// precision stop.
const ARRIVE_RADIUS = 10;
const WAYPOINT_RADIUS = 8;
const DETOUR_ANGLES = [0.6, -0.6, 1.2, -1.2, 1.9, -1.9]; // radians off the direct bearing
const STALL_SPEED = 0.4;
const STALL_TIMEOUT = 1.5; // seconds near-stopped before trying the next detour
const REVERSE_DURATION = 1.5; // seconds backing off before the next detour attempt
// Any non-player vehicle at or below this fraction of health queues for
// repair on its own, without the player having to notice and click Repair.
const AUTO_REPAIR_HEALTH_FRACTION = 0.3;
const READY_LINGER = 2; // seconds the ring stays green before the dock frees

export class RepairController {
  constructor({ vehicles, structures, heightmap, game }) {
    this.vehicles = vehicles;
    this.structures = structures;
    this.heightmap = heightmap;
    this.game = game;
  }

  update(dt) {
    for (const inst of this.vehicles.instances) {
      if (!inst.repair) {
        this._maybeAutoQueue(inst);
        if (!inst.repair) continue;
      }
      const r = inst.repair;

      switch (r.state) {
        case 'to-bay':
          this._toBay(inst, r, dt);
          break;
        case 'queued':
          this._queued(inst, r, dt);
          break;
        case 'entering':
          this._entering(inst, r, dt);
          break;
        case 'repairing':
          this._repairing(inst, r, dt);
          break;
        case 'ready':
          this._ready(inst, r, dt);
          break;
      }
    }
  }

  /**
   * Critically damaged, unattended vehicles queue for repair on their own —
   * "unattended" meaning not the vehicle the player is currently driving,
   * which stays under manual control even if it's hurt.
   */
  _maybeAutoQueue(inst) {
    if (inst === this.vehicles.active) return;
    if (inst.health > inst.def.maxHealth * AUTO_REPAIR_HEALTH_FRACTION) return;
    const bay = this._nearestBay(inst);
    if (bay) inst.repair = { bay, state: 'to-bay' };
  }

  /** Nearest finished repair bay, or null — mirrors commands.js's own lookup. */
  _nearestBay(inst) {
    const pos = inst.group.position;
    let best = null;
    let bestD = Infinity;
    for (const s of this.structures?.instances ?? []) {
      if (s.def.id !== 'repair-bay' || s.mode !== 'idle') continue;
      const d = Math.hypot(s.x - pos.x, s.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** Terrain regenerated: every bay reference is meaningless. */
  reset() {
    for (const inst of this.vehicles.instances) inst.repair = null;
  }

  _toBay(inst, r, dt) {
    const bay = r.bay;
    if (!bay.dock) {
      inst.repair = null; // shouldn't happen — every repair-bay def has a dock
      return;
    }
    if (!this._driveTo(inst, r, bay.dock.x, bay.dock.z, dt)) return;

    if (!bay.dockedVehicle) {
      this._claimDock(inst, r, bay);
    } else {
      r.state = 'queued';
      r.queuePosition = this._claimQueuePosition(bay);
    }
  }

  _queued(inst, r, dt) {
    const bay = r.bay;
    if (!bay.dockedVehicle) {
      this._releaseQueuePosition(bay, r);
      this._claimDock(inst, r, bay);
      return;
    }

    // Same angle convention as the harvester's queue/parking rings and the
    // radial menu: angle = (i / N) * 2π.
    const angle = (r.queuePosition / MAX_QUEUE_POSITIONS) * Math.PI * 2;
    const ringRadius = bay.def.dims.padRadius + QUEUE_RING_MARGIN;
    const qx = bay.x + Math.cos(angle) * ringRadius;
    const qz = bay.z + Math.sin(angle) * ringRadius;
    this._driveTo(inst, r, qx, qz, dt);
  }

  /** Slot claimed — but parking happens on the pad itself, not the approach
   * point, so there's one more short leg (`'entering'`) before repair starts. */
  _claimDock(inst, r, bay) {
    bay.dockedVehicle = inst;
    r.state = 'entering';
    r.waypoint = null;
    r.detours = 0;
    r.stallTimer = 0;
    this._setRingState(bay, 'working');
  }

  _entering(inst, r, dt) {
    const bay = r.bay;
    if (!this._driveTo(inst, r, bay.x, bay.z, dt)) return;
    // _driveTo's arrival radius is deliberately generous (a wide-turning
    // vehicle can't reliably converge on a tight one — see ARRIVE_RADIUS's
    // own comment), so "arrived" alone can still be several units off centre.
    // Snap the last stretch instead of trusting driven precision for it: this
    // is meant to read as parked dead-centre on the pad, not "close enough."
    inst.group.position.x = bay.x;
    inst.group.position.z = bay.z;
    this._startRepairing(inst, r);
  }

  _startRepairing(inst, r) {
    r.state = 'repairing';
    r.elapsed = 0;
    r.cost = null; // computed on the first repairing tick, not at command-click time
  }

  _repairing(inst, r, dt) {
    const bay = r.bay;

    if (r.cost === null) {
      // Cost and duration are struck now, against health as it actually is —
      // more blocked-damage could have accrued while queueing. Duration also
      // reflects the bay's own upgrade tier — tier 0 is the full base rate.
      const missing = inst.def.maxHealth - inst.health;
      const speedMultiplier = bay.def.upgradeTiers?.[bay.upgradeLevel - 1]?.repairSpeedMultiplier ?? 1;
      r.cost = Math.ceil(missing * bay.def.repair.creditsPerHealth);
      r.duration = Math.max(0.1, missing * bay.def.repair.secondsPerHealth * speedMultiplier);
      r.startHealth = inst.health;

      if (!this.game.spend(r.cost)) {
        // Balance moved while queueing — release the bay without repairing.
        this._leaveBay(inst, bay);
        return;
      }
    }

    r.elapsed += dt;
    const progress01 = Math.min(1, r.elapsed / r.duration);
    // Health and the LED ring share one progress value, so the last segment
    // lighting and full health land on the same tick.
    inst.health = r.startHealth + (inst.def.maxHealth - r.startHealth) * progress01;
    this._setLed(bay, progress01);

    if (progress01 >= 1) {
      inst.health = inst.def.maxHealth;
      r.state = 'ready';
      r.readyTimer = 0;
      this._setRingState(bay, 'ready');
    }
  }

  /** Finished, still parked — held briefly so "ready" (green) actually reads
   * before the dock frees up, rather than flashing for zero frames. */
  _ready(inst, r, dt) {
    r.readyTimer += dt;
    if (r.readyTimer >= READY_LINGER) this._leaveBay(inst, r.bay);
  }

  _leaveBay(inst, bay) {
    if (bay.dockedVehicle === inst) bay.dockedVehicle = null;
    this._setLed(bay, 0);
    this._setRingState(bay, 'idle');
    inst.repair = null;
  }

  _setRingState(bay, state) {
    const mat = bay.group.userData.ringMaterial;
    if (!mat) return;
    const colors = bay.def.colors;
    const hex = state === 'working' ? colors.ringWorking : state === 'ready' ? colors.ringReady : colors.accent;
    mat.emissive.set(hex);
  }

  /**
   * Real per-waiter allocation rather than the harvester queue's own bug (a
   * hardcoded position that every waiter aims at) — indices are claimed and
   * released against a small set stashed on the bay instance.
   */
  _claimQueuePosition(bay) {
    const taken = bay._repairQueue ?? (bay._repairQueue = new Set());
    for (let i = 0; i < MAX_QUEUE_POSITIONS; i++) {
      if (!taken.has(i)) {
        taken.add(i);
        return i;
      }
    }
    return 0; // queue is full — a brief overlap that resolves as it drains
  }

  _releaseQueuePosition(bay, r) {
    bay._repairQueue?.delete(r.queuePosition);
    r.queuePosition = null;
  }

  _setLed(bay, progress01) {
    const cells = bay.group.userData.ledCells;
    if (!cells) return;
    const lit = Math.ceil(progress01 * cells.length);
    for (let i = 0; i < cells.length; i++) {
      cells[i].emissiveIntensity = i < lit ? 2.4 : 0;
    }
  }

  /**
   * Drive toward (x, z), working around blocked terrain along the way.
   * @returns {boolean} true once arrived at the real destination.
   */
  _driveTo(inst, r, x, z, dt) {
    // Undefined on a leg's very first call (nothing initializes it up front) —
    // without this, `r.detours === 0` compares against undefined and silently
    // skips straight past both the straight-line and detour attempts below.
    r.detours ??= 0;

    const pos = inst.group.position;

    if (Math.hypot(x - pos.x, z - pos.z) <= ARRIVE_RADIUS) {
      inst.arrive('reached');
      r.waypoint = null;
      r.detours = 0;
      r.stallTimer = 0;
      return true;
    }

    // Reached a detour waypoint: drop it and aim at the real destination again.
    if (r.waypoint) {
      if (Math.hypot(r.waypoint.x - pos.x, r.waypoint.z - pos.z) <= WAYPOINT_RADIUS) {
        r.waypoint = null;
        r.detours = 0;
        inst.setTarget(x, z, this.heightmap);
      }
      return false;
    }

    if (!inst.hasOrder) {
      // The direct line just failed (or this is the first tick for this leg).
      // Try it once; once that itself keeps failing, start trying waypoints
      // off to the side, the same idea as harvesterAI's own detour system,
      // trimmed down — no bans, no field-specific retry pause.
      if (r.detours === 0) {
        if (inst.setTarget(x, z, this.heightmap)) return false;
        r.detours = 1;
      }
      if (r.detours <= DETOUR_ANGLES.length) {
        const bearing = Math.atan2(z - pos.z, x - pos.x) + DETOUR_ANGLES[r.detours - 1];
        r.detours++;
        const range = Math.min(30, Math.max(10, Math.hypot(x - pos.x, z - pos.z) * 0.5));
        const wx = pos.x + Math.cos(bearing) * range;
        const wz = pos.z + Math.sin(bearing) * range;
        if (this.heightmap.heightAt(wx, wz) > this.heightmap.seaLevelY + 1) {
          r.waypoint = { x: wx, z: wz };
          inst.setTarget(wx, wz, this.heightmap);
        }
        return false;
      }
      // Every angle failed — genuinely unreachable from here. Hand the vehicle
      // back rather than leaving `inst.repair` stuck forever with no way for
      // the player to retry (the Repair command stays disabled while it's
      // set), and release any queue slot it was holding on to.
      if (r.queuePosition != null) this._releaseQueuePosition(r.bay, r);
      inst.repair = null;
      return false;
    }

    // Under way with a live order: only a genuine stall (near-zero speed while
    // still supposedly driving) counts as stuck — abandon it and let the next
    // tick's `!inst.hasOrder` branch try a fresh angle. Back off first: a
    // vehicle already touching whatever stalled it often can't clear by
    // turning alone.
    r.stallTimer = inst.speed < STALL_SPEED ? (r.stallTimer ?? 0) + dt : 0;
    if (r.stallTimer > STALL_TIMEOUT) {
      r.stallTimer = 0;
      inst.arrive('cancelled');
      if (inst.reverseTimer == null) inst.beginReverse(REVERSE_DURATION);
    }
    return false;
  }
}
