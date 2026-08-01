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

import { hasVehicleBehind } from './trafficController.js';

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
const AUTO_REPAIR_RETRY_COOLDOWN = 5; // seconds between affordability re-checks
const READY_LINGER = 2; // seconds the ring stays green before the dock frees
// A backstop, not a normal-operation ceiling — a full repair at tier 0 can
// legitimately take several minutes, and a queued vehicle waits out whatever
// is ahead of it. This only exists to reclaim a queue that's stuck for a
// reason the self-heal sweep didn't catch.
const QUEUE_TIMEOUT = 600;

export class RepairController {
  constructor({ vehicles, structures, heightmap, game }) {
    this.vehicles = vehicles;
    this.structures = structures;
    this.heightmap = heightmap;
    this.game = game;
  }

  update(dt) {
    this._sweepBays();
    for (const inst of this.vehicles.instances) {
      // Dead but not yet flushed — see harvesterAI's matching guard. Healing a
      // corpse would also re-claim the bay its onDestroy hook just released.
      if (inst.dead) continue;
      if (!inst.repair) {
        this._maybeAutoQueue(inst, dt);
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
   *
   * Only actually queues if the repair is affordable right now — otherwise it
   * keeps working and rechecks every AUTO_REPAIR_RETRY_COOLDOWN seconds,
   * rather than claiming a bay, immediately failing game.spend() in
   * _repairing, bailing back out via _leaveBay, and re-triggering this exact
   * check next tick — a claim/fail/release cycle every single frame that
   * flips the bay's ring gold/idle each frame and never lets the player see
   * or interrupt it.
   */
  _maybeAutoQueue(inst, dt) {
    if (inst === this.vehicles.active) return;
    if (inst.health > inst.def.maxHealth * AUTO_REPAIR_HEALTH_FRACTION) {
      inst._autoRepairCooldown = 0; // healthy again — re-check instantly if it dips later
      return;
    }
    if (inst._autoRepairCooldown > 0) {
      inst._autoRepairCooldown -= dt;
      return;
    }

    const bay = this._nearestBay(inst);
    const missing = bay ? inst.def.maxHealth - inst.health : 0;
    const cost = bay ? Math.ceil(missing * bay.def.repair.creditsPerHealth) : Infinity;
    if (!bay || this.game.teamOf(inst).credits < cost) {
      inst._autoRepairCooldown = AUTO_REPAIR_RETRY_COOLDOWN;
      return;
    }
    inst.repair = { bay, state: 'to-bay' };
  }

  /** Nearest finished repair bay, or null — mirrors commands.js's own lookup. */
  _nearestBay(inst) {
    const pos = inst.group.position;
    let best = null;
    let bestD = Infinity;
    for (const s of this.structures?.instances ?? []) {
      if (s.def.id !== 'repair-bay' || s.mode !== 'idle') continue;
      if (s.teamId !== inst.teamId) continue; // never queue at an enemy bay
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
    // Vehicle-side state is gone, but the bays themselves survive unless
    // structures.clear() also ran — leaving a dock/queue reservation behind
    // would orphan it exactly like the bugs this sweep exists to catch.
    for (const s of this.structures?.instances ?? []) {
      if (s.def.id !== 'repair-bay') continue;
      s.dockedVehicle = null;
      s._repairQueue = undefined;
      this._setLed(s, 0);
      this._setRingState(s, 'idle');
    }
  }

  /**
   * Validates every bay's dock reservation each tick: if `dockedVehicle`
   * points at a vehicle whose own repair state no longer agrees it's docked
   * there — pause, park, a give-up that didn't route through `_leaveBay`,
   * anything — release it. This is what recovers a game that's already
   * broken, not just what prevents it breaking again.
   */
  _sweepBays() {
    for (const s of this.structures?.instances ?? []) {
      if (s.def.id !== 'repair-bay' || !s.dockedVehicle) continue;
      if (s.dockedVehicle.repair?.bay !== s) {
        s.dockedVehicle = null;
        this._setLed(s, 0);
        this._setRingState(s, 'idle');
      }
    }
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
      r.queuedFor = 0;
      this._claimDock(inst, r, bay);
      return;
    }

    // A backstop against a dock that's stuck for a reason the sweep didn't
    // catch — see QUEUE_TIMEOUT's own comment. Not the normal way to leave
    // the queue; `!bay.dockedVehicle` above is.
    r.queuedFor = (r.queuedFor ?? 0) + dt;
    if (r.queuedFor > QUEUE_TIMEOUT) {
      this._releaseQueuePosition(bay, r);
      inst.repair = null;
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
    // Fractional credits owed but not yet billed — see _repairing. Nothing is
    // struck up front any more: cost accrues with the health actually applied.
    r.owed = 0;
  }

  /**
   * Heals at a rate, and pays as it goes.
   *
   * This used to precompute a duration and lerp health from a frozen
   * `startHealth`, which was fine when nothing could hurt a parked vehicle:
   * once weapons existed it meant a unit being shot inside a bay had its
   * damage *overwritten* every tick by the lerp — effectively invulnerable
   * while docked. A rate only ever adds, so incoming damage now competes with
   * the repair instead of being erased by it.
   *
   * Charging per tick rather than up front closes the matching hole on the
   * economy side: a vehicle destroyed halfway through no longer takes a full
   * repair's credits with it, and a repair interrupted for any other reason
   * costs exactly what it delivered.
   */
  _repairing(inst, r, dt) {
    const bay = r.bay;

    const speedMultiplier = bay.def.upgradeTiers?.[bay.upgradeLevel - 1]?.repairSpeedMultiplier ?? 1;
    // secondsPerHealth is the tier-0 pace; a better bay divides it down.
    const healthPerSecond = 1 / Math.max(1e-3, bay.def.repair.secondsPerHealth * speedMultiplier);
    const wanted = Math.min(healthPerSecond * dt, inst.def.maxHealth - inst.health);
    if (wanted <= 0) {
      this._finishRepair(inst, r, bay);
      return;
    }

    // Pay for exactly the health about to be applied. Fractional credit debt
    // carries between ticks rather than rounding up every frame, which at 60fps
    // would overcharge by orders of magnitude.
    const team = this.game.teamOf(inst);
    r.owed = (r.owed ?? 0) + wanted * bay.def.repair.creditsPerHealth;
    const due = Math.floor(r.owed);
    if (due > 0) {
      if (!team.spend(due)) {
        // Ran dry mid-repair: stop where it got to, keep what it already paid
        // for. Not a failure state — the vehicle leaves partially repaired and
        // can come back once the economy recovers.
        this._leaveBay(inst, bay);
        return;
      }
      r.owed -= due;
    }

    inst.health += wanted;
    this._setLed(bay, inst.health / inst.def.maxHealth);

    if (inst.health >= inst.def.maxHealth) this._finishRepair(inst, r, bay);
  }

  _finishRepair(inst, r, bay) {
    inst.health = inst.def.maxHealth;
    r.state = 'ready';
    r.readyTimer = 0;
    this._setRingState(bay, 'ready');
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
    // Search well past MAX_QUEUE_POSITIONS rather than returning a fixed
    // fallback like 0 once the ring's own slots are full — a repeat index
    // would double-allocate a slot another vehicle still holds, so releasing
    // one frees the other's too and a third claimer collides with it. Beyond
    // MAX_QUEUE_POSITIONS the ring angle wraps and visually overlaps an
    // earlier vehicle, which only matters once 5+ are queued at once — the
    // bookkeeping staying unique matters far more than the ring staying
    // evenly spaced in that edge case.
    for (let i = 0; i < 64; i++) {
      if (!taken.has(i)) {
        taken.add(i);
        return i;
      }
    }
    return -1; // 64 concurrent queuers at one bay — not a realistic fleet size
  }

  _releaseQueuePosition(bay, r) {
    bay._repairQueue?.delete(r.queuePosition);
    r.queuePosition = null;
  }

  /**
   * Two directions. A vehicle dying releases whatever dock/queue claim it
   * held on its bay. A repair bay dying releases every vehicle that was
   * using it — unlike harvesterAI's facility lookup, `_toBay`/`_queued`/
   * `_repairing` hold a direct `r.bay` reference rather than re-resolving one
   * each tick, so nothing else would ever notice the bay is gone and a
   * vehicle could sit forever "repairing" at a structure that no longer
   * exists.
   */
  onDestroy(inst) {
    if (inst.kind === 'structure') {
      if (inst.def.id !== 'repair-bay') return;
      for (const v of this.vehicles.instances) {
        if (v.repair?.bay === inst) v.repair = null;
      }
      return;
    }
    const r = inst.repair;
    if (!r) return;
    if (r.queuePosition != null) this._releaseQueuePosition(r.bay, r);
    this._leaveBay(inst, r.bay);
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
      //
      // Routed through _leaveBay rather than clearing `inst.repair` directly:
      // this can happen during 'entering', after _claimDock already reserved
      // the dock — clearing repair without also releasing `bay.dockedVehicle`
      // orphans it forever, since nothing else can ever set it back to null,
      // and _queued's only exit is that field going falsy. _leaveBay's own
      // `dockedVehicle === inst` check makes it a safe no-op for the
      // 'to-bay'/'queued' legs, where the dock was never claimed.
      if (r.queuePosition != null) this._releaseQueuePosition(r.bay, r);
      this._leaveBay(inst, r.bay);
      return false;
    }

    // Under way with a live order: only a genuine stall (near-zero speed while
    // still supposedly driving) counts as stuck — abandon it and let the next
    // tick's `!inst.hasOrder` branch try a fresh angle. Back off first: a
    // vehicle already touching whatever stalled it often can't clear by
    // turning alone.
    //
    // Yielding on purpose or already reversing isn't a stall — counting it as
    // one misreads a polite wait as a blockage.
    const holding = inst.yielding || inst.reverseTimer != null;
    r.stallTimer = !holding && inst.speed < STALL_SPEED ? (r.stallTimer ?? 0) + dt : 0;
    if (r.stallTimer > STALL_TIMEOUT) {
      r.stallTimer = 0;
      inst.arrive('cancelled');
      if (inst.reverseTimer == null && !hasVehicleBehind(inst, this.vehicles.instances)) {
        inst.beginReverse(REVERSE_DURATION);
      }
      // Without this, the very next tick's `!inst.hasOrder` branch re-targets
      // the same straight line via the `r.detours === 0` path, which usually
      // *succeeds* (setTarget only fails underwater/immobile) — so `detours`
      // never climbs and the out-of-detours give-up below is unreachable.
      // A stall-triggered abandon counts as one used detour.
      r.detours = (r.detours ?? 0) + 1;
    }
    return false;
  }
}
