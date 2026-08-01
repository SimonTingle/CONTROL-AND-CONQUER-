/**
 * One AI opponent's decision layer — deploy, build, keep a scout exploring.
 *
 * Modelled on harvesterAI.js's governing rule, not just its vocabulary: never
 * cache a reference to another team member across ticks, because it can die.
 * "My base", "my scout" and "my facility" are re-resolved fresh from the live
 * `vehicles.instances`/`structures.instances` arrays every call — the same
 * discipline that made 2B's destroy pipeline need zero facility-side cleanup
 * code in harvesterAI, and it buys the same thing here: a team that loses a
 * unit degrades (it just does less next tick) instead of holding a stale
 * pointer into nothing.
 *
 * Deliberately lighter machinery than harvesterAI's own bans-with-expiry: that
 * exists because a harvester chooses between several bloom fields with a real
 * history worth remembering. A commander's choices here — deploy once, build
 * a facility once, buy a harvester periodically, send the scout somewhere new
 * — don't have that shape, so a single retry brake (`retryTimer`) covers it.
 *
 * commands.js is reused directly wherever it's headless (deploy, build a
 * harvester, upgrade). The two build-a-structure commands are not: they only
 * stage `ctx.buildPlacementMode` for a human to click a spot, and
 * build-repair-bay's own `execute` spends credits *before* that click even
 * happens — a split transaction that only makes sense with a placement
 * preview in between. The AI has no preview to drive, so `_buildOnPad` below
 * skips both commands entirely and does the same thing main.js's pointerup
 * handler does: pick a slot, spend, place, in one step.
 */

import { commandsFor, basePad } from './commands.js';
import { findSpawnPointNear } from '../core/pick.js';
import { STRUCTURE_CATALOG } from '../structures/structures.js';

const RETRY_PAUSE = 2; // seconds of backing off after any failed attempt this tick
// Generous relative to what a relocate order should ever need — at 9u/s the
// base covers 900+ units, more than any search ring this ever requests — so
// this only ever fires on a genuine stall, not a merely slow, valid drive.
const BASE_ORDER_TIMEOUT = 100;
// Matches vehicleController.js's own GRADE_PROBE — this is deliberately the
// same distance the vehicle itself measures its climb against when actually
// driving, so "can it leave in this direction" here means the same thing it
// will mean to the vehicle a moment later.
const GRADE_PROBE = 2.5;
/** Widening, alternating — the same shape harvesterAI's own detours use, and
 * for the same reason: a straight retry cannot work, the heading is unchanged. */
const ADVANCE_DETOURS = [0.8, -0.8, 1.5, -1.5, 2.3, -2.3];

// Difficulty scales how eagerly a team spends on its fleet and how long it
// waits before its first action — the standard skirmish-AI knobs. Keyed by
// AI_DIFFICULTIES' own id (ui/aiDifficultyScreen.js) rather than duplicating
// the tier data here.
// harvesterCap does not scale with difficulty, on purpose: _manageEconomy
// always tries an economy purchase before ever trying a combat one (see
// below), so the cap is really "how many harvester purchases happen before
// combat starts being the regular priority." A higher tier spending its way
// through a bigger cap at 600cr each just means more pure-economy spend
// before a gun platform gets a look in — that was most of what made AI
// matches take 10+ minutes to turn violent, and difficulty already has two
// knobs built for "scarier at higher tiers" that don't carry that cost:
// buildInterval (how often it acts at all) and combatCap/attackAt (how big
// and how eager its army gets once it exists).
const DIFFICULTY_ECONOMY = {
  easy: { harvesterCap: 2, buildInterval: 20, combatCap: 1, attackAt: 2 },
  normal: { harvesterCap: 2, buildInterval: 15, combatCap: 3, attackAt: 2 },
  hard: { harvesterCap: 2, buildInterval: 11, combatCap: 5, attackAt: 3 },
  expert: { harvesterCap: 2, buildInterval: 8, combatCap: 7, attackAt: 3 },
};
const DEFAULT_ECONOMY = DIFFICULTY_ECONOMY.normal;

