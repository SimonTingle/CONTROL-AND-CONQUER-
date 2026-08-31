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
 * a facility once, buy a harvester periodically — don't have that shape, so a
 * single retry brake (`retryTimer`) covers them. Scouting is the one exception:
 * a team can own several scout-buggies exploring independently (see `_scouts`),
 * so each gets its own retry/stuck state in `scoutState` — sharing the
 * commander-wide brake would stall every other scout, and every other system,
 * whenever just one of them hit an unreachable point.
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

import { commandsFor, basePad, producedUnitIds } from './commands.js';
// For the tier's price only — the purchase itself goes through
// TEAM_WEAPON_UPGRADE_COMMAND so there is one owner of the cost table.
import { WEAPON_TIERS } from '../core/team.js';
import { findSpawnPointNear } from '../core/pick.js';
import { STRUCTURE_CATALOG } from '../structures/structures.js';
import { simClock } from '../core/simClock.js';
import { TERMINAL_RADIUS } from './facilityControl.js';

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
// defenseCap counts gun-turret + sensor-tower together, the same way
// harvesterCap/combatCap already cap their own unit — a team that never stops
// planting turrets is no more interesting than one that never stops massing
// tanks. Deliberately flat across difficulty rather than scaled like combatCap:
// a fortified perimeter is a one-time investment, not an ongoing arms race.
// reconCap is scouts specifically, now that they no longer draw on combatCap
// (see isArmyUnit). Small on purpose and barely scaled: a team spawns with one
// scout already, so this is an allowance for a second pair of eyes, not a unit
// type to mass. Scouting does real work here — `_scoutedEnemyStrength` gates
// whether the commander commits to an attack at all — but the diagnostic that
// prompted this had teams holding six and seven of them, which bought no extra
// intel and cost the entire army budget.
// maxWeaponTier is how far up WEAPON_TIERS (core/team.js) this difficulty will
// buy. It is the first thing in this table that changes what an AI *does*
// rather than how much or how often — every other knob here scales a number,
// which is why a harder AI has so far been the same AI acting more often. A
// tier is a real capability step: it divides fire interval (combatController)
// and widens craters (craters.js's `1 + 0.12 * weaponTier`).
//
// easy stays at 0 deliberately. Combined with the army fix that made the
// commander field a full roster at all, an easy opponent at tier 3 would be a
// very large jump from the passive AI that shipped before it — 1.9x fire rate
// *and* bigger holes is not an easy match.
const DIFFICULTY_ECONOMY = {
  easy: { harvesterCap: 2, buildInterval: 20, combatCap: 1, attackAt: 2, defenseCap: 1, reconCap: 1, maxWeaponTier: 0 },
  normal: { harvesterCap: 2, buildInterval: 15, combatCap: 3, attackAt: 2, defenseCap: 2, reconCap: 2, maxWeaponTier: 2 },
  hard: { harvesterCap: 2, buildInterval: 11, combatCap: 5, attackAt: 3, defenseCap: 3, reconCap: 2, maxWeaponTier: 3 },
  expert: { harvesterCap: 2, buildInterval: 8, combatCap: 7, attackAt: 3, defenseCap: 3, reconCap: 3, maxWeaponTier: 3 },
};

/**
 * Credits an upgrade must leave behind.
 *
 * Not an arbitrary cushion: it is the cost of a crystal-harvester, the economy
 * unit this commander actually rebuilds when one dies. A tier bought with the
 * last of the treasury speeds up guns the team can no longer afford to keep
 * supplied — and a dead harvester it cannot replace costs far more over the
 * rest of a match than a fire-rate step gains. Stated as the number it is
 * protecting so a catalog price change is visibly the thing to re-check.
 */
const UPGRADE_RESERVE = 600;
const DEFAULT_ECONOMY = DIFFICULTY_ECONOMY.normal;

/**
 * Vehicles that carry the `combat` tag but are recon, not army.
 *
 * `scout-buggy` is tagged `['recon', 'combat']` in the catalog, and that one
 * overlap used to be answered independently in three places — the build
 * budget, the build-candidate scan, and `_manageArmy` — which is exactly how
 * they came to disagree. See `isArmyUnit`.
 */
const RECON_ONLY_IDS = new Set(['scout-buggy']);

/**
 * Is this def part of the *army* — the roster `combatCap` budgets for, the one
 * `_manageArmy` will actually send somewhere?
 *
 * The single answer to that question, deliberately. Before this existed,
 * `_tryBuildUnit` counted every combat-tagged unit against `combatCap` while
 * `_manageArmy` filtered `id !== 'scout-buggy'` — so scouts *spent* the army
 * budget but could never *be* the army. The previous pass knew about the
 * overlap and predicted the cost as "6 tanks at expert, not 7". A 41-minute
 * four-AI diagnostic showed the real cost is total: because build candidates
 * are filtered to whatever is affordable *this instant* (`enabled()` tests
 * credits and nothing else), and a scout is 350cr against a gun platform's
 * 650, the scout is the only enabled combat candidate on every tick the team
 * holds 350-649cr. It wins that race repeatedly, and each win permanently
 * spends a point of the budget on a unit the commander refuses to field.
 * Result across four AI teams: 23 scouts, one gun platform, zero tanks, and
 * `_manageArmy` early-returning on `army.length === 0` for the whole match —
 * taking `_updatePosture`, `_pickArmyTarget` and `_advanceUnit` with it.
 *
 * Exported so the agreement between the budget and the army is testable
 * rather than merely commented.
 */
export function isArmyUnit(def) {
  return !!def?.tags?.includes('combat') && !RECON_ONLY_IDS.has(def.id);
}

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
// How long the scout may go without reaching a genuinely new explore point
// before the search sweep is rotated to offer somewhere else. Long enough that
// a legitimately distant target (the ring reaches 480 units out) is not
// abandoned mid-journey, short enough that a pinned scout is not left grinding.
const SCOUT_STUCK_TIMEOUT = 25; // seconds
// Irrational-ish fraction of a turn, so successive rotations keep landing on
// fresh compass points instead of cycling through a short repeating set.
const SCOUT_ANGLE_STEP = 2.399; // radians (~137.5°, the golden angle)

