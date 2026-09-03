/**
 * Ground control for facilities: who may approach a dock, and who holds clear.
 *
 * Replaces two independent, drifting copies of the same idea —
 * `harvesterAI`'s `dockedHarvester`/`_haulQueue` pair and `repairController`'s
 * `dockedVehicle`/`_repairQueue` pair — each of which had a claim, an
 * allocator, and a self-heal sweep the other was missing pieces of.
 *
 * **The ledger is derived, never stored.** The claim on the vehicle
 * (`inst.clearance`) is the only source of truth; this controller rebuilds its
 * whole index from `vehicles.instances` every tick. That is not an
 * optimisation, it is what removes a class of bug:
 *
 * - A destroyed vehicle is simply absent from the rebuild, so a claim cannot
 *   outlive its holder. No release-on-destroy, and therefore no repeat of the
 *   old `onDestroy` bug where the claim was released against a *searched*
 *   facility rather than the one it was taken on.
 * - `snapshot.js` is a hand-written field whitelist and its restore path uses
 *   `remove()`, which never fires destroy hooks — so any stored ledger would
 *   leak dead keys across every load. `inst.clearance` rides on the vehicle,
 *   which is already serialized, and the index rebuilds itself on the first
 *   tick after a load.
 * - Rebuild doubles as repair: a restored fleet holding two conflicting claims
 *   on one dock is resolved by the same ordering rule everything else uses,
 *   rather than by a sweep that has to remember to run.
 *
 * Ordering is `requestedTick`, tie-broken by vehicle id — never
 * `vehicles.instances` order, which is spawn/removal history and which
 * `stateHash.js` documents as not part of the state two clients must agree on.
 */

import { simClock } from '../core/simClock.js';

/** Waiting at an assigned holding fix, outside the approach corridor. */
export const HOLDING = 'holding';
/** Sole vehicle permitted inside the approach corridor. */
export const CLEARED = 'cleared';
/** Arrived and occupying the service point. */
export const DOCKED = 'docked';

/**
 * The controlled corridor, measured from the facility centre. One vehicle at a
 * time is inside it — this is the deconfliction, and the reason two harvesters
 * can no longer converge on one dock from different bearings.
 *
 * Comfortably larger than harvesterAI's `DOCK_DISTANCE` (22) plus the dock's
 * own 12-unit offset, so a vehicle that has legitimately arrived is inside its
 * own corridor rather than straddling the boundary.
 */
export const APPROACH_RADIUS = 36;
/**
 * Holding fixes sit outside `APPROACH_RADIUS` by construction. If these two
 * ever cross, waiters park inside the corridor they are waiting to be let
 * into, which is exactly the pile-up this controller exists to prevent.
 */
const HOLD_RING = 50;
/**
 * Overflow widens the ring by a layer rather than reusing an angle. The old
 * allocators looped to 64 while the angle was `slot * 2π/4`, so slot 4 was the
 * identical world point as slot 0 — unique bookkeeping, colliding geometry.
 */
const HOLD_SLOTS_PER_LAYER = 4;
const HOLD_RING_STEP = 16;
/**
 * Seconds a grant has to become a dock before it is revoked and passed on.
 * The backstop against one stuck vehicle holding a dock indefinitely — the
 * failure `harvester-collision-avoidance-study.md` measured, where a harvester
 * that could not reach the dock kept everyone else waiting on it forever.
 * Generous: a wide-turning harvester crossing a corridor legitimately takes
 * time, and a premature revoke would churn the queue instead of draining it.
 */
const CLEARANCE_LEASE = 45;
/**
 * How close a vehicle has to be before ground control has anything to say to
 * it. Outside this it just drives; inside it must hold a clearance.
 *
 * This exists because the first version didn't have it, and the 4-harvester
 * verification run deadlocked in a way the unit tests could not see: clearance
 * was requested the moment a harvester left its field, so the lease was timing
 * a whole cross-map drive rather than an approach. Nobody could finish that
 * drive inside the lease, every grant was revoked in turn, and the corridor
 * rotated between four equally-distant harvesters forever — 0 delivered in 60
 * simulated seconds. Bounding the *approach* is the thing that was wanted;
 * bounding the journey was never the same statement.
 *
 * Must stay comfortably outside `HOLD_RING` so a holding vehicle is inside the
 * terminal area and keeps its claim rather than oscillating across the boundary.
 */
export const TERMINAL_RADIUS = 110;
/**
 * Consecutive revokes past which a vehicle is reported as genuinely stuck
 * rather than merely waiting. Two, not one: a single revoke is a slow approach
 * or an unlucky bump, which is normal.
 */