// Structures an AI ever chooses to build on its own initiative, cheapest
// first — reads generically off the catalog's own `tags`/`cost`, so a new
// structure tagged 'production' or 'repair' is picked up with no AI changes.
const BUILDABLE_TAGS = new Set(['production', 'repair']);
const BUILDABLE_DEFS = STRUCTURE_CATALOG.filter((d) => d.tags?.some((t) => BUILDABLE_TAGS.has(t))).sort(
  (a, b) => (a.cost ?? 0) - (b.cost ?? 0)
);

// Explore outward in rings, widening each time the scout clears one — a
// simple spiral rather than anything terrain-aware, since findSpawnPointNear
// already handles "is this actually land" and falls back to the map edge.
const EXPLORE_RADIUS_START = 90;
const EXPLORE_RADIUS_STEP = 45;
const EXPLORE_RADIUS_MAX = 480;

export class AiCommander {
  /**
   * @param {object} opts
   * @param {object} opts.team the Team this commander plays as
   * @param {number} opts.buildDelaySeconds from the Multiplayer AI setup screen
   * @param {object} opts.ctx the same shape as main.js's commandContext
   *   ({ vehicles, world, heightmap, terraform, structures, game, produceUnit })
   * @param {THREE.Camera} opts.camera only ever used as findEdgeSpawnPoint's
   *   directional fallback when a ring search finds no land at all — cosmetic,
   *   not a real dependency on whose camera it is.
   */
  constructor({ team, buildDelaySeconds, ctx, camera }) {
    this.team = team;
    this.ctx = ctx;
    this.camera = camera;
    this.startTimer = buildDelaySeconds;
    this.retryTimer = 0;
    this.buildTimer = 0;
    this.exploreRadius = EXPLORE_RADIUS_START;
    // Widens each time the base has to go looking for a deploy site — a
    // point clearing findSpawnPointNear's own land check can still turn out
    // undriveable once the base actually tries to stand on it (that check
    // has no notion of slope), so a fixed search ring could keep proposing
    // the same doomed spot forever. Resets once deploy succeeds.
    this.baseRelocateAttempts = 0;
    // Seconds the base has held its current relocate order — a hard backstop
    // independent of *why* it might never arrive (an undersized target is
    // one cause, fixed in _manageBase, but nothing guarantees it's the only
    // one a future change could reintroduce).
    this.baseOrderElapsed = 0;

    const diffId = ctx.game.difficulty?.id;
    this.economy = DIFFICULTY_ECONOMY[diffId] ?? DEFAULT_ECONOMY;
  }

  update(dt) {
    if (this.team.defeated) return;

    if (this.startTimer > 0) {
      this.startTimer -= dt;
      return;
    }
    if (this.retryTimer > 0) {
      this.retryTimer -= dt;
      return;
    }

    this._driveScout(dt);
    this._manageBase(dt);
    this._manageEconomy(dt);
    this._manageArmy();
  }

  // ---- own units, re-resolved fresh every call — see the header comment ----

  _ownUnits(defId) {
    return this.ctx.vehicles.instances.filter((v) => v.teamId === this.team.id && v.def.id === defId);
  }

  _base() {
    return this._ownUnits('base-station')[0] ?? null;
  }

  _scout() {
    return this._ownUnits('scout-buggy')[0] ?? null;
  }

  // ---- deploy, once — self-gating: COMMANDS['base-station'] only lists
  // 'deploy' under 'mobile', so once mode flips to 'deploying' commandsFor
  // stops returning it and this becomes a no-op on its own ----