// Field-engineer deploy ring, centred on the team's home point rather than
// the base's live position — a deployed base's own disc is already covered
// by its own buildings; perimeter defence goes further out. Sized off the
// defense structures' own reach: gun-turret's 74u range and sensor-tower's
// 115u sight, so the ring lands somewhere that actually extends the team's
// covered ground instead of overlapping the base or missing both. The
// minimum also doubles as the floor _driveOneEngineer checks before letting
// an engineer deploy in place — see that method for why that matters.
const DEFENSE_MIN_RADIUS = 55;
const DEFENSE_MAX_RADIUS = 140;

// ---- how strong is that, really -------------------------------------------
//
// The whole strategic layer below rests on being able to compare two forces
// without knowing what is in them. Every one of these reads only fields that
// exist on every def in the game — and, critically, on structures too:
// gun-turret carries the identical `turret` block a vehicle does, by design
// (structures.js: "the same block a vehicle's turret reads"). So a turret
// counts toward a base's defences with no special case, and a vehicle nobody
// has designed yet counts the moment it exists. Nothing here is keyed by id.

/**
 * A def's combat worth: sustained damage output multiplied by how long it can
 * keep putting it out. Zero for anything unarmed, which is what makes a
 * harvester or an engineer contribute nothing to an army-strength comparison
 * without needing to be filtered out by name first.
 *
 * The product is the point. DPS alone rates a glass cannon and a durable gun
 * identically; health alone rates a harvester as a threat.
 */
export function unitPower(def) {
  const t = def?.turret;
  if (!t?.damage || !t?.fireInterval) return 0;
  return (t.damage / t.fireInterval) * (def.maxHealth ?? 0);
}

/** Power per credit — the only ranking used when choosing what to build. */
export function valuePerCost(def) {
  const cost = def?.cost ?? 0;
  if (cost <= 0) return 0;
  return unitPower(def) / cost;
}

/**
 * What a live force is worth right now, not what it was worth at full health.
 *
 * The health weighting is what makes pulling a damaged unit off the line
 * actually change the arithmetic rather than just the roster — a half-dead
 * army reads as half an army, which is the honest answer to "can we win this."
 */
export function armyPower(units) {
  let total = 0;
  for (const u of units) {
    const max = u.def?.maxHealth ?? 0;
    if (max <= 0) continue;
    total += unitPower(u.def) * Math.max(0, Math.min(1, (u.health ?? max) / max));
  }
  return total;
}

