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

import { hasVehicleBehind } from './trafficController.js';
import { CLEARED, DOCKED } from './facilityControl.js';
// Simulated time, never wall clock: field bans and threat memory are
// simulation state, so they have to advance with the sim (including under
// __step's fast-forward) and tick identically on every machine.
import { simClock } from '../core/simClock.js';

const IDLE = 'idle';
const TO_FIELD = 'to-field';
const FILLING = 'filling';
const TO_BASE = 'to-base';
const WAITING_FOR_DOCK = 'waiting-for-dock';
const UNLOADING = 'unloading';
const PARKED = 'parked';
const PAUSED = 'paused';
const FLEEING = 'fleeing';
// Driving itself to a repair bay, under harvesterAI's own (strong) escape
// logic, then handing off to repairController for the dock+heal.
const TO_REPAIR = 'to-repair';
const REPAIRING = 'repairing';

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
// Progress, rather than speed, is what catches a vehicle circling its own
// destination at the alignment floor — see _travel. Generous on purpose: a
// legitimately wide arc round an obstacle, or a slow climb, can hold distance
// for a few seconds without being stuck.
const NO_PROGRESS_TIMEOUT = 6; // seconds without getting closer
const PROGRESS_EPSILON = 0.5; // world units that count as "closer"
// How long a mechanical hold (yielding to traffic, or mid-reverse) may go on
// suppressing the stall and no-progress escapes before it stops counting as
// deliberate. Comfortably longer than a real three-point turn — several
// reverse-and-forward cycles — so an honest manoeuvre is never cut short, and
// far shorter than the freezes this exists to end. See _travel.
const HOLD_GRACE = 10; // seconds
const RETRY_PAUSE = 1.5;
const REVERSE_DURATION = 1.5; // seconds backing off before trying the next detour angle
const BAN_SECONDS = 45;
// How far a cornered harvester runs when it has no facility to run to.
const FLEE_DISTANCE = 90;
const TRANSFER_SPEED = 0.5; // must be near enough stopped to load or unload

// A fresh automatic pick prefers to leave a nearly-drained field alone and to
// spread out rather than pile onto one — both soft: see _idle()'s fallback.
const LOW_STOCK_FRACTION = 0.33;
const MAX_HARVESTERS_PER_FIELD = 2;

// Health at or below which a harvester abandons its run and drives itself to a
// repair bay. Deliberately well above repairController's last-ditch 0.30
// auto-queue: retreating at half health leaves the headroom to actually reach
// the bay before terrain-grind damage pins it — the wedge this fixes happens
// precisely because the old flow only reacted once the harvester was already
// near death and, often, already stuck.
const REPAIR_RETREAT_FRACTION = 0.5;
// After a repair ends with the harvester still hurt (ran dry, or the bay was
// unreachable), wait this long before trying again rather than looping straight
// back — it keeps harvesting in the meantime instead of freezing.
const REPAIR_RETRY_COOLDOWN = 8;

/** Widening, alternating. A straight retry cannot work: the heading is unchanged. */
const DETOUR_ANGLES = [0.9, -0.9, 1.6, -1.6, 2.4];
// Angles at or past this offset from the direct bearing point behind the
// vehicle rather than around the obstacle. A wheeled vehicle has no way to
// reach one except by reversing into it; a tracked vehicle can pivot to face
// any bearing without moving at all (see vehicleController.js's tracked
// sharp-turn branch), so there is no reason to ever send it toward one.
const TRACKED_DETOUR_LIMIT = Math.PI / 2;
/**
 * Holding-fix arrival tolerance. The fix itself, and the ring it sits on, are
 * `facilityControl`'s business now — a waiter only needs to get near enough to
 * be out of the way, not to hit a precise point.
 */
const HOLD_ARRIVE_RADIUS = 12;
/** Parking bays only. The queue ring moved to facilityControl. */
const MAX_PARKING_BAYS = 4;
/**
 * Consecutive fully-exhausted detour sweeps at the same destination before a
 * harvester stops re-running the identical failing plan. See `_onAbandoned`.
 */
const ABANDON_ESCALATION = 2;