  _manageBase(dt) {
    const base = this._base();
    if (!base || base.mode !== 'mobile') return;
    if (base.hasOrder) {
      // A hard backstop, independent of *why* an order might never resolve —
      // see the constructor's own comment on baseOrderElapsed. Force it back
      // to abandoned and let this same call fall through to picking a fresh,
      // wider-ringed candidate below, exactly as if it had genuinely failed.
      this.baseOrderElapsed += dt;
      if (this.baseOrderElapsed < BASE_ORDER_TIMEOUT) return;
      base.arrive('cancelled');
      this.baseOrderElapsed = 0;
    }

    const cmd = commandsFor(base, this.ctx).find((c) => c.id === 'deploy');
    if (cmd?.enabledResult === true) {
      cmd.execute(base, this.ctx);
      this.baseRelocateAttempts = 0;
      return;
    }

    // The spawn point can land somewhere canDeployAt refuses — too steep, or
    // too close to the map boundary. Wander to a nearby candidate and try
    // again there. Each attempt widens the ring, up to a cap: a candidate
    // that clears findSpawnPointNear's own "is this dry land" check can still
    // turn out undriveable once actually reached (that check has no notion
    // of slope), so a fixed radius could keep proposing the same doomed spot
    // forever, and an *uncapped* one can grow into the hundreds of thousands
    // of units within a few dozen failures and start hammering
    // findEdgeSpawnPoint's degenerate every-ring-empty fallback instead of
    // ever finding real land.
    //
    // The floor on that ring matters as much as the ceiling: a target inside
    // the base's own turning circle (~74u — this is an 8x8 with a fraction of
    // a buggy's lock angle) is one its pure-pursuit steering can never
    // actually converge on. It just orbits the point forever instead of
    // arriving — hasOrder stays true, _manageBase never runs again, and
    // nothing here would ever notice. Comfortably clearing the circle, not
    // just the radius, is what keeps every point in the ring physically
    // reachable.
    this.baseRelocateAttempts++;
    const minReach = base.turningCircle * 1.3;
    const reach = Math.min(minReach + this.baseRelocateAttempts * 40, this.ctx.heightmap.params.size * 0.4);
    const origin = base.group.position;
    const spot = findSpawnPointNear(this.ctx.heightmap, origin, {
      minRadius: minReach,
      maxRadius: reach,
      camera: this.camera,
      // Two independent things have to both be true, not just the first:
      // canDeployAt is the real acceptance test for the *destination* (it
      // samples water clearance across the whole 40+18-unit pad, which a
      // narrow local-grade probe can miss near an irregular coast) — but a
      // destination can be perfectly fine while the straight-line heading
      // *from here* is still too steep to leave on, and the base has no
      // detour logic of its own to route around that the way a harvester's
      // driver does. A search that only checks the destination can keep
      // picking directions this exact departure point can't survive, forever
      // — this is what actually caused it, even with the destination check
      // above already in place. Biasing toward a direction that is at least
      // pulling away cleanly is what a real detour system would give it for
      // free; this is the cheap version of the same idea.
      isValid: (x, z) => {
        if (this.ctx.terraform.canDeployAt(x, z, base.def.deploy, this.team.id) !== true) return false;
        const dist = Math.hypot(x - origin.x, z - origin.z);
        const departHeading = Math.atan2(z - origin.z, x - origin.x);
        const probeX = origin.x + Math.cos(departHeading) * GRADE_PROBE;
        const probeZ = origin.z + Math.sin(departHeading) * GRADE_PROBE;
        const departGrade =
          Math.abs(this.ctx.heightmap.heightAt(probeX, probeZ) - this.ctx.heightmap.heightAt(origin.x, origin.z)) /
          GRADE_PROBE;
        return dist > 0 && departGrade <= base.def.maxClimbGrade * 0.85;
      },
    });
    base.setTarget(spot.point.x, spot.point.z, this.ctx.heightmap);
    // Paced regardless of outcome — not just on an outright setTarget
    // refusal. An *accepted* order can still turn out to be a near-instant
    // abandon once physics actually tries to drive it (blocked within the
    // first tick or two, on ground bad enough that arriving cleanly was
    // never realistic) — that reads as "hasOrder false again next tick," not
    // as a failure this function would otherwise notice, and without a pause
    // it retries as fast as the tick rate allows. This is what keeps a
    // genuinely bad neighbourhood a bounded, occasional retry instead of an
    // unbounded tight loop.
    this.retryTimer = RETRY_PAUSE;
    this.baseOrderElapsed = 0;
  }

  // ---- build order + periodic reinforcement ----