export const STUCK_REVOKES = 2;
/**
 * Deterministic sub-angles tried when a holding fix lands somewhere unusable.
 * Sweeps most of the way round rather than nudging: a facility built on a
 * coastline has an entire half-plane of water on one side, and a fan that only
 * reached +-0.7rad would hand every slot on that side a fix in the sea.
 */
const FIX_NUDGE_ANGLES = [0, 0.35, -0.35, 0.7, -0.7, 1.2, -1.2, 1.9, -1.9, 2.6, -2.6];

/** Ascending by id — never array order. See the header. */
function byId(a, b) {
  return a.id - b.id;
}

/**
 * Queue order: earliest request wins, id breaks exact ties. Both operands are
 * simulated state, so every client resolves contention the same way — the same
 * discipline `trafficController`'s `createdAt` tie-break already follows.
 */
function byRequest(a, b) {
  const ta = a.clearance.requestedTick;
  const tb = b.clearance.requestedTick;
  return ta !== tb ? ta - tb : a.id - b.id;
}

export class FacilityControl {
  constructor({ vehicles, structures, heightmap }) {
    this.vehicles = vehicles;
    this.structures = structures;
    this.heightmap = heightmap;
    /** facilityId -> { cleared, docked, holders[], slots:Set }. Rebuilt every tick. */
    this._index = new Map();
    /** Structures by id, rebuilt each `_rebuild` — see `_reindexFacilities`. */
    this._byId = new Map();
  }

  // ---------------------------------------------------------------- lifecycle

  update() {
    this._rebuild();
    this._expireLeases();
    this._promote();
  }

  /** A new match, or a snapshot restore. The claims live on the vehicles, so
   * they are what actually has to be cleared; the index is derived. */
  reset() {
    this._index.clear();
    for (const inst of this.vehicles?.instances ?? []) inst.clearance = null;
  }

  // ------------------------------------------------------------------ queries

  /** `null` when this vehicle holds no clearance at all. */
  statusOf(inst) {
    return inst.clearance?.status ?? null;
  }

  /** Has this vehicle been let into the approach corridor? */
  isCleared(inst) {
    const status = this.statusOf(inst);
    return status === CLEARED || status === DOCKED;
  }

  /**
   * Is this vehicle close enough to the facility for clearance to apply? Far
   * out there is no contention to manage and nothing to hold it for.
   */
  inTerminalArea(inst, facility) {
    if (!facility) return false;
    const p = inst.group?.position;
    if (!p) return true; // no position to judge by — treat it as under control
    return Math.hypot(facility.x - p.x, facility.z - p.z) <= TERMINAL_RADIUS;
  }

  /** Waiters, not counting whoever currently holds the corridor. */
  queueDepth(facility) {
    return this._entry(facility)?.holders.length ?? 0;
  }

  /**
   * Repeatedly revoked — the vehicle believes it is making progress toward a
   * dock and is not. Today a harvester frozen for eight minutes reports the
   * same state as one mid-delivery; this is the discriminator.
   */
  isStuck(inst) {
    return (inst.clearance?.revokes ?? 0) >= STUCK_REVOKES;
  }

  // ------------------------------------------------------------------ claims

  /**
   * Ask for permission. Idempotent: calling it every tick while approaching is
   * the intended usage, and re-requesting never resets a vehicle's place in
   * the queue — otherwise a caller that asks each tick could never advance
   * past one that asks once.
   */
  request(inst, facility, kind = 'dock') {
    if (!facility || facility.dead) return null;
    const existing = inst.clearance;
    if (existing && existing.facilityId === facility.id) return existing.status;
    // Switching target facility abandons the old claim outright; the rebuild
    // will not find it and the slot frees itself.
    // Granted on the spot when nothing holds the corridor. Deferring this to
    // the next `_promote` would bounce every ordinary approach through a
    // holding state for one tick — visible churn, and a wasted order.
    let entry = this._index.get(facility.id);
    if (!entry) {
      // Record it now rather than waiting for the next rebuild: two vehicles
      // requesting in the same tick must not both be told the corridor is
      // free. The rebuild would resolve that a tick later, but only after two
      // vehicles had already been ordered into the same corridor.
      entry = { cleared: null, docked: null, holders: [], slots: new Set() };
      this._index.set(facility.id, entry);
    }
    // Nobody in the corridor *and* nobody already waiting. The second half
    // matters: granting on the spot while a queue exists would let a vehicle
    // that just turned up overtake one that has been holding, which is the
    // opposite of what the ordering rule is for.
    const free = !entry.cleared && !entry.docked && entry.holders.length === 0;
    inst.clearance = {
      facilityId: facility.id,
      kind,
      slot: null,
      status: free ? CLEARED : HOLDING,
      requestedTick: simClock.tick,
      grantedAt: free ? simClock.time : null,
      // Retargeting to a different facility is a fresh problem, not a
      // continuation of the old one — the stuck counter starts over.
      revokes: 0,
    };
    if (free) entry.cleared = inst;
    else entry.holders.push(inst);
    return inst.clearance.status;
  }