// Commit only with a real margin; withdraw only when genuinely outmatched.
// The gap between them is hysteresis, and it is not optional: with a single
// threshold an army sitting near parity advances, takes one casualty, drops
// under, withdraws, heals, advances — forever, without ever fighting.
const ATTACK_STRENGTH_RATIO = 1.25;
const RETREAT_STRENGTH_RATIO = 0.6;
// Pull a damaged unit back earlier than repairController's generic 0.3
// backstop, but not as eagerly as harvesterAI's own 0.5 — a combat unit is
// supposed to be shot at, a harvester is not.
const RETREAT_HEALTH_FRACTION = 0.4;
// Below this much defensive power near a freshly-scouted enemy base, it is
// worth a try regardless of what the wider strength comparison says. Roughly
// one gun turret's worth (420 health, 20 damage / 1.5s ≈ 5600) — so an
// undefended or barely-defended base qualifies and a fortified one does not.
const WEAK_BASE_DEFENSE_THRESHOLD = 5000;
// A withdrawal that stops closing on its bay is abandoned, so a unit wedged on
// the way home is not subtracted from the army for the rest of the match. Same
// bounded-retry idea as SCOUT_STUCK_TIMEOUT, and long enough that a genuinely
// distant bay (a retreat can start hundreds of units out) is not given up on
// mid-journey. PROGRESS_EPSILON matches repairController's own.
const WITHDRAW_STUCK_TIMEOUT = 30; // seconds without getting closer
const WITHDRAW_PROGRESS_EPSILON = 0.5; // world units that count as "closer"
// And having given up, stay given up for a beat. Without this the health
// trigger simply re-fires on the very next tick and the unit is right back off
// the roster, having gained nothing — the same claim/bail loop
// repairController's own AUTO_REPAIR_RETRY_COOLDOWN exists to stop.
const WITHDRAW_RETRY_COOLDOWN = 20; // seconds of fighting on before trying again

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
    // _manageArmy's target pick (an O(all structures + all vehicles) scan)
    // is cached here and only refreshed every ARMY_TARGET_INTERVAL — see
    // that method's comment for why running it unthrottled, every frame,
    // for every AI team was a real perf problem.
    this.armyTargetTimer = 0;
    this.armyTarget = null;
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
    // Scout exploration, one entry per scout-buggy (a team can own more than
    // one — see _scouts). stuckTimer/angleOffset rotate findSpawnPointNear's
    // deterministic sweep when a scout stops getting anywhere; lastPoint is
    // what tells "chose somewhere new" from "handed the same point back" —
    // see _driveOneScout. exploreRadius stays commander-level: it tracks how
    // far the team as a whole has pushed its search ring, shared by design so
    // a second scout continues widening from where the first left off rather
    // than re-exploring the same near ring.
    this.scoutState = new Map();
    // One entry per owned field-engineer, same shape and reasoning as
    // scoutState: a team can be walking more than one engineer to a deploy
    // site at once, and one going stuck must not stall another's order or
    // rotate its search sweep.
    this.engineerState = new Map();

    // What the commander currently thinks it is doing. Recomputed every tick
    // by _updatePosture — this field is the *result* of that decision, not
    // state that persists a choice, which is why it is not snapshotted.
    this.posture = 'economy';
    // Last computed strengths, kept only so the tests and any future HUD can
    // read what the decision was made on. Same reasoning as posture: derived.
    this.myStrength = 0;
    this.enemyStrength = 0;
    this.enemyStrengthKnown = false;
    // Enemy teams whose base this commander has already scouted. Latched —
    // it only ever grows — and that is exactly what makes the opportunistic
    // strike a one-time opportunity rather than a permanently different
    // attack rule. Snapshotted for the same reason exploreRadius is.
    this._foundEnemyBase = new Set();

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
    this._driveEngineer(dt);
    this._manageBase(dt);
    this._manageEconomy(dt);
    this._manageArmy(dt);
  }

  // ---- own units, re-resolved fresh every call — see the header comment ----

  _ownUnits(defId) {
    return this.ctx.vehicles.instances.filter((v) => v.teamId === this.team.id && v.def.id === defId);
  }

  _base() {
    return this._ownUnits('base-station')[0] ?? null;
  }

  _scouts() {
    return this._ownUnits('scout-buggy');
  }

  /** Live units of this team carrying `tag` — the roster a tag-level cap is
   * a budget for. Id-agnostic, so a future or author-built vehicle counts
   * against the same allowance the moment it carries the tag. */
  _ownUnitsWithTag(tag) {
    return this.ctx.vehicles.instances.filter(
      (v) => v.teamId === this.team.id && !v.dead && v.def.tags?.includes(tag)
    );
  }

  /** This team's live army — what `combatCap` budgets for and `_manageArmy`
   * commits. Both read `isArmyUnit`, so the budget and the roster it funds
   * cannot drift apart the way they did before that predicate existed. */
  _ownArmyUnits() {
    return this.ctx.vehicles.instances.filter(
      (v) => v.teamId === this.team.id && !v.dead && isArmyUnit(v.def)
    );
  }

  /** This team's already-deployed defenses — gun-turret and sensor-tower
   * together, the same grouping defenseCap counts them under. */
  _ownDefenses() {
    return this.ctx.structures.instances.filter(
      (s) => s.teamId === this.team.id && !s.dead && s.def.tags?.includes('defense')
    );
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
    // Defense sits between the two: cheaper and more one-off than the ongoing
    // combat cap, but only worth a look once the harvester cap is already met.
    // Recon sits last, below the army, now that it has its own cap rather than
    // drawing on `combatCap`. Ordering it after combat is the whole point: a
    // scout is the cheapest thing on the list, so anywhere earlier in the
    // chain it wins the affordability race on every tick the team is between
    // paydays and the army never gets funded — which, with a shared budget,
    // is precisely how the AI ended up with 23 scouts and no tanks.
    // Weapon tiers sit *after* combat, and that placement is the whole
    // escalation mechanic — no timer, no separate schedule. `_tryBuildUnit`
    // returns false precisely when the army is at `combatCap`, so the chain
    // reaches an upgrade exactly when there is nothing better left to buy.
    // Lose a tank and the army drops below cap, so the next tick rebuilds it
    // instead: replacement outranks escalation for free, which is the right
    // priority and would have taken explicit code to express any other way.
    //
    // Ahead of recon because a fire-rate tier is worth more than a second
    // scout.
    //
    // Not, however, a fix for the AI's hoarding, and worth saying so here so
    // nobody assumes it was: all three tiers together cost 5,200, against a
    // strong team's 43,000+ match income. Measured, a team that ended at
    // 29,109 idle credits before this existed ended at 27,891 after — it buys
    // its tiers and goes right back to accumulating. A treasury that large
    // wants a sink that scales (repairs, reinforcements, a second base), which
    // is its own piece of work.
    if (!this._tryBuildUnit('economy', this.economy.harvesterCap)) {
      if (!this._manageDefense()) {
        if (!this._tryBuildUnit('combat', this.economy.combatCap)) {
          if (!this._tryUpgradeWeapons()) {
            this._tryBuildUnit('recon', this.economy.reconCap);
          }
        }
      }
    }
  }

  /**
   * Queue one field-engineer, if this team's defenses (built + already
   * walking to be built) are still under defenseCap.
   *
   * Counts in-flight engineers against the cap, not just finished
   * structures — otherwise a 15s buildInterval spent watching one engineer
   * walk its ~100+ unit ring queues a second and third before the first ever
   * plants anything, blowing straight past the cap the moment they all land.
   * Same one-action-per-tick contract as _tryBuildUnit, so the caller can
   * chain it the same way.
   */
  _manageDefense() {
    const built = this._ownDefenses().length;
    const engineers = this._ownUnits('field-engineer').length;
    if (built + engineers >= this.economy.defenseCap) return false;
    return this._tryBuildUnit('support', engineers + 1);
  }

  /**
   * Build one unit carrying `tag`, if under the cap and affordable.
   *
   * Reads the produced defs off whatever this team's structures actually
   * offer, so a new unit added to any structure's `produces` list is picked
   * up here with no change: the AI asks "what do I have that is tagged
   * combat", never "build a gun-platform".
   *
   * Among several buildable candidates carrying the tag, combat units are
   * ranked by value per credit rather than taken in whatever order the
   * catalog happens to list them. That ordering was arbitrary all along — it
   * simply never showed, because exactly one combat-tagged vehicle exists
   * today. The vehicle builder makes a second one routine.
   *
   * Strictly higher wins, so a tie keeps the first found and today's single
   * candidate produces byte-for-byte the old behaviour. Economy and support
   * builds are not scored at all: value-per-cost is a combat metric, a
   * harvester's power is zero, and ranking engineers by their guns is
   * meaningless.
   */
  _tryBuildUnit(tag, cap) {
    if (cap <= 0) return false;
    // `combatCap` is a budget for the *army*, so it counts every combat-tagged
    // unit rather than each id separately. Per-id was silently a per-type
    // allowance: once gun-platform hit 7, the scout-buggy — which also carries
    // the 'combat' tag, and which `_manageArmy` then explicitly refuses to
    // field — became the only candidate left and got bought up to 7 as well.
    // A 44-minute match ended with every working AI team holding exactly 7 of
    // each, ~2,450cr apiece spent on units it had already decided were not
    // army. Checked once, before the scan: it is a question about the team,
    // not about any one candidate.
    //
    // Only `combat`. `economy` keeps the per-id cap deliberately — with two
    // harvester types that yields 4 harvesters against a cap of 2, and that
    // surplus is a large part of why the AI economies that *do* work, work
    // (the strongest team's 20,800cr came from four harvesters). Making it
    // tag-level here would halve their income inside the very change meant to
    // repair income. It wants its own measured balance pass, not a drive-by.
    //
    // Scouts are excluded from both the count and the candidate scan below,
    // via the one `isArmyUnit` predicate `_manageArmy` also uses. They get
    // their own `reconCap` instead. The earlier version of this line counted
    // them, on the reading that a shared budget honestly costs "6 tanks at
    // expert, not 7" — see isArmyUnit for why the real cost turned out to be
    // every tank, always.
    if (tag === 'combat' && this._ownArmyUnits().length >= cap) return false;

    let bestStructure = null;
    let bestCmd = null;
    let bestScore = -Infinity;

    for (const s of this.ctx.structures.instances) {
      if (s.teamId !== this.team.id || s.mode !== 'idle') continue;
      // Not `s.def.produces` directly: an author-built vehicle names its
      // factory in `producedBy` and never appears in that array, so reading it
      // raw would make the AI blind to every custom unit.
      for (const unitId of producedUnitIds(s.def, this.ctx)) {
        const def = this.ctx.vehicles.defOf(unitId);
        if (!def?.tags?.includes(tag)) continue;
        // A scout carries the `combat` tag, so without this it would still be
        // a candidate here — and now that it no longer counts against
        // `combatCap`, an uncapped one. It is bought under `recon` instead,
        // where the per-id cap below applies to it normally.
        if (tag === 'combat' && !isArmyUnit(def)) continue;
        if (tag !== 'combat' && this._ownUnits(unitId).length >= cap) continue;

        const cmd = commandsFor(s, this.ctx).find((c) => c.id === `build-${unitId}`);
        if (cmd?.enabledResult !== true) continue;

        const score = tag === 'combat' ? valuePerCost(def) : 0;
        if (score > bestScore) {
          bestScore = score;
          bestCmd = cmd;
          bestStructure = s;
        }
        // Non-combat tags never beat the first candidate found (every score is
        // 0), so stop looking the moment one is viable — the old behaviour.
        if (tag !== 'combat') break;
      }
      if (bestCmd && tag !== 'combat') break;
    }

    if (!bestCmd) return false;
    bestCmd.execute(bestStructure, this.ctx);
    return true;
  }

  /**
   * Buy the next weapon tier, if this difficulty still allows one and the
   * treasury can stand it.
   *
   * The upgrade itself is not reimplemented here — `TEAM_WEAPON_UPGRADE_COMMAND`
   * (commands.js) already owns the cost table, the max-tier check and the
   * spend, and it is the same command the player's radial menu fires. This
   * only decides *whether the AI wants to*, which was the entire gap: the
   * command has always existed and nothing on the AI side ever called it, so
   * `weaponTier` stayed 0 on every AI team for whole matches. See
   * docs/plans/ai-strategy-genre-audit.md.
   *
   * Same one-action-per-tick contract as `_tryBuildUnit`/`_manageDefense`, so
   * `_manageEconomy` can chain it the same way.
   */
  _tryUpgradeWeapons() {
    // `weaponTier` is a count of tiers already bought, so this reads as "has
    // this difficulty spent its allowance". It covers easy's cap of 0 without
    // a separate early-out — `0 >= 0` refuses, and a difficulty that somehow
    // omits the knob defaults to 0 and refuses too. An explicit `maxTier <= 0`
    // guard was written here first and removed once a negative control showed
    // it could never change an outcome.
    const maxTier = this.economy.maxWeaponTier ?? 0;
    if (this.team.weaponTier >= maxTier) return false;

    for (const s of this.ctx.structures.instances) {
      if (s.teamId !== this.team.id || s.mode !== 'idle') continue;
      const cmd = commandsFor(s, this.ctx).find((c) => c.id === 'upgrade-weapons');
      // `enabledResult` covers affordability and the catalog's own max tier;
      // the reserve below is this commander's own, stricter, question.
      if (cmd?.enabledResult !== true) continue;

      const cost = WEAPON_TIERS[this.team.weaponTier]?.cost;
      if (cost == null) return false;
      if (this.team.credits < cost + UPGRADE_RESERVE) return false;

      cmd.execute(s, this.ctx);
      return true;
    }
    return false;
  }

  // ---- army: arm what it builds, and send it at something it can see ----

  // How often the army's target (attack-target scan, or fallback advance
  // point) is recomputed. This is the throttle that matters: "where should
  // the army be heading" doesn't need per-frame freshness the way turret
  // acquisition does (combatController has its own, separate, much shorter
  // throttle for that) — but _attackTarget's O(all structures + all
  // vehicles) scan running unthrottled, every frame, for every AI team was a
  // real cost that scaled with both team count and match size. A ~1.5s lag
  // on army orders is imperceptible; 60 full-map scans a second per team is
  // not free.
  static ARMY_TARGET_INTERVAL = 1.5;

  _manageArmy(dt) {
    // Same predicate the build budget uses — this filter used to spell the
    // scout exclusion out by id here while `_tryBuildUnit` spelled the
    // opposite answer out there. See isArmyUnit.
    const army = this._ownArmyUnits();
    if (army.length === 0) {
      this.posture = 'economy';
      return;
    }

    // Armed is the capability gate combatController reads, and arming costs
    // mobility — so it happens once, on production, not per tick.
    for (const unit of army) {
      if (unit.mode === 'mobile') unit.mode = 'armed';
    }

    // Self-preservation runs unconditionally, for every unit, whatever the
    // commander happens to be doing. A retreat that only happens while the
    // commander is in a particular mood is not self-preservation — and the
    // one moment a unit most needs pulling out is mid-attack, which is
    // precisely when a posture-gated check would be switched off.
    for (const unit of army) this._maybeRetreat(unit, dt);

    // The roster every decision below is actually made over. A unit already
    // limping to a repair bay is not available to commit, and counting it is
    // how an AI talks itself into an attack with an army that is leaving.
    const committable = army.filter((u) => !this._isRetreating(u));

    this._updatePosture(committable);
    if (this.posture === 'economy' || this.posture === 'mass') return;

    this.armyTargetTimer -= dt;
    if (this.armyTargetTimer <= 0 || this._forceRetarget) {
      this.armyTargetTimer = AiCommander.ARMY_TARGET_INTERVAL;
      this._forceRetarget = false;
      this.armyTarget = this._pickArmyTarget();
    }
    const target = this.armyTarget;
    if (!target) return;

    for (const unit of committable) {
      // Never re-order a unit already engaging something — combatController
      // owns the shooting, and re-targeting mid-fight just makes it drive in
      // circles under fire.
      if (unit.combatTarget || unit.hasOrder) continue;
      this._advanceUnit(unit, target);
    }
  }

  /**
   * Where the army should be heading, given what it has decided to do.
   *
   * `retreat` goes home — the one posture with a destination of its own.
   * `defense` heads for wherever the shooting came from, which
   * combatController already recorded on whatever it hit. Everything else
   * falls through to the original behaviour: somewhere scouted and worth
   * hitting, or — failing that — forward.
   *
   * That fallback is load-bearing and predates this change. An army that only
   * ever moves toward *known* enemies never moves at all on a large map: the
   * lone scout rarely ranges far enough to reveal another team's base before
   * the army is built, so every unit sits at home guarding nothing. Advancing
   * on the island's middle keeps the fair-vision rule completely intact — it
   * is not homing on anything it cannot see — while guaranteeing that four
   * teams pushing outward eventually meet. The units carry their own sight
   * radius, so the advance *is* the reconnaissance.
   */
  _pickArmyTarget() {
    const home = this.team.homePoint;
    if (this.posture === 'retreat') return home ? { x: home.x, z: home.z } : null;
    if (this.posture === 'defense') {
      const from = this._homeThreatOrigin();
      if (from) return from;
    }
    if (this._opportunisticTarget) return this._opportunisticTarget;
    return this._attackTarget() ?? this._advancePoint();
  }

  /**
   * Decide what this commander is doing, in strict priority order.
   *
   * The order is the design. Defence first because an army marching on the far
   * side of the map while its own base is shelled is the one outcome that is
   * unambiguously wrong, whatever the strength arithmetic says about it.
   */
  _updatePosture(committable) {
    this._opportunisticTarget = null;

    if (this._homeUnderThreat()) {
      this.posture = 'defense';
      this._forceRetarget = true;
      return;
    }

    if (this._checkOpportunisticStrike(committable)) {
      this.posture = 'attack';
      this._forceRetarget = true;
      return;
    }

    if (committable.length === 0) {
      this.posture = 'economy';
      return;
    }

    const mine = armyPower(committable);
    const { power: theirs, known } = this._scoutedEnemyStrength();
    this.myStrength = mine;
    this.enemyStrength = theirs;
    this.enemyStrengthKnown = known;

    // Nothing scouted means nothing to compare against — and a naive ratio
    // would read the resulting zero as "the enemy is defenceless, go now,"
    // which is the fair-vision rule broken from the opposite direction. Fall
    // back to the flat headcount gate that has always governed this case.
    if (!known) {
      this.posture = committable.length >= this.economy.attackAt ? 'attack' : 'mass';
      return;
    }

    const ratio = theirs > 0 ? mine / theirs : Infinity;

    if (ratio <= RETREAT_STRENGTH_RATIO) {
      this.posture = 'retreat';
      this._forceRetarget = true;
      return;
    }

    // Everything between the two thresholds is `mass`, and that band *is* the
    // hysteresis — an army that withdrew at 0.6 has to reach 1.25 to turn
    // around, not merely claw back over 0.6. No separate "was retreating"
    // clause is needed for that; one was written here first and the negative
    // control proved it could never change an outcome.
    //
    // No headcount term here on purpose. `attackAt` is the *unscouted*
    // fallback, above — re-applying it once the enemy has actually been
    // measured makes the measurement unable to change any decision the
    // headcount would not have made anyway, which is the second thing the
    // negative controls caught. A force with a 1.25x power margin over
    // everything it has seen has earned the commitment whether that is three
    // units or one.
    this.posture = ratio >= ATTACK_STRENGTH_RATIO ? 'attack' : 'mass';
  }

  /**
   * How much force this team has actually *seen* the enemy field.
   *
   * Same fog test `_attackTarget` applies, for the same reason: an AI that
   * weighs an army it has never scouted is cheating however good the result
   * looks. Reveal is monotonic (fogOfWar: "a mask is monotonically
   * non-decreasing, so revealing is permanent"), so this is memory of what
   * was scouted rather than live vision — no new intel-staleness concept.
   *
   * `known` is the load-bearing half of the return. Zero power means "nothing
   * seen," which is not the same claim as "nothing there," and the caller has
   * to be able to tell them apart.
   */
  _scoutedEnemyStrength() {
    const fog = this.team.fog;
    const threshold = fog?.revealThreshold ?? 0;
    const seen = [];

    for (const v of this.ctx.vehicles.instances) {
      if (v.dead || v.teamId === this.team.id) continue;
      const p = v.group.position;
      if (fog && fog.seenAt(p.x, p.z) < threshold) continue;
      seen.push(v);
    }
    for (const s of this.ctx.structures.instances) {
      if (s.dead || s.teamId === this.team.id) continue;
      if (fog && fog.seenAt(s.x, s.z) < threshold) continue;
      seen.push(s);
    }

    return { power: armyPower(seen), known: seen.length > 0 };
  }

  /**
   * A hostile base scouted for the first time and not meaningfully defended.
   *
   * Fires at most once per enemy team, ever — that latch is the entire safety
   * property. Without it a base that simply stays weak re-triggers the
   * override every tick, which is not seizing an opportunity, it is just a
   * permanently different attack rule bypassing the strength comparison. With
   * it, an AI that catches an undefended base early punishes it, and one that
   * finds a fortified base goes back to the ordinary arithmetic and never
   * gets another free pass at that team.
   */
  _checkOpportunisticStrike(committable) {
    if (committable.length === 0) return false;
    const fog = this.team.fog;
    const threshold = fog?.revealThreshold ?? 0;

    for (const v of this.ctx.vehicles.instances) {
      if (v.dead || v.teamId === this.team.id) continue;
      if (v.def.id !== 'base-station') continue;
      if (this._foundEnemyBase.has(v.teamId)) continue;
      const p = v.group.position;
      if (fog && fog.seenAt(p.x, p.z) < threshold) continue;

      // Latch on discovery, not on the decision to strike: this base has now
      // been found, and whether it happened to be weak at this instant is not
      // something to keep re-asking.
      this._foundEnemyBase.add(v.teamId);
      if (this._nearbyDefensePower(v.teamId, p) >= WEAK_BASE_DEFENSE_THRESHOLD) continue;
      this._opportunisticTarget = { x: p.x, z: p.z };
      return true;
    }
    return false;
  }

  /**
   * Armed strength a team has standing near a point — turrets and units alike,
   * since unitPower reads the same turret block off both.
   *
   * Uses the same radius this commander's own engineers deploy within, so
   * "near the base" means the same thing on both sides of the map.
   */
  _nearbyDefensePower(teamId, pos) {
    const near = [];
    for (const s of this.ctx.structures.instances) {
      if (s.dead || s.teamId !== teamId) continue;
      if (Math.hypot(s.x - pos.x, s.z - pos.z) > DEFENSE_MAX_RADIUS) continue;
      near.push(s);
    }
    for (const v of this.ctx.vehicles.instances) {
      if (v.dead || v.teamId !== teamId) continue;
      const p = v.group.position;
      if (Math.hypot(p.x - pos.x, p.z - pos.z) > DEFENSE_MAX_RADIUS) continue;
      near.push(v);
    }
    return armyPower(near);
  }

  /**
   * Anything of this team's near home has been shot recently.
   *
   * Reads the threat stamp combatController already writes on every damaged
   * entity — the same field, and the same simClock.time comparison,
   * harvesterAI has been using all along. Never a wall clock.
   */
  _homeUnderThreat() {
    return this._homeThreatOrigin() !== null;
  }

  _homeThreatOrigin() {
    const home = this.team.homePoint;
    if (!home) return null;
    for (const list of [this.ctx.vehicles.instances, this.ctx.structures.instances]) {
      for (const e of list) {
        if (e.dead || e.teamId !== this.team.id) continue;
        if (e.threatUntil == null || simClock.time >= e.threatUntil) continue;
        const p = e.group?.position ?? e;
        if (Math.hypot(p.x - home.x, p.z - home.z) > DEFENSE_MAX_RADIUS) continue;
        const from = e.threatFrom;
        if (from) return { x: from.x, z: from.z };
      }
    }
    return null;
  }

  // ---- retreat and heal ----

  /**
   * Pulled off the line — either still driving itself home, or already handed
   * to repairController. Either way it is not available to commit.
   */
  _isRetreating(unit) {
    return !!unit._aiRetreat || !!unit.repair;
  }

  /**
   * Pull a badly damaged unit off the line, and get it home.
   *
   * The heal itself is entirely repairController's: setting
   * `inst.repair = { bay, state: 'to-bay' }` — the same field the
   * player-facing Repair command sets — hands over the whole
   * queue-dock-repair-leave cycle, including FacilityControl clearance. Its
   * own generic auto-queue would catch these units eventually anyway, at 0.3
   * health; the AI trigger is simply earlier, so a unit leaves while it still
   * has enough health to survive the trip.
   *
   * What is *not* delegated is the long drive, and that distinction was found
   * by watching a real match rather than reasoned out. Handing over
   * immediately looked correct and was not: repairController's driver is
   * deliberately a trimmed local one (its own header says so) with no
   * pathfinder, only six fixed detour angles. That is the right tool for a
   * unit hurt near home, and useless for one 386 units deep in enemy ground —
   * observed sitting at exactly that distance, state `to-bay`, for seventeen
   * straight simulated minutes without ever getting closer, while
   * `_isRetreating` kept it out of the army that would have driven it with
   * `_advanceUnit`'s NavGrid routing. So the long leg stays here, on the
   * better driver, and only the terminal approach is handed over —
   * `TERMINAL_RADIUS` being the boundary FacilityControl itself already draws
   * around a facility.
   */
  _maybeRetreat(unit, dt = 0) {
    if (unit.repair) return; // already handed over; repairController owns it now
    if (unit === this.ctx.vehicles.active) return; // never yank the player's own vehicle
    if (unit._aiRetreatCooldown > 0) {
      unit._aiRetreatCooldown -= dt;
      return;
    }

    const healed = unit.health > unit.def.maxHealth * RETREAT_HEALTH_FRACTION;
    if (!unit._aiRetreat && healed) return;
    if (unit._aiRetreat && unit.health >= unit.def.maxHealth) {
      unit._aiRetreat = null; // repaired and released — back on the roster
      return;
    }

    const bay = this._nearestOwnRepairBay(unit);
    if (!bay) {
      unit._aiRetreat = null; // nowhere to go: fighting on beats wandering
      return;
    }
    if (unit._aiRetreat && this._withdrawalIsStuck(unit, bay, dt)) return;
    // Affordability up front, for the same reason _maybeAutoQueue checks it: a
    // claim the team cannot pay for is dropped by the repair loop on arrival
    // and re-taken the next tick, a flap that never resolves.
    const cost = Math.ceil((unit.def.maxHealth - unit.health) * bay.def.repair.creditsPerHealth);
    if (this.team.credits < cost) {
      unit._aiRetreat = null;
      return;
    }

    const starting = !unit._aiRetreat;
    if (starting) {
      // A fresh attempt is judged on its own progress. Carrying the previous
      // attempt's best distance over would make the new one look stalled from
      // its first tick and give up almost immediately.
      unit._aiRetreatBest = null;
      unit._aiRetreatStuck = 0;
    }
    unit._aiRetreat = true;
    const pos = unit.group.position;
    if (Math.hypot(bay.x - pos.x, bay.z - pos.z) <= TERMINAL_RADIUS) {
      unit.repair = { bay, state: 'to-bay' };
      unit._aiRetreat = null;
      return;
    }
    // Still the long leg. Drive it the way the army drives anywhere else —
    // NavGrid first, widening detour fan as the fallback.
    //
    // The order in flight when a retreat starts is an attack order pointing
    // the wrong way, so it is dropped once here rather than waited out;
    // after that a new leg is only issued when the last one ends, or every
    // tick would overwrite the order mid-drive.
    if (starting && unit.hasOrder) unit.arrive('cancelled');
    if (!unit.hasOrder) this._advanceUnit(unit, { x: bay.x, z: bay.z });
  }

  /**
   * Give up on a withdrawal that is not actually withdrawing.
   *
   * The bounded-retry discipline the rest of this file already applies to
   * scouts (`SCOUT_STUCK_TIMEOUT`) and engineers, applied to the one case that
   * needs it most. A withdrawing unit is subtracted from `committable`, so a
   * unit wedged against terrain on the way home is not merely wasted — it is
   * an army the commander permanently believes it does not have. Observed
   * directly: one gun platform frozen at the same coordinates, order live and
   * never ending, for seventeen simulated minutes.
   *
   * Giving up puts it back on the roster, where `_manageArmy` re-targets it
   * every `ARMY_TARGET_INTERVAL` — a moving destination being the thing most
   * likely to break a wedge, and shooting from where it stands being strictly
   * better than not shooting from where it stands. The health trigger will
   * try again on the next tick, so this backs off rather than disabling.
   */
  _withdrawalIsStuck(unit, bay, dt) {
    const pos = unit.group.position;
    const d = Math.hypot(bay.x - pos.x, bay.z - pos.z);
    if (unit._aiRetreatBest == null || d < unit._aiRetreatBest - WITHDRAW_PROGRESS_EPSILON) {
      unit._aiRetreatBest = d;
      unit._aiRetreatStuck = 0;
      return false;
    }
    unit._aiRetreatStuck = (unit._aiRetreatStuck ?? 0) + dt;
    if (unit._aiRetreatStuck < WITHDRAW_STUCK_TIMEOUT) return false;

    unit._aiRetreat = null;
    unit._aiRetreatBest = null;
    unit._aiRetreatStuck = 0;
    unit._aiRetreatCooldown = WITHDRAW_RETRY_COOLDOWN;
    return true;
  }

  /** Nearest finished repair bay this team owns, or null. */
  _nearestOwnRepairBay(unit) {
    const pos = unit.group.position;
    let best = null;
    let bestD = Infinity;
    for (const s of this.ctx.structures.instances) {
      if (s.def.id !== 'repair-bay' || s.mode !== 'idle' || s.teamId !== this.team.id) continue;
      const d = Math.hypot(s.x - pos.x, s.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
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
    // Every scout-buggy the team owns explores independently — each gets its
    // own stuck-timer/angle-offset/retry state (below) so one scout's stall
    // doesn't rotate another's search sweep or pause its order.
    for (const scout of this._scouts()) {
      this._driveOneScout(scout, dt);
    }
  }

  _driveOneScout(scout, dt) {
    let st = this.scoutState.get(scout);
    if (!st) {
      st = { stuckTimer: 0, angleOffset: 0, lastPoint: null, retryTimer: 0 };
      this.scoutState.set(scout, st);
    }

    // repairController owns a vehicle carrying `repair`, and two controllers
    // steering one vehicle is not a near-miss — it deadlocks both.
    //
    // aiCommander runs before repairController in the tick, so without this
    // an explore order was re-issued every frame the scout had none.
    // repairController's `_driveTo` then saw `hasOrder` and fell through to
    // its stall/no-progress tail, never reaching the `!inst.hasOrder` branch
    // where *both* its detour ladder and its `_leaveBay` give-up live. Its
    // detour counter climbed through the tail's blind increments while the
    // give-up stayed unreachable, so `inst.repair` never cleared: a 44-minute
    // match ended with scouts holding detour counts of 74, 56 and 50 against
    // a six-angle ladder, pinned at the terrain-damage floor, occupying every
    // slot of both AI repair bays.
    //
    // Every other unit type already keeps this invariant — harvesters by
    // mutual exclusion on `def.capacity`, army units via `_maybeRetreat`'s
    // own `if (unit.repair) return;`. Scouts were the only ones without it.
    if (scout.repair) return;

    if (st.retryTimer > 0) {
      st.retryTimer -= dt;
      return;
    }
    if (scout.mode !== 'mobile' || scout.menuOpen) return;

    // Give up on an explore point the scout is not actually reaching.
    //
    // findSpawnPointNear is a deterministic scan, so the same origin and radii
    // return the same point every time — and `exploreRadius` stops changing
    // once it saturates. That combination means a scout which cannot reach its
    // target is re-ordered to the *identical* spot every time it gives up, with
    // nothing to break the tie. Unlike harvesterAI, this driver has no bans and
    // no detours, so it never escalates: traced on a real match, a scout pinned
    // against a 0.815 grade (its limit is 0.8) re-issued the same point for six
    // straight minutes while blocked-damage ground it from full health down to
    // the 15% floor, never moving a single unit.
    //
    // Rotating the sweep is the escalation it was missing. The timer only
    // resets when a genuinely different point is chosen, so reaching one keeps
    // exploration moving while failing to reach one eventually forces a new
    // direction.
    st.stuckTimer += dt;
    if (st.stuckTimer > SCOUT_STUCK_TIMEOUT) {
      st.stuckTimer = 0;
      st.angleOffset += SCOUT_ANGLE_STEP;
      scout.arrive('cancelled'); // drop the doomed order so a new one is issued
    }

    if (scout.hasOrder) return;

    const origin = this.team.homePoint ?? { x: 0, z: 0 };
    const spot = findSpawnPointNear(this.ctx.heightmap, origin, {
      minRadius: this.exploreRadius * 0.6,
      maxRadius: this.exploreRadius,
      angleOffset: st.angleOffset,
      camera: this.camera,
    });

    if (scout.setTarget(spot.point.x, spot.point.z, this.ctx.heightmap)) {
      const last = st.lastPoint;
      if (!last || Math.hypot(spot.point.x - last.x, spot.point.z - last.z) > 1) {
        st.stuckTimer = 0;
        st.lastPoint = { x: spot.point.x, z: spot.point.z };
      }
      this.exploreRadius = Math.min(EXPLORE_RADIUS_MAX, this.exploreRadius + EXPLORE_RADIUS_STEP);
    } else {
      // Water, or too steep — try a different ring next tick rather than
      // spinning on the exact same rejected point every frame.
      st.retryTimer = RETRY_PAUSE;
    }
  }

  // ---- defense: walk a field-engineer out to the perimeter and deploy it ----

  _driveEngineer(dt) {
    // Same independence as _driveScout, for the same reason: _manageDefense
    // caps how many exist, but nothing stops two from being mid-walk at
    // once (one built while an earlier one is still en route), and one
    // going stuck must not stall the other's order or rotate its sweep.
    for (const engineer of this._ownUnits('field-engineer')) {
      this._driveOneEngineer(engineer, dt);
    }
  }

  _driveOneEngineer(engineer, dt) {
    let st = this.engineerState.get(engineer);
    if (!st) {
      st = { stuckTimer: 0, angleOffset: 0, retryTimer: 0 };
      this.engineerState.set(engineer, st);
    }

    if (st.retryTimer > 0) {
      st.retryTimer -= dt;
      return;
    }
    if (engineer.mode !== 'mobile' || engineer.menuOpen) return;

    if (engineer.hasOrder) {
      // Same stuck-timeout escalation _driveOneScout uses: give up on a
      // target that is not actually being reached rather than orbiting it
      // (or grinding on blocked-damage against it) forever.
      st.stuckTimer += dt;
      if (st.stuckTimer > SCOUT_STUCK_TIMEOUT) {
        st.stuckTimer = 0;
        st.angleOffset += SCOUT_ANGLE_STEP;
        engineer.arrive('cancelled'); // drop the doomed order so a new one is issued
        this._sendEngineerToDeploySite(engineer, st);
      }
      return;
    }

    // No order outstanding: either this engineer has never been sent
    // anywhere yet, or it just walked into range of its last target — both
    // read the same way through hasOrder, so the distance floor below is
    // what actually tells them apart. A freshly built engineer starts on
    // the base pad, which deployDefenseCommands' own enabled() never
    // refuses (it only checks for water) — without a floor here, a new
    // engineer would plant its turret at the factory door on its very
    // first tick instead of ever walking to the perimeter.
    const home = this.team.homePoint ?? engineer.group.position;
    const pos = engineer.group.position;
    const farEnough = Math.hypot(pos.x - home.x, pos.z - home.z) >= DEFENSE_MIN_RADIUS;
    const cmd = farEnough ? this._preferredDefenseCommand(engineer) : null;
    if (cmd?.enabledResult === true) {
      cmd.execute(engineer, this.ctx);
      this.engineerState.delete(engineer);
      return;
    }

    this._sendEngineerToDeploySite(engineer, st);
  }

  _sendEngineerToDeploySite(engineer, st) {
    const origin = this.team.homePoint ?? engineer.group.position;
    const spot = findSpawnPointNear(this.ctx.heightmap, origin, {
      minRadius: DEFENSE_MIN_RADIUS,
      maxRadius: DEFENSE_MAX_RADIUS,
      angleOffset: st.angleOffset,
      camera: this.camera,
    });
    if (!engineer.setTarget(spot.point.x, spot.point.z, this.ctx.heightmap)) {
      // Water, or too steep — try a different ring next tick rather than
      // spinning on the exact same rejected point every frame.
      st.retryTimer = RETRY_PAUSE;
    }
  }

  /**
   * Sensor tower first, for the vision it gives everything else this team
   * builds — then gun turrets up to the shared defenseCap. Both draw from
   * the one command list deployDefenseCommands() builds off the 'defense'
   * tag, so a third defense structure added later is offered here with no
   * change beyond adding it to this preference order.
   */
  _preferredDefenseCommand(engineer) {
    const cmds = commandsFor(engineer, this.ctx).filter((c) => c.id.startsWith('deploy-'));
    const haveSensor = this._ownDefenses().some((d) => d.def.id === 'sensor-tower');
    const order = haveSensor
      ? ['deploy-gun-turret', 'deploy-sensor-tower']
      : ['deploy-sensor-tower', 'deploy-gun-turret'];
    for (const id of order) {
      const cmd = cmds.find((c) => c.id === id);
      if (cmd) return cmd;
    }
    return cmds[0] ?? null;
  }
}
