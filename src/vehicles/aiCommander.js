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

// Difficulty scales how eagerly a team spends on its fleet and how long it
// waits before its first action — the standard skirmish-AI knobs. Keyed by
// AI_DIFFICULTIES' own id (ui/aiDifficultyScreen.js) rather than duplicating
// the tier data here.
const DIFFICULTY_ECONOMY = {
  easy: { harvesterCap: 2, buildInterval: 20 },
  normal: { harvesterCap: 3, buildInterval: 15 },
  hard: { harvesterCap: 4, buildInterval: 11 },
  expert: { harvesterCap: 5, buildInterval: 8 },
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
    this._tryBuildHarvester();
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

  _tryBuildHarvester() {
    const facility = this.ctx.structures.instances.find(
      (s) => s.def.id === 'harvester-facility' && s.teamId === this.team.id && s.mode === 'idle'
    );
    if (!facility) return;
    if (this._ownUnits('crystal-harvester').length >= this.economy.harvesterCap) return;

    const cmd = commandsFor(facility, this.ctx).find((c) => c.id === 'build-harvester');
    if (cmd?.enabledResult === true) cmd.execute(facility, this.ctx);
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