  _manageEconomy(dt) {
    const base = this._base();
    if (!base || base.mode !== 'deployed') return;

    if (this._tryBuildNext(base)) return; // one action per tick is plenty

    this.buildTimer -= dt;
    if (this.buildTimer > 0) return;
    this.buildTimer = this.economy.buildInterval;
    // Economy before army: a team with no income cannot sustain either, and a
    // harvester that pays for itself is worth more than a gun that does not.
    if (!this._tryBuildUnit('economy', this.economy.harvesterCap)) {
      this._tryBuildUnit('combat', this.economy.combatCap);
    }
  }

  /**
   * Build one unit carrying `tag`, if under the cap and affordable.
   *
   * Reads the produced defs off whatever this team's structures actually
   * offer, so a new unit added to any structure's `produces` list is picked
   * up here with no change: the AI asks "what do I have that is tagged
   * combat", never "build a gun-platform".
   */
  _tryBuildUnit(tag, cap) {
    if (cap <= 0) return false;
    for (const s of this.ctx.structures.instances) {
      if (s.teamId !== this.team.id || s.mode !== 'idle' || !s.def.produces) continue;
      for (const unitId of s.def.produces) {
        const def = this.ctx.vehicles.defOf(unitId);
        if (!def?.tags?.includes(tag)) continue;
        if (this._ownUnits(unitId).length >= cap) continue;

        const cmd = commandsFor(s, this.ctx).find((c) => c.id === `build-${unitId}`);
        if (cmd?.enabledResult !== true) continue;
        cmd.execute(s, this.ctx);
        return true;
      }
    }
    return false;
  }

  // ---- army: arm what it builds, and send it at something it can see ----

  _manageArmy() {
    const army = this.ctx.vehicles.instances.filter(
      (v) => v.teamId === this.team.id && !v.dead && v.def.tags?.includes('combat') && v.def.id !== 'scout-buggy'
    );
    if (army.length === 0) return;

    // Armed is the capability gate combatController reads, and arming costs
    // mobility — so it happens once, on production, not per tick.
    for (const unit of army) {
      if (unit.mode === 'mobile') unit.mode = 'armed';
    }

    // Attack only once there is enough of a group to be worth committing.
    // Below that they hold near home, which doubles as base defence since
    // combatController engages anything that wanders into range regardless.
    if (army.length < this.economy.attackAt) return;

    // Somewhere scouted and worth hitting, or — failing that — forward.
    //
    // An army that only ever moves toward *known* enemies never moves at all
    // on a large map: the lone scout rarely ranges far enough to reveal
    // another team's base before the army is built, so every unit sits at home
    // guarding nothing. Advancing on the island's middle instead keeps the
    // fair-vision rule completely intact — it is not homing on anything it
    // cannot see — while guaranteeing that four teams pushing outward
    // eventually meet. The units carry their own sight radius, so the advance
    // *is* the reconnaissance, and the moment it reveals something real
    // `_attackTarget` starts returning it instead.
    const target = this._attackTarget() ?? this._advancePoint();
    if (!target) return;

    for (const unit of army) {
      // Never re-order a unit already engaging something — combatController
      // owns the shooting, and re-targeting mid-fight just makes it drive in
      // circles under fire.
      if (unit.combatTarget || unit.hasOrder) continue;
      this._advanceUnit(unit, target);
    }
  }

  /**
   * Send one unit toward a point, working around terrain it cannot cross.
   *
   * Tries the shared NavGrid first — a coarse flow field that actually knows
   * "go around the mountain," not just "the last heading failed, try
   * another." Only when it has nothing (no grid yet, or the goal is
   * unreachable) does this fall back to the local reactive fan below, so a
   * genuinely unreachable order still degrades the same safe way it always
   * has rather than stalling with no fallback at all.
   *
   * One more thing has to fall back too: NavGrid samples terrain only at
   * ~24-unit cell centers, coarser than the ~2-unit grade probe
   * driveToTarget actually steers by. An edge can average out clear while
   * still hiding a local bump the fine probe meets — and because
   * nextWaypoint is a pure function of position, asking again from the same
   * spot returns the *identical* doomed waypoint every time. Verified
   * directly: two calls to nextWaypoint from an unmoved position produced
   * the same coordinates back to back — a deterministic stall with no
   * built-in way to break it, the same failure this whole feature exists to
   * fix, just moved up one layer. So: if the waypoint NavGrid hands back is
   * the same one as last time, this unit did not make progress on it, and
   * the local detour fan (which actually varies its heading) is what
   * breaks the tie.
   */
  _advanceUnit(unit, target) {
    const pos = unit.group.position;
    const waypoint = this.ctx.navGrid?.nextWaypoint(pos.x, pos.z, target.x, target.z);

    if (waypoint) {
      const repeat =
        unit._navWaypoint &&
        Math.hypot(waypoint.x - unit._navWaypoint.x, waypoint.z - unit._navWaypoint.z) < 1;
      unit._navStallCount = repeat ? (unit._navStallCount ?? 0) + 1 : 0;
      unit._navWaypoint = waypoint;

      if (unit._navStallCount < 2 && unit.setTarget(waypoint.x, waypoint.z, this.ctx.heightmap)) {
        unit._advanceAttempt = 0; // a real route exists; forget any stale fan history
        return;
      }
    } else {
      unit._navWaypoint = null;
      unit._navStallCount = 0;
    }

    this._advanceUnitByDetour(unit, target);
  }