export class HarvesterAI {
  constructor({ vehicles, world, heightmap, structures, game, facilityControl }) {
    this.vehicles = vehicles;
    this.world = world;
    this.heightmap = heightmap;
    this.structures = structures;
    this.game = game;
    // Who is allowed to approach the dock, and where everyone else holds.
    // Owns what `dockedHarvester` + `_haulQueue` + `_sweepFacilities` used to.
    this.facilityControl = facilityControl;
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
      // Dead but not yet flushed: it stays in this array until the tick's
      // single destroy flush, and driving a corpse for those few systems'
      // worth of ticks would re-create the state its onDestroy hook just
      // cleared.
      if (inst.dead) continue;
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
        // Repair retreat (see _maybeRetreatForRepair). repairBay is a live
        // structure ref while in TO_REPAIR.
        repairBay: null,
        repairRetryCooldown: 0,
        // Progress tracking (see _travel): the closest this leg has come to its
        // destination, how long it has failed to beat that, and which leg the
        // pair belongs to.
        progressLeg: null,
        bestDistance: null,
        noProgressTimer: 0,
        // Consecutive exhausted detour sweeps at one destination — see _onAbandoned.
        abandonSweeps: 0,
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
        s.resumeState = this._safeResumeState(inst, s);
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

    // Under fire. Checked after the manual-control gate above (the player
    // driving still wins) but before the retry brake below, because a
    // harvester should not stand still waiting out a retry pause while
    // something shoots it.
    //
    // Deliberately *not* while docked: leaving UNLOADING here would strand
    // `facility.dockedHarvester` — the reservation is only ever released
    // through _releaseDock, and a state change that skips it orphans the dock
    // until the self-heal sweep notices. Finishing an unload takes a moment;
    // corrupting the facility lasts until something catches it.
    if (inst.threatUntil != null) {
      if (simClock.time < inst.threatUntil) {
        if (s.state !== FLEEING && s.state !== UNLOADING && s.state !== WAITING_FOR_DOCK) {
          s.resumeState = this._safeResumeState(inst, s);
          s.state = FLEEING;
          s.dest = null;
          s.waypoint = null;
          s.detours = 0;
        }
      } else {
        inst.threatUntil = null;
        if (s.state === FLEEING) {
          // Home is where it was already heading anyway — resume the run
          // rather than idling and re-deciding from scratch.
          s.state = s.load > 0 ? TO_BASE : IDLE;
          s.dest = null;
          s.waypoint = null;
        }
      }
    }

    if (s.retryTimer > 0) {
      s.retryTimer -= dt;
      return;
    }

    // Damaged enough to break off and get repaired? Checked from the ordinary
    // working states only — not while fleeing (staying alive wins), mid-dock,
    // or already on a repair run. Owning this here rather than letting
    // repairController's generic auto-queue grab the harvester keeps this file's
    // stronger detour/reverse escape engaged the whole way to the bay.
    if (s.state === IDLE || s.state === TO_FIELD || s.state === FILLING || s.state === TO_BASE) {
      if (this._maybeRetreatForRepair(inst, s, dt)) return;
    }

    switch (s.state) {
      case FLEEING:
        return this._flee(inst, s, dt);
      case IDLE:
        return this._idle(inst, s);
      case TO_REPAIR:
        // Drive to the bay under our own escape logic; hand off on arrival.
        return this._travel(inst, s, dt, DOCK_DISTANCE, () => this._arriveAtRepair(inst, s));
      case REPAIRING:
        return this._repairingWait(inst, s);
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
      case TO_BASE: {
        // Permission before approach, re-checked every tick rather than only on
        // arrival: a harvester converging on a dock another one is already
        // using gets physically blocked well short of DOCK_DISTANCE, in the
        // contested approach corridor rather than yielding to moving traffic —
        // `holding` in _travel only covers the latter, so without this the
        // no-progress timer (correctly) escalates it as stuck instead.
        const facility = this._facility(inst);
        if (
          facility &&
          this.facilityControl.inTerminalArea(inst, facility) &&
          !this.facilityControl.isCleared(inst)
        ) {
          this.facilityControl.request(inst, facility);
          s.state = WAITING_FOR_DOCK;
          s.dest = null;
          s.waypoint = null;
          s.detours = 0;
          s.stallTimer = 0;
          return;
        }
        return this._travel(inst, s, dt, DOCK_DISTANCE, () => {
          this._atDock(inst, s);
        });
      }
      case WAITING_FOR_DOCK:
        return this._waitingForDock(inst, s, dt);
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
    const now = simClock.time;

    if (s.load >= inst.def.capacity * 0.98) {
      s.state = TO_BASE;
      s.dest = null;
      return;
    }

    // A field the player picked wins over the driver's own judgement, once.
    let field = this._consumeTargetField(inst);
    if (!field) {
      // Prefer an untouched field over one already being worked, even a
      // lightly worked one under the crowd cap. Two harvesters filling the
      // same field at once draw far faster than any field regenerates
      // (fillRate 48/s each against a regen ceiling of 6/s), and the
      // low-stock check below only gates *new* assignments — a field already
      // being drained keeps getting drained past it. Left to plain nearest,
      // an AI's fixed two-harvester economy routinely converges both onto
      // the same field and stalls its own income for tens of seconds while
      // that field claws back from empty. See docs/plans/ai-commander-overhaul.md.
      field = this.world.blooms.nearestTo(inst.group.position.x, inst.group.position.z, {
        minStock: 1,
        reject: (f) =>
          (s.bans.get(f.id) ?? 0) > now ||
          f.blockedByTeam?.has(inst.teamId) ||
          this._isFieldCrowdedOrLow(f, inst) ||
          this._countHarvestersOnField(f, inst) > 0,
      });
      if (!field) {
        // No untouched field reachable — sharing one that isn't yet crowded
        // or low is still better than idling.
        field = this.world.blooms.nearestTo(inst.group.position.x, inst.group.position.z, {
          minStock: 1,
          reject: (f) =>
            (s.bans.get(f.id) ?? 0) > now ||
            f.blockedByTeam?.has(inst.teamId) ||
            this._isFieldCrowdedOrLow(f, inst),
        });
      }
      if (!field) {
        field = this.world.blooms.nearestTo(inst.group.position.x, inst.group.position.z, {
          minStock: 1,
          // Note this last, most permissive tier still respects a block — a
          // player-blocked field is never "share anything reachable" either;
          // only the temporary per-harvester `bans` are given up on here.
          reject: (f) => (s.bans.get(f.id) ?? 0) > now || f.blockedByTeam?.has(inst.teamId),
        });
      }
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
      s.bans.set(s.field?.id ?? -1, simClock.time + BAN_SECONDS);
      s.state = s.load > 0 ? TO_BASE : IDLE;
      s.dest = null;
      return;
    }
    s.state = FILLING;
  }

  _fill(inst, s, dt) {
    // Normally resolves itself within a frame or two of arriving (arrive()
    // already zeroed speed) — this is just letting genuine rolling residue
    // settle. If a bump or a slope keeps it above threshold well past that,
    // stop waiting on it: force the stop rather than filling from wherever it
    // happens to be drifting.
    if (inst.speed > TRANSFER_SPEED) {
      s.fillWaitTimer = (s.fillWaitTimer ?? 0) + dt;
      if (s.fillWaitTimer < 2) return;
      inst.forwardSpeed = 0;
      inst.speed = 0;
    }
    s.fillWaitTimer = 0;

    // Drifted off the field entirely (pushed by traffic, slid downhill) —
    // this isn't "rolling to a stop" anymore, it's somewhere else. Go back to
    // properly approaching it instead of harvesting from a distance.
    if (s.field) {
      const pos = inst.group.position;
      const d = Math.hypot(pos.x - s.field.x, pos.z - s.field.z);
      if (d > (s.field.radius ?? 12) + 20) {
        s.state = TO_FIELD;
        s.dest = null;
        return;
      }
    }

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
      s.bans.set(s.field.id, simClock.time + BAN_SECONDS);
      s.state = IDLE;
    }
  }