  /**
   * Arrived and in service. Stops the lease clock — an unload or a repair can
   * legitimately outlast `CLEARANCE_LEASE`, which only ever bounds the
   * *approach*, never the service itself.
   */
  markDocked(inst) {
    const c = inst.clearance;
    if (!c || c.status !== CLEARED) return false;
    c.status = DOCKED;
    c.revokes = 0;
    return true;
  }

  release(inst) {
    inst.clearance = null;
  }

  /**
   * Back of the queue, same facility, **keeping** the revoke count.
   * `release()` then `request()` would look equivalent and is not: it resets
   * `revokes` to zero, so a vehicle that repeatedly fails to reach its holding
   * fix would never accumulate the evidence that it is stuck.
   */
  requeue(inst) {
    const c = inst.clearance;
    if (!c) return;
    c.status = HOLDING;
    c.grantedAt = null;
    c.slot = null;
    c.requestedTick = simClock.tick;
    c.revokes++;
  }

  // ------------------------------------------------------------- holding fix

  /**
   * The world point this vehicle should hold at. Allocated from its slot, then
   * grade-probed: the ring points the old queue used were raw `cos/sin` with no
   * terrain check at all, so a fix inside a cliff was ordered forever by a
   * waiter that had no stall detection either.
   */
  holdingFix(inst, facility) {
    const c = inst.clearance;
    if (!c || !facility) return null;
    const slot = c.slot ?? 0;
    const layer = Math.floor(slot / HOLD_SLOTS_PER_LAYER);
    const radius = HOLD_RING + layer * HOLD_RING_STEP;
    const base = (slot % HOLD_SLOTS_PER_LAYER) * ((Math.PI * 2) / HOLD_SLOTS_PER_LAYER);

    let fallback = null;
    for (const nudge of FIX_NUDGE_ANGLES) {
      const angle = base + nudge;
      const point = {
        x: facility.x + Math.cos(angle) * radius,
        z: facility.z + Math.sin(angle) * radius,
      };
      if (!fallback) fallback = point;
      if (this._standable(point)) return point;
    }
    // Every candidate is unclimbable. Returning the first keeps the caller's
    // contract simple; it drives through `_travel`, which has its own stall
    // and no-progress escalation for exactly this case.
    return fallback;
  }

  _standable(point) {
    const hm = this.heightmap;
    if (!hm) return true;
    return hm.heightAt(point.x, point.z) > hm.seaLevelY + 1;
  }

  // ------------------------------------------------------------------ internals

  _entry(facility) {
    return facility ? this._index.get(facility.id) ?? null : null;
  }

  /**
   * Structures by id, rebuilt once per `_rebuild` rather than re-scanned per
   * claimant.
   *
   * This was a linear scan over every structure, called once for each vehicle
   * holding a clearance, inside a pass that runs every tick — O(claimants x
   * structures) where a Map makes it O(structures + claimants). Never a cliff
   * on its own, but it scales with both unit and structure count, and a
   * 20-team match has a lot of both. See
   * docs/plans/fps-regression-second-pass.md.
   *
   * Rebuilt each pass rather than cached across ticks, deliberately: a
   * structure can die at any time, and this file's own rule is to re-resolve
   * from the live `instances` array rather than hold a reference across ticks.
   */
  _reindexFacilities() {
    this._byId.clear();
    for (const s of this.structures?.instances ?? []) this._byId.set(s.id, s);
  }

  _facilityById(id) {
    return this._byId.get(id) ?? null;
  }