  /**
   * The original local-only fallback: re-issuing the identical straight line
   * every time an order is abandoned is not a retry, it is a loop — the
   * heading is unchanged, so it fails exactly the same way and the unit
   * grinds against the same slope until the blocked-damage floor. (Observed
   * directly — an army left to it arrived at 100/400 health having never
   * fired a shot.) harvesterAI solves this with widening alternating detour
   * angles; this is the same idea, kept small because an army unit has
   * somewhere to be rather than a precise dock to hit.
   *
   * Still reachable whenever the NavGrid has no answer — no grid yet, an
   * unreachable goal, or a goal cell that reads as impassable — so a route
   * that used to work at all keeps working at least this well.
   */
  _advanceUnitByDetour(unit, target) {
    const pos = unit.group.position;
    // Read before setTarget below overwrites it: `blocked` reflects whether
    // the leg that just ended (and is *why* this function is running again)
    // failed on a climb, or ended some other way. coast() — what runs on the
    // ticks between orders — never touches it, so it's still the true
    // outcome of that leg at this exact point, not stale.
    const wasBlocked = unit.blocked;
    const attempt = unit._advanceAttempt ?? 0;
    const bearing = Math.atan2(target.z - pos.z, target.x - pos.x);

    // Attempt 0 is the direct line; each failure fans further out, alternating
    // sides so it probes both ways around whatever is in front of it.
    const offset = attempt === 0 ? 0 : ADVANCE_DETOURS[(attempt - 1) % ADVANCE_DETOURS.length];
    const range = attempt === 0 ? Math.hypot(target.x - pos.x, target.z - pos.z) : 60;
    const aim = bearing + offset;
    const x = pos.x + Math.cos(aim) * range;
    const z = pos.z + Math.sin(aim) * range;

    unit.setTarget(x, z, this.ctx.heightmap);
    // Count it as used the moment it is issued: whether it *succeeds* is
    // only knowable later (the order simply stops being live), and by then
    // this function has no way to tell a completed drive from an abandoned
    // one. Resetting on arrival instead is what matters — see below.
    unit._advanceAttempt = attempt + 1;

    // Close enough to the real destination usually means the detour worked —
    // *unless* the leg that just ended was itself a blocked failure, in which
    // case proximity proves nothing: a rally point sitting on genuinely
    // unclimbable terrain keeps a unit permanently "close" without ever
    // actually reaching it. Resetting on distance alone in that case erases
    // the fan history on every single call, permanently disabling the
    // escalation this method exists to provide — confirmed directly: a unit
    // 37 units from its rally point racked up tens of thousands of stalled
    // attempts while pinned at attempt 0, grinding on the same climb.
    if (!wasBlocked && Math.hypot(target.x - pos.x, target.z - pos.z) < 40) {
      unit._advanceAttempt = 0;
    }
  }