  _unload(inst, s, dt) {
    // Same "let it settle, but not forever" shape as _fill — see its comment.
    if (inst.speed > TRANSFER_SPEED) {
      s.unloadWaitTimer = (s.unloadWaitTimer ?? 0) + dt;
      if (s.unloadWaitTimer < 2) return;
      inst.forwardSpeed = 0;
      inst.speed = 0;
    }
    s.unloadWaitTimer = 0;

    const facility = this._facility(inst);
    if (!facility) {
      s.state = IDLE;
      return;
    }

    // Drifted off the dock (bumped, slid down a grade) — holding the lock
    // from out here isn't doing anyone any good. Give it up and re-approach
    // properly instead of "unloading" from wherever it ended up.
    //
    // Measured against the *dock*, which is the same point `_destination`
    // defines arrival against — not the building centre. Those are 12 units
    // apart (`dockOffset`), and measuring arrival from one while releasing
    // from the other opened a dead band: at 22 from the dock a harvester can
    // be up to 34 from the centre, so anything landing in (33, 34] was both
    // "arrived" and "drifted" on the same tick. It then cycled
    // arrive → _atDock → UNLOADING → release → TO_BASE → arrive, forever,
    // never issuing an order (so no stall or no-progress timer ever ran) and
    // never unloading. A real 44-minute match had one team on 0 credits with
    // its only harvester frozen there, full, 92 units of odometer to its name.
    // Same reference point on both sides makes the overlap arithmetically
    // impossible rather than merely narrow.
    const dock = facility.dock ?? facility;
    const pos = inst.group.position;
    if (Math.hypot(pos.x - dock.x, pos.z - dock.z) > DOCK_DISTANCE * 1.5) {
      this._releaseDock(facility, inst);
      s.state = TO_BASE;
      s.dest = null;
      return;
    }

    // Tier 0 (unupgraded) leaves the facility's own base rate untouched.
    const unloadMultiplier = facility.def.upgradeTiers?.[facility.upgradeLevel - 1]?.unloadRateMultiplier ?? 1;
    const rate = Math.min(facility.def.unloadRate * unloadMultiplier, inst.def.unloadRate);
    const moved = Math.min(rate * dt, s.load);
    s.load -= moved;
    // Credited to the harvester's own team. `_facility()` only ever returns a
    // same-team facility, so the two can never disagree.
    const team = this.game.teamOf(inst);
    team.earn(moved);
    // Lifetime tally on the instance (not the states Map) so the vehicle picker
    // and snapshot both read it without reaching into harvesterAI internals.
    inst.creditsDelivered += moved;
    // And the team-wide harvest total, which earn() above deliberately does not
    // give us: stats.creditsEarned also counts sell refunds and AI build
    // refunds, so it is not an answer to "how much did this economy produce".
    // Tallied here rather than summed from live harvesters later, so a
    // harvester's contribution outlives the harvester.
    team.stats.harvesterEarningsTotal += moved;

    if (s.load <= 1e-6) {
      s.load = 0;
      this._releaseDock(facility, inst);
      // Go to parking bay if shouldPark is set, else idle
      if (inst.shouldPark) {
        s.state = PARKED;
        // Initialize parking position tracking
        if (!facility.parkedHarvesters) facility.parkedHarvesters = [];
        s.parkingBayIndex = facility.parkedHarvesters.length % MAX_PARKING_BAYS;
        facility.parkedHarvesters.push(inst);
      } else {
        s.state = IDLE;
      }
      s.dest = null;
      s.detours = 0;
    }
  }