  /**
   * Rebuild the index from the fleet. Also the repair pass: any claim whose
   * holder is dead, whose facility is gone or no longer serviceable, or which
   * duplicates a claim an earlier-queued vehicle already holds, is dropped or
   * demoted here rather than by a separate sweep.
   */
  _rebuild() {
    this._index.clear();
    this._reindexFacilities();

    const claimants = [];
    for (const inst of this.vehicles?.instances ?? []) {
      const c = inst.clearance;
      if (!c) continue;
      if (inst.dead) {
        inst.clearance = null;
        continue;
      }
      const facility = this._facilityById(c.facilityId);
      if (!facility || facility.dead || facility.mode !== 'idle') {
        inst.clearance = null;
        continue;
      }
      claimants.push(inst);
    }
    claimants.sort(byId);

    // Bucket by facility, resolving corridor conflicts in queue order so the
    // outcome cannot depend on array position.
    for (const inst of claimants) {
      const c = inst.clearance;
      let entry = this._index.get(c.facilityId);
      if (!entry) {
        entry = { cleared: null, docked: null, holders: [], slots: new Set() };
        this._index.set(c.facilityId, entry);
      }

      if (c.status === DOCKED) {
        if (!entry.docked || byRequest(inst, entry.docked) < 0) {
          if (entry.docked) this._demote(entry, entry.docked);
          entry.docked = inst;
        } else {
          this._demote(entry, inst);
        }
      } else if (c.status === CLEARED) {
        if (!entry.cleared || byRequest(inst, entry.cleared) < 0) {
          if (entry.cleared) this._demote(entry, entry.cleared);
          entry.cleared = inst;
        } else {
          this._demote(entry, inst);
        }
      } else {
        entry.holders.push(inst);
      }
    }

    for (const entry of this._index.values()) {
      // A vehicle in service supersedes one merely cleared to approach: the
      // service point is taken, so nobody else should be in the corridor.
      if (entry.docked && entry.cleared) {
        this._demote(entry, entry.cleared);
        entry.cleared = null;
      }
      entry.holders.sort(byRequest);
      // The ordering rule alone decides who holds the corridor — not who
      // happened to call request() first within a tick, and not array order,
      // which `stateHash.js` is explicit is not part of the state two clients
      // must agree on. Only reachable on a same-tick race or a restore, since
      // `_promote` already picks in order.
      if (entry.cleared && entry.holders.length && byRequest(entry.holders[0], entry.cleared) < 0) {
        const promoted = entry.holders.shift();
        this._demote(entry, entry.cleared);
        entry.cleared = promoted;
        promoted.clearance.status = CLEARED;
        promoted.clearance.grantedAt = simClock.time;
        entry.holders.sort(byRequest);
      }
      this._assignSlots(entry);
    }
  }

  _demote(entry, inst) {
    inst.clearance.status = HOLDING;
    inst.clearance.grantedAt = null;
    entry.holders.push(inst);
  }

  /**
   * Unique slot per waiter, lowest free index first. Uniqueness is what the old
   * allocators got right; the cap they lacked is enforced by the geometry
   * instead — `holdingFix` puts every fourth slot on a wider ring rather than
   * back on an occupied angle.
   */
  _assignSlots(entry) {
    for (const inst of entry.holders) {
      const c = inst.clearance;
      if (c.slot != null && !entry.slots.has(c.slot)) {
        entry.slots.add(c.slot);
        continue;
      }
      let slot = 0;
      while (entry.slots.has(slot)) slot++;
      entry.slots.add(slot);
      c.slot = slot;
    }
    // Whoever holds the corridor no longer needs a parking spot.
    for (const inst of [entry.cleared, entry.docked]) {
      if (inst) inst.clearance.slot = null;
    }
  }

  /**
   * Revoke a grant that never became a dock. The holder goes to the back of
   * the queue rather than being cleared again immediately, so a vehicle that
   * genuinely cannot reach the dock stops starving the ones that can.
   */
  _expireLeases() {
    for (const entry of this._index.values()) {
      const inst = entry.cleared;
      if (!inst) continue;
      const c = inst.clearance;
      if (c.grantedAt == null) continue;
      if (simClock.time - c.grantedAt < CLEARANCE_LEASE) continue;
      c.revokes++;
      c.requestedTick = simClock.tick;
      this._demote(entry, inst);
      entry.cleared = null;
      entry.holders.sort(byRequest);
      // The ordering rule alone decides who holds the corridor — not who
      // happened to call request() first within a tick, and not array order,
      // which `stateHash.js` is explicit is not part of the state two clients
      // must agree on. Only reachable on a same-tick race or a restore, since
      // `_promote` already picks in order.
      if (entry.cleared && entry.holders.length && byRequest(entry.holders[0], entry.cleared) < 0) {
        const promoted = entry.holders.shift();
        this._demote(entry, entry.cleared);
        entry.cleared = promoted;
        promoted.clearance.status = CLEARED;
        promoted.clearance.grantedAt = simClock.time;
        entry.holders.sort(byRequest);
      }
      this._assignSlots(entry);
    }
  }

  /** Let the longest-waiting holder into an empty corridor. */
  _promote() {
    for (const entry of this._index.values()) {
      if (entry.cleared || entry.docked) continue;
      const next = entry.holders.shift();
      if (!next) continue;
      const c = next.clearance;
      if (c.slot != null) entry.slots.delete(c.slot);
      c.slot = null;
      c.status = CLEARED;
      c.grantedAt = simClock.time;
      entry.cleared = next;
    }
  }
}