  /**
   * A point to push toward when nothing hostile has been seen yet: the map
   * centre, nudged so several teams do not all pile onto the exact same
   * coordinate and jam against each other there.
   */
  _advancePoint() {
    const home = this.team.homePoint;
    if (!home) return null;
    // The nudge has to be smaller than a gun's reach, or "everyone converges
    // on the middle" still leaves each team parked in its own pocket just out
    // of range of the others — technically converged, permanently not
    // fighting. Sized off the actual weapon range rather than the map so it
    // stays correct if either is retuned.
    const reach = this.ctx.vehicles.defOf('gun-platform')?.turret?.range ?? 90;
    const spread = reach * 0.35;
    const angle = (this.team.id / Math.max(1, this.ctx.game.teams.length)) * Math.PI * 2;
    return { x: Math.cos(angle) * spread, z: Math.sin(angle) * spread };
  }

  /**
   * Somewhere worth attacking — and, crucially, somewhere this team has
   * actually *seen*.
   *
   * The fog is the whole point of the fair-vision decision: an AI that
   * beelines an enemy base it has never scouted is cheating, however good the
   * result looks. Filtering candidates through this team's own mask is what
   * makes scouting matter for the AI exactly as much as it does for the player.
   */
  _attackTarget() {
    const fog = this.team.fog;
    const threshold = fog?.revealThreshold ?? 0;
    let best = null;
    let bestD = Infinity;
    const home = this.team.homePoint ?? { x: 0, z: 0 };

    const consider = (x, z) => {
      if (fog && fog.seenAt(x, z) < threshold) return; // never scouted: unknown
      const d = Math.hypot(x - home.x, z - home.z);
      if (d < bestD) {
        bestD = d;
        best = { x, z };
      }
    };

    for (const s of this.ctx.structures.instances) {
      if (s.dead || s.teamId === this.team.id || s.def.tags?.includes('decoration')) continue;
      consider(s.x, s.z);
    }
    for (const v of this.ctx.vehicles.instances) {
      if (v.dead || v.teamId === this.team.id) continue;
      // Bases first in spirit: they are what actually ends a match.
      if (v.def.id !== 'base-station') continue;
      consider(v.group.position.x, v.group.position.z);
    }
    return best;
  }

  /** Cheapest not-yet-built structure this team can currently afford, on its own pad. */
  _tryBuildNext(base) {
    const pad = basePad(base, this.ctx);
    if (!pad || !pad.complete) return false;

    for (const def of BUILDABLE_DEFS) {
      if (this.ctx.structures.instanceOf(def.id, this.team.id)) continue;
      if (this.team.credits < (def.cost ?? 0)) continue;
      if (this._buildOnPad(pad, def)) return true;
      // Affordable and not yet built, but no room on this pad — nothing later
      // in the list (pricier) is going to fit either where this didn't.
      return false;
    }
    return false;
  }

  /** The part build-harvester-facility/build-repair-bay's own commands leave
   * to a human's click — see the header comment for why this bypasses them. */
  _buildOnPad(pad, def) {
    const slot = this.ctx.structures.freeSlot(pad, def.footprint);
    if (!slot) return false;
    if (!this.team.spend(def.cost ?? 0)) return false;
    const built = this.ctx.structures.place(def, pad, { x: slot.x, z: slot.z });
    if (!built) {
      // Refunded — canPlaceAt disagreed with freeSlot's own coarser check
      // (rare: something else claimed the spot the same tick).
      this.team.earn(def.cost ?? 0);
      return false;
    }
    return true;
  }

  // ---- scouting: keep the recon unit moving outward, forever ----

  _driveScout(dt) {
    const scout = this._scout();
    if (!scout || scout.mode !== 'mobile' || scout.menuOpen || scout.hasOrder) return;

    const origin = this.team.homePoint ?? { x: 0, z: 0 };
    const spot = findSpawnPointNear(this.ctx.heightmap, origin, {
      minRadius: this.exploreRadius * 0.6,
      maxRadius: this.exploreRadius,
      camera: this.camera,
    });

    if (scout.setTarget(spot.point.x, spot.point.z, this.ctx.heightmap)) {
      this.exploreRadius = Math.min(EXPLORE_RADIUS_MAX, this.exploreRadius + EXPLORE_RADIUS_STEP);
    } else {
      // Water, or too steep — try a different ring next tick rather than
      // spinning on the exact same rejected point every frame.
      this.retryTimer = RETRY_PAUSE;
    }
  }
}
