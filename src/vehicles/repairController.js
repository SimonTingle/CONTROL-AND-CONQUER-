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
import { CLEARED } from './facilityControl.js';

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
// Speed-blind failure: circling the destination at the alignment floor is fast
// enough to never look stalled. See _driveTo's progress check.
const NO_PROGRESS_TIMEOUT = 6; // seconds without getting closer
const PROGRESS_EPSILON = 0.5; // world units that count as "closer"
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
  constructor({ vehicles, structures, heightmap, game, facilityControl }) {
    this.vehicles = vehicles;
    this.structures = structures;
    this.heightmap = heightmap;
    this.game = game;
    // Shared with harvesterAI: one ground controller for every dock, instead
    // of this file and that one each keeping their own claim + allocator +
    // sweep and fixing the same bugs out of step.
    this.facilityControl = facilityControl;
  }

  update(dt) {
    for (const inst of this.vehicles.instances) {
      // Dead but not yet flushed — see harvesterAI's matching guard. Healing a
      // corpse would re-create the repair state its onDestroy hook just
      // cleared, and hand a dock back to something that no longer exists.
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
    // Harvesters run their own repair retreat in harvesterAI, at a higher health
    // threshold and using its stronger detour/reverse escape to reach the bay.
    // Letting this generic auto-queue also grab them is what produced the
    // wedge/flip-flop: it set inst.repair, harvesterAI paused its own escape,
    // and this controller's weaker drive couldn't free a pinned harvester. Once
    // harvesterAI hands off (sets inst.repair itself), the servicing loop below
    // still runs for them — only the *initiation* is suppressed here.
    if (inst.def.capacity) return;
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
    // Bays survive unless structures.clear() also ran. Nothing to un-reserve:
    // the claim lived on the vehicle and has just been dropped. Only the
    // visuals need resetting.
    for (const s of this.structures?.instances ?? []) {
      if (s.def.id !== 'repair-bay') continue;
      this._setLed(s, 0);
      this._setRingState(s, 'idle');
    }
  }

  _toBay(inst, r, dt) {
    const bay = r.bay;
    if (!bay.dock) {
      inst.repair = null; // shouldn't happen — every repair-bay def has a dock
      return;
    }
    // Permission first, then drive. The old order was the other way round —
    // every damaged vehicle converged on the identical `bay.dock` point and
    // only discovered the contention on touchdown, which is exactly the
    // pile-up harvesterAI's own TO_BASE divert already avoided on its side.
    if (this.facilityControl.inTerminalArea(inst, bay)) {
      this.facilityControl.request(inst, bay, 'repair');
      if (!this.facilityControl.isCleared(inst)) {
        r.state = 'queued';
        r.claimedOrder = false; // new leg, new destination — re-take the wheel
        return;
      }
    }

    if (!this._driveTo(inst, r, bay.dock.x, bay.dock.z, dt)) return;
    this._claimDock(inst, r, bay);
  }

  _queued(inst, r, dt) {
    const bay = r.bay;
    this.facilityControl.request(inst, bay, 'repair');
    if (this.facilityControl.statusOf(inst) === CLEARED) {
      r.queuedFor = 0;
      r.state = 'to-bay';
      r.claimedOrder = false; // new leg (the dock itself) — re-take the wheel
      return;
    }

    // A backstop for a queue that outlives any plausible repair. The
    // controller's own lease already reclaims a *dock* nobody reaches; this
    // only catches a vehicle that has been waiting far longer than a full
    // repair could take, and gives up rather than waiting out the match.
    r.queuedFor = (r.queuedFor ?? 0) + dt;
    if (r.queuedFor > QUEUE_TIMEOUT) {
      this.facilityControl.release(inst);
      inst.repair = null;
      return;
    }

    const fix = this.facilityControl.holdingFix(inst, bay);
    if (fix) this._driveTo(inst, r, fix.x, fix.z, dt);
  }

  /** Slot claimed — but parking happens on the pad itself, not the approach
   * point, so there's one more short leg (`'entering'`) before repair starts. */
  _claimDock(inst, r, bay) {
    this.facilityControl.markDocked(inst);
    r.state = 'entering';
    r.waypoint = null;
    r.detours = 0;
    r.stallTimer = 0;
    r.claimedOrder = false; // new leg (the pad itself) — re-take the wheel
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
    this.facilityControl.release(inst);
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
   * Two directions. A vehicle dying releases whatever dock/queue claim it
   * held on its bay — no longer needed, since `facilityControl` rebuilds its
   * index from the live fleet and a destroyed vehicle is simply absent from
   * it. A repair bay dying still needs handling here: unlike harvesterAI's
   * facility lookup, `_toBay`/`_queued`/`_repairing` hold a direct `r.bay`
   * reference rather than re-resolving one each tick, so nothing else would
   * notice the bay is gone and a vehicle could sit forever "repairing" at a
   * structure that no longer exists.
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

    // Take the wheel before anything else on a leg's first tick.
    //
    // Every branch below that issues an order is gated behind `!inst.hasOrder`,
    // and `hasOrder` is just "target !== null" — it cannot tell *our* order
    // from one the vehicle was already carrying. So a vehicle sent to repair
    // while it still held a live order (a harvester mid-run, a scout the player
    // had clicked somewhere, anything) would never be re-targeted: this
    // controller would sit watching for stalls while the vehicle drove happily
    // to somewhere else entirely, `inst.repair` never clearing, and the Repair
    // command stuck reporting "Already repairing" forever. A real save showed
    // exactly that — a harvester with repair state 'to-bay' driving full speed
    // at a crystal field on the opposite side of its bay.
    //
    // Cancelling the stale order here makes the `!inst.hasOrder` branch below
    // fire on that same tick, so this controller always issues its own.
    if (!r.claimedOrder) {
      r.claimedOrder = true;
      if (inst.hasOrder) inst.arrive('cancelled');
    }

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
      // this can happen during 'entering', after _claimDock already took the
      // dock, and clearing repair without giving the clearance up would leave
      // the bay held by a vehicle that has stopped trying to reach it. Safe on
      // the 'to-bay'/'queued' legs too — releasing a clearance you only held
      // as a waiter just drops you out of the queue.
      this._leaveBay(inst, r.bay);
      // Hold off re-queuing for a beat. Without this, a vehicle that genuinely
      // can't reach its nearest bay clears repair here, immediately re-qualifies
      // in _maybeAutoQueue next tick, claims again, fails to path again — a
      // per-frame claim/bail loop that strobes the bay ring. (Harvesters no
      // longer reach this path, but scouts still auto-queue.)
      inst._autoRepairCooldown = AUTO_REPAIR_RETRY_COOLDOWN;
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
      r.bestDistance = null;
      r.noProgressTimer = 0;
      return false;
    }

    // Moving, but getting no closer — the same blind spot harvesterAI's own
    // _travel covers: a vehicle circling its destination at the alignment floor
    // is well above STALL_SPEED and so never registers as stalled, even though
    // it will orbit forever. Measure progress instead of speed.
    const d = Math.hypot(x - pos.x, z - pos.z);
    if (holding) {
      r.noProgressTimer = 0;
    } else if (r.bestDistance == null || d < r.bestDistance - PROGRESS_EPSILON) {
      r.bestDistance = d;
      r.noProgressTimer = 0;
    } else {
      r.noProgressTimer = (r.noProgressTimer ?? 0) + dt;
      if (r.noProgressTimer > NO_PROGRESS_TIMEOUT) {
        r.noProgressTimer = 0;
        r.bestDistance = null;
        inst.arrive('cancelled');
        if (inst.reverseTimer == null && !hasVehicleBehind(inst, this.vehicles.instances)) {
          inst.beginReverse(REVERSE_DURATION);
        }
        r.detours = (r.detours ?? 0) + 1;
      }
    }
    return false;
  }
}