  _atDock(inst, s) {
    const facility = this._facility(inst);
    if (!facility) {
      s.state = IDLE;
      return;
    }

    // Arrival converts the approach clearance into a service claim, which is
    // what stops the lease clock — an unload legitimately outlasts it.
    if (this.facilityControl.markDocked(inst) || this.facilityControl.statusOf(inst) === DOCKED) {
      s.abandonSweeps = 0;
      s.state = UNLOADING;
      s.unloadWaitTimer = 0;
      return;
    }
    // Arrived without a live clearance (revoked mid-approach): get back in line.
    this.facilityControl.request(inst, facility);
    s.state = WAITING_FOR_DOCK;
  }

  /**
   * Hold at the assigned fix until the controller grants the corridor.
   *
   * Driven through `_travel`, not a raw `_order`. That is the whole point: the
   * old version re-issued the same order every tick with no stall timer, no
   * no-progress timer and no detours, at a ring point computed from raw
   * `cos/sin` with no terrain check — so a waiter whose fix sat behind a rock
   * ordered it forever and never once registered as stuck.
   */
  _waitingForDock(inst, s, dt) {
    const facility = this._facility(inst);
    if (!facility) {
      s.state = IDLE;
      return;
    }

    // Outside the terminal area there is nothing to hold for — and holding
    // anyway is how the first version deadlocked: a claim taken from across
    // the map put the whole drive on the lease clock. Reachable from
    // `_onAbandoned`'s escalation, which can send a wedged harvester here from
    // any distance, so the check belongs on this side rather than only at the
    // TO_BASE call site.
    if (!this.facilityControl.inTerminalArea(inst, facility)) {
      this.facilityControl.release(inst);
      s.state = TO_BASE;
      s.dest = null;
      return;
    }

    this.facilityControl.request(inst, facility);
    if (this.facilityControl.statusOf(inst) === CLEARED) {
      // Cleared to approach. Note this does *not* claim the dock from out on
      // the ring — the old code did, and instantly failed `_unload`'s drift
      // check from there, releasing the dock it had just taken.
      s.state = TO_BASE;
      s.dest = null;
      s.waypoint = null;
      s.detours = 0;
      s.stallTimer = 0;
      return;
    }

    this._travel(inst, s, dt, HOLD_ARRIVE_RADIUS, () => {
      inst.arrive('reached');
      s.dest = null;
    });
  }

  /**
   * Run for the facility — or, failing that, directly away from whatever is
   * shooting.
   *
   * A harvester has no weapon and no business fighting, so "flee" is the whole
   * of its combat behaviour. Heading for its own facility rather than simply
   * away is the better instinct: it is where any repair bay and any defending
   * units are, so it runs *toward* help rather than into open ground.
   */
  _flee(inst, s, dt) {
    const facility = this._facility(inst);
    if (facility) {
      return this._travel(inst, s, dt, DOCK_DISTANCE, () => {
        // Arrived home while still being shot at — hold here rather than
        // bouncing back out. The threat timer expiring is what releases it.
        inst.arrive('reached');
        s.dest = null;
      });
    }

    // Nowhere to run to: put distance between itself and the last known
    // threat direction instead. Recomputed rather than cached so it keeps
    // fleeing the *current* danger, not where it started.
    const away = inst.threatFrom;
    if (!away) {
      s.state = IDLE;
      return;
    }
    const pos = inst.group.position;
    const bearing = Math.atan2(pos.z - away.z, pos.x - away.x);
    const dest = {
      x: pos.x + Math.cos(bearing) * FLEE_DISTANCE,
      z: pos.z + Math.sin(bearing) * FLEE_DISTANCE,
    };
    if (!this._order(inst, s, dest)) s.retryTimer = RETRY_PAUSE;
  }

  /** Give up the dock — the single door every exit from UNLOADING goes through. */
  _releaseDock(facility, inst) {
    this.facilityControl.release(inst);
  }

  /**
   * Only the routing state needs dropping. The clearance claim does not: it
   * lives on the vehicle, and `facilityControl` rebuilds its index from the
   * live fleet each tick, so a destroyed harvester's claim ceases to exist by
   * being absent rather than by being released.
   *
   * That is a deliberate deletion, not an omission. The old release path
   * resolved the facility with `_facility(inst)` — a `.find()` *search*, not
   * the facility the claim was taken on — so with two same-team facilities it
   * freed an index out of the wrong queue while leaking the real one.
   *
   * A facility dying needs no equivalent either: every state that depends on
   * one re-resolves `_facility(inst)` fresh each tick rather than holding a
   * reference, so once it is gone those calls return null and every harvester
   * headed there self-heals to IDLE.
   */
  onDestroy(inst) {
    if (inst.kind !== 'vehicle') return;
    this.states.delete(inst);
  }

  /**
   * What to resume into once manual driving, an open menu, or a repair trip
   * ends. Docking and holding both carry a clearance a forced pause can't
   * honestly keep — the harvester isn't meaningfully "still there" once
   * something else has the wheel — so both give it up and resume into TO_BASE,
   * which cleanly re-requests rather than resuming a claim it no longer owns.
   */
  _safeResumeState(inst, s) {
    if (s.state === UNLOADING || s.state === WAITING_FOR_DOCK) {
      this.facilityControl.release(inst);
      return TO_BASE;
    }
    return s.state;
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

    const facility = this._facility(inst);
    if (!facility) {
      s.state = IDLE;
      inst.shouldPark = false;
      this._leaveParking(inst, s);
      return;
    }

    // Calculate parking bay position
    const bayIndex = s.parkingBayIndex ?? 0;
    const angle = bayIndex * (Math.PI * 2 / MAX_PARKING_BAYS);
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

  /**
   * A refinery this harvester can actually deliver to: same team, finished,
   * and able to accept cargo. Team-scoping is not cosmetic — without it a
   * harvester hauls its load to whichever refinery happens to be first in the
   * array and pays an opponent for it.
   */
  _facility(inst) {
    return (
      this.structures.instances.find(
        (i) => i.mode === 'idle' && i.def.unloadRate && i.teamId === inst.teamId
      ) ?? null
    );
  }

  /** Where this state is trying to get to, recomputed so it can never go stale. */
  _destination(inst, s) {
    if (s.state === TO_FIELD) return s.field ? { x: s.field.x, z: s.field.z } : null;
    // TO_BASE and FLEEING share a destination — the facility dock. `_travel`
    // resolves this fresh every tick and treats a null as "nowhere to go, give
    // up and idle", so a state that drives via `_travel` and is missing here
    // silently falls back to IDLE instead of moving.
    if (s.state === TO_BASE || s.state === FLEEING) {
      const f = this._facility(inst);
      return f ? { x: f.dock.x, z: f.dock.z } : null;
    }
    // Holding: the controller owns where. Resolved fresh each tick like every
    // other destination here, so a re-slotted waiter re-aims without special
    // handling.
    if (s.state === WAITING_FOR_DOCK) {
      const f = this._facility(inst);
      return f ? this.facilityControl.holdingFix(inst, f) : null;
    }
    // Repair run: aim for the bay's dock. A destroyed or no-longer-idle bay
    // resolves to null, which _travel turns into a clean fall-back to IDLE.
    if (s.state === TO_REPAIR) {
      const bay = s.repairBay;
      if (!bay || bay.dead || bay.def.id !== 'repair-bay' || bay.mode !== 'idle') return null;
      return { x: bay.dock.x, z: bay.dock.z };
    }
    return null;
  }

  /** Nearest finished, same-team repair bay — mirrors repairController/commands. */
  _nearestRepairBay(inst) {
    const pos = inst.group.position;
    let best = null;
    let bestD = Infinity;
    for (const s of this.structures?.instances ?? []) {
      if (s.def.id !== 'repair-bay' || s.mode !== 'idle') continue;
      if (s.teamId !== inst.teamId) continue;
      const d = Math.hypot(s.x - pos.x, s.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /**
   * Breaks off for repair when hurt, if a reachable bay is affordable. Returns
   * true once it has switched into TO_REPAIR so the caller stops there.
   *
   * The affordability gate mirrors repairController's: claiming a bay we can't
   * pay to use would just bounce straight back out. The cooldown, set when a
   * previous attempt ended still-hurt, is what stops a harvester that can't
   * reach (or afford) the bay from looping between here and the bay forever
   * instead of getting back to work.
   */
  _maybeRetreatForRepair(inst, s, dt) {
    if (s.repairRetryCooldown > 0) {
      s.repairRetryCooldown -= dt;
      return false;
    }
    if (inst.health > inst.def.maxHealth * REPAIR_RETREAT_FRACTION) return false;
    // Finish the delivery already under way. Breaking off from TO_BASE throws
    // away a completed round trip and takes the load out of the economy for as
    // long as the bay queue is — measured at eight to ten minutes with a
    // handful of damaged scouts ahead of it, during which the team earned
    // nothing and its credits drained paying for *their* repairs. The
    // unloading itself is a few seconds away, and IDLE re-checks this the
    // moment it is done, so the repair is deferred rather than skipped.
    // Danger is a separate question and FLEEING still owns it.
    if (s.state === TO_BASE && s.load > 0) return false;
    // The vehicle the player is driving stays under their hand, same carve-out
    // repairController's auto-queue makes.
    if (inst === this.vehicles.active) return false;

    const bay = this._nearestRepairBay(inst);
    if (!bay) return false;
    const missing = inst.def.maxHealth - inst.health;
    const cost = Math.ceil(missing * bay.def.repair.creditsPerHealth);
    if (this.game.teamOf(inst).credits < cost) return false;

    // Give the dock up before heading the other way. TO_REPAIR is reachable
    // straight out of TO_BASE, and without this the harvester would hold the
    // depot's approach corridor for the entire drive to the bay — the lease
    // would eventually reclaim it, but only after blocking the queue for
    // CLEARANCE_LEASE seconds for no reason.
    this.facilityControl.release(inst);
    s.repairBay = bay;
    s.state = TO_REPAIR;
    s.dest = null;
    s.waypoint = null;
    s.detours = 0;
    s.stallTimer = 0;
    return true;
  }

  /**
   * Arrived near the bay under our own driving. Hand the dock+heal to
   * repairController by setting inst.repair in its entry state; the `!!inst.repair`
   * gate at the top of _drive then holds this dispatch back until it clears.
   */
  _arriveAtRepair(inst, s) {
    const bay = s.repairBay;
    s.repairBay = null;
    if (!bay || bay.dead || bay.def.id !== 'repair-bay' || bay.mode !== 'idle') {
      // Bay vanished between the last destination check and arriving — don't
      // hand off to nothing; go back to work (or keep the cooldown short).
      s.state = s.load > 0 ? TO_BASE : IDLE;
      s.dest = null;
      return;
    }
    inst.repair = { bay, state: 'to-bay' };
    s.state = REPAIRING;
    s.dest = null;
    s.waypoint = null;
  }

  /**
   * Passive wait while repairController owns the vehicle. It only runs once
   * inst.repair has cleared (the `!!inst.repair` gate suppresses this dispatch
   * until then), i.e. the moment repair ended — healed, or interrupted.
   */
  _repairingWait(inst, s) {
    if (inst.health > inst.def.maxHealth * REPAIR_RETREAT_FRACTION) {
      // Healed past the retreat line — resume normally.
      s.state = s.load > 0 ? TO_BASE : IDLE;
    } else {
      // Ended still hurt (ran dry / gave up reaching the pad). Back off before
      // retrying so it works rather than shuttling to the bay on a loop.
      s.repairRetryCooldown = REPAIR_RETRY_COOLDOWN;
      s.state = s.load > 0 ? TO_BASE : IDLE;
    }
    s.dest = null;
    s.waypoint = null;
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
    //
    // Deliberately does *not* reset `s.detours`. Reaching a waypoint means the
    // manoeuvre worked, not that the leg is going anywhere — and a harvester
    // wedged short of its field can reach detour waypoints all day. Resetting
    // here put the ladder back to zero on every cycle, so it never reached
    // DETOUR_ANGLES.length and the give-up below it (ban the field, go
    // somewhere else) was unreachable. Amber's harvester rode that loop for the
    // whole match. The ladder is reset by *progress* instead — see the
    // bestDistance branch at the end of this function.
    if (s.waypoint) {
      const wd = Math.hypot(s.waypoint.x - pos.x, s.waypoint.z - pos.z);
      if (wd <= WAYPOINT_RADIUS) {
        s.waypoint = null;
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
    //
    // "Not moving" is not the same as "stuck". A vehicle yielding to traffic is
    // holding on purpose, and one mid-reverse is moving away from the goal by
    // design — counting either as a stall diagnoses a polite wait as a blockage
    // and drives the vehicle off with a detour, which is exactly how a loaded
    // harvester ends up circling a busy dock forever instead of unloading.
    //
    // Fleeing joins them for the same reason: a harvester that has run home and
    // is deliberately holding station under its facility's protection is doing
    // precisely what it should, and a detour would send it back out into fire.
    // ...but a manoeuvre is only a manoeuvre for so long. Both of the
    // mechanical holds can re-arm themselves indefinitely — `yielding` while
    // the obstacle stays put, `reverseTimer` from driveToTarget's sharp-turn
    // escape — and while either is true *both* escapes below are switched off,
    // which makes an unresolvable one permanent rather than slow. A harvester
    // was found frozen exactly this way for fourteen simulated minutes: order
    // live, speed 0, odometer unmoved, and both timers reading 0.00 because
    // `reverseTimer` was re-armed before it could ever expire. So they get a
    // grace period, generous against a real three-point turn (~1.2s of reverse
    // plus a beat of forward travel, a few times over) and far short of a
    // freeze.
    //
    // FLEEING is deliberately *not* bounded. That one is not a manoeuvre in
    // progress but a standing decision — a harvester holding station under its
    // facility's guns is doing precisely what it should, for as long as the
    // threat lasts, and timing it out would send it back into fire.
    const mechanicalHold = inst.yielding || inst.reverseTimer != null;
    s.holdTimer = mechanicalHold ? (s.holdTimer ?? 0) + dt : 0;
    const holding = s.state === FLEEING || (mechanicalHold && s.holdTimer < HOLD_GRACE);
    s.stallTimer = !holding && inst.speed < STALL_SPEED ? s.stallTimer + dt : 0;
    if (s.stallTimer > STALL_TIMEOUT) {
      s.stallTimer = 0;
      this._onAbandoned(inst, s, dest, d);
      return;
    }

    // Moving, but getting nowhere.
    //
    // The stall check above measures *speed*, and that is blind to the failure
    // this catches: a vehicle pointed away from its goal drives at the
    // alignment floor (vehicleController's `Math.max(0.12, cos(delta))` — for a
    // harvester, exactly 1.68 u/s) on a wide arc, which is comfortably above
    // STALL_SPEED and so reads as perfectly healthy while it orbits its own
    // destination indefinitely. A real save caught four harvesters doing this
    // around one dock at once, colliding, with every stallTimer sat at 0.
    //
    // Progress, not speed, is the honest measure: track the closest this leg
    // has ever got and complain if that stops improving.
    //
    // Keyed off the state itself rather than reset at each of the ~ten sites
    // that can change it — one check here cannot be forgotten by a state added
    // later.
    if (s.progressLeg !== s.state) {
      s.progressLeg = s.state;
      s.bestDistance = null;
      s.noProgressTimer = 0;
    }

    if (holding) {
      // A deliberate hold is not a failure to progress — but it is not evidence
      // of progress either, so the timer *pauses* here rather than resetting.
      //
      // That distinction is the whole fix. `holding` re-arms: driveToTarget's
      // terrain-blocked escape reverses for REVERSE_DURATION, the reverse ends,
      // the vehicle drives back at the same unclimbable grade, and it reverses
      // again — a two-second cycle. Zeroing the counter on every cycle meant it
      // never got past a few tenths of a second, so a vehicle bouncing off one
      // slope forever read as perfectly healthy. Amber's harvester did exactly
      // that: forty minutes, full speed, six units of ground covered, `stall`
      // and `noProgress` both sat at 0.00 the entire time. Pausing instead
      // accumulates the moving-but-getting-nowhere fraction of each cycle, so
      // the escalation arrives in a minute or so instead of never.
      //
      // The bound in `holding` above and this are complementary, not
      // duplicates: that one catches a hold that never *ends*, this one catches
      // a hold that ends and immediately starts again.
    } else if (s.bestDistance == null || d < s.bestDistance - PROGRESS_EPSILON) {
      s.bestDistance = d;
      s.noProgressTimer = 0;
      // Closer than this leg has ever been: the detours are working, so the
      // ladder starts again from the direct line. This is the only thing that
      // resets it, which is what keeps it monotonic when nothing is working.
      s.detours = 0;
    } else {
      s.noProgressTimer = (s.noProgressTimer ?? 0) + dt;
      if (s.noProgressTimer > NO_PROGRESS_TIMEOUT) {
        s.noProgressTimer = 0;
        s.bestDistance = null;
        this._onAbandoned(inst, s, dest, d);
      }
    }
  }

  _onAbandoned(inst, s, dest, distance) {
    const pos = inst.group.position;
    // This fires on the very first tick of a fresh leg too — `_travel`'s own
    // `!inst.hasOrder` check can't tell "never ordered yet" from "genuinely
    // abandoned," since issuing that first order *is* one of this function's
    // jobs. `s.detours`/`s.waypoint` are what distinguish them: both are 0/
    // null on a clean entry (reset at every state transition) and only
    // become non-zero once this function has already run once for this leg.
    // Reversing on a fresh order the vehicle hasn't even attempted yet would
    // mean every routine trip starts by backing up for no reason.
    //
    // Exception: a vehicle actively grinding a slope (`blocked`) is already
    // pinned — the "don't reverse on a fresh order" reasoning above assumes the
    // order was never attempted, but a blocked vehicle has been trying and
    // failing against terrain. Backing off first is the one move that can free
    // it, so grind gets the reverse immediately instead of waiting for the
    // second abandon.
    const alreadyTrying = s.detours > 0 || !!s.waypoint;
    // Tracked vehicles never take this reverse: they can pivot to face any
    // heading without moving, so backing off first buys nothing they can't
    // already do by turning toward the next detour angle in place.
    if (
      (alreadyTrying || inst.blocked) &&
      inst.reverseTimer == null &&
      !inst.tracked &&
      !hasVehicleBehind(inst, this.vehicles.instances)
    ) {
      inst.beginReverse(REVERSE_DURATION);
    }

    if (inst.tracked && s.detours < DETOUR_ANGLES.length && Math.abs(DETOUR_ANGLES[s.detours]) >= TRACKED_DETOUR_LIMIT) {
      // Skip the backward-hemisphere angle(s) entirely for tracked vehicles —
      // retry immediately with the next one rather than waypointing them
      // somewhere they'd have to reverse to reach.
      s.detours++;
      s.retryTimer = 0.2;
      return;
    }

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
      // Home is never bannable — the pad is reachable by construction, the base
      // drove there — so this used to reset and re-run the identical five-angle
      // sweep, on the reasoning that "a harvester circling near home beats one
      // frozen in a canyon."
      //
      // `harvester-collision-avoidance-study.md` measured what that actually
      // does: a harvester knocked into a bad spot by an ordinary collision is
      // not circling, it is stationary, and it re-ran the same failing plan 256
      // times over eight minutes without moving. The destination being
      // reachable in principle says nothing about it being reachable from
      // *here*, which is the thing that had failed.
      //
      // So count the sweeps, and after enough of them stop repeating the plan:
      // route via the holding fix first. That is a different, known-standable
      // point the controller has already terrain-probed, and reaching it
      // re-approaches the dock from somewhere other than wherever this harvester
      // has got itself wedged.
      s.abandonSweeps = (s.abandonSweeps ?? 0) + 1;
      if (s.abandonSweeps >= ABANDON_ESCALATION) {
        s.abandonSweeps = 0;
        const facility = this._facility(inst);
        // Only worth doing near home: the holding fix is a point *at* the
        // facility, so routing via it from across the map is not an
        // alternative approach, just a longer version of the failing one.
        if (facility && this.facilityControl.inTerminalArea(inst, facility)) {
          this.facilityControl.request(inst, facility);
          s.state = WAITING_FOR_DOCK;
          s.dest = null;
          s.stallTimer = 0;
          return;
        }
      }
      s.retryTimer = RETRY_PAUSE;
      s.dest = null;
      return;
    }

    if (s.state === WAITING_FOR_DOCK) {
      // Even the holding fix is unreachable from here. Re-requesting puts this
      // harvester at the back of the queue and, because slots are allocated in
      // queue order, hands it a *different* fix rather than the one it just
      // failed to reach.
      this.facilityControl.requeue(inst);
      s.retryTimer = RETRY_PAUSE;
      s.dest = null;
      return;
    }

    if (s.state === TO_REPAIR) {
      // The bay is unreachable from here. Fall back to working and, crucially,
      // arm the full repair cooldown — a 1.5s RETRY_PAUSE would let the retreat
      // check re-fire almost immediately and shuttle back toward the same
      // unreachable bay on a loop instead of getting on with harvesting.
      s.repairBay = null;
      s.repairRetryCooldown = REPAIR_RETRY_COOLDOWN;
      s.state = s.load > 0 ? TO_BASE : IDLE;
      s.dest = null;
      s.retryTimer = RETRY_PAUSE;
      return;
    }

    // Ban the destination, not the route: the failure this handles is "that
    // field sits on ground I cannot climb", and moving on is what a player
    // would do.
    if (s.field) s.bans.set(s.field.id, simClock.time + BAN_SECONDS);
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
