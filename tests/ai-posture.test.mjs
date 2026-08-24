/**
 * AiCommander's strategic layer: how it measures two armies, when it commits,
 * when it pulls back, and what it does with a base it has just found.
 *
 * Dependency-free, same convention as ai-defense.test.mjs: a plain mock `ctx`
 * shaped like main.js's commandContext, no renderer and no real heightmap.
 * The decision layer is pure arithmetic over def stats, health and positions,
 * so these exercise the real rules rather than a stub.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiCommander, unitPower, valuePerCost, armyPower } from '../src/vehicles/aiCommander.js';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';
import { serialize } from '../src/core/snapshot.js';

const GUN_DEF = VEHICLE_CATALOG.find((d) => d.id === 'gun-platform');
const BASE_DEF = VEHICLE_CATALOG.find((d) => d.id === 'base-station');

const DRY_HEIGHTMAP = { heightAt: () => 10, seaLevelY: 0 };
/** Everything scouted — the permissive case, so a test opts *out* of vision. */
const ALL_SEEN = { revealThreshold: 1, seenAt: () => 1 };
const NONE_SEEN = { revealThreshold: 1, seenAt: () => 0 };

function makeCtx({ structures = [], vehicles = [] } = {}) {
  return {
    game: { difficulty: { id: 'normal' }, teams: [{}, {}] },
    vehicles: { instances: vehicles, active: null, defOf: (id) => VEHICLE_CATALOG.find((d) => d.id === id) },
    structures: { instances: structures },
    heightmap: DRY_HEIGHTMAP,
  };
}

function makeCommander(ctx, overrides = {}) {
  const team = {
    id: 1,
    defeated: false,
    homePoint: { x: 0, z: 0 },
    fog: ALL_SEEN,
    credits: 10000,
    ...overrides,
  };
  return new AiCommander({ team, buildDelaySeconds: 0, ctx, camera: null });
}

function makeUnit({ def = GUN_DEF, teamId = 1, x = 0, z = 0, health = def.maxHealth } = {}) {
  return {
    teamId,
    def,
    health,
    dead: false,
    mode: 'armed',
    hasOrder: false,
    combatTarget: null,
    repair: null,
    group: { position: { x, y: 0, z } },
    setTarget() {
      this.hasOrder = true;
      return true;
    },
    arrive() {
      this.hasOrder = false;
    },
  };
}

// ---- the power metric itself ----

test('unitPower is zero for anything without a gun', () => {
  assert.equal(unitPower(BASE_DEF), 0, 'a base station is not a threat');
  assert.equal(unitPower({ maxHealth: 9999 }), 0, 'health alone is not power');
  assert.ok(unitPower(GUN_DEF) > 0);
});

test('unitPower rates damage output and durability together, not either alone', () => {
  const glassCannon = { turret: { damage: 100, fireInterval: 1 }, maxHealth: 10 };
  const toughPopgun = { turret: { damage: 1, fireInterval: 1 }, maxHealth: 1000 };
  // Same product, deliberately: the metric says these are worth the same,
  // which is the whole reason it multiplies rather than picking one axis.
  assert.equal(unitPower(glassCannon), unitPower(toughPopgun));
});

test('armyPower discounts a wounded army', () => {
  const full = [makeUnit()];
  const half = [makeUnit({ health: GUN_DEF.maxHealth / 2 })];
  assert.equal(armyPower(half), armyPower(full) / 2);
});

test('valuePerCost is power per credit and ignores unbuyable defs', () => {
  assert.equal(valuePerCost(GUN_DEF), unitPower(GUN_DEF) / GUN_DEF.cost);
  assert.equal(valuePerCost({ turret: { damage: 10, fireInterval: 1 }, maxHealth: 10, cost: 0 }), 0);
});

// ---- the attack gate: a ratio, not a headcount ----

test('holds at mass when the enemy is stronger than the attack margin allows', () => {
  const mine = [makeUnit({ teamId: 1 }), makeUnit({ teamId: 1 })];
  // Three identical enemy units against two: ratio 0.67, above the retreat
  // floor but nowhere near the 1.25 needed to commit.
  const theirs = [makeUnit({ teamId: 2 }), makeUnit({ teamId: 2 }), makeUnit({ teamId: 2 })];
  const ctx = makeCtx({ vehicles: [...mine, ...theirs] });
  const ai = makeCommander(ctx);

  ai._updatePosture(mine);

  assert.equal(ai.posture, 'mass');
  assert.equal(ai.enemyStrengthKnown, true, 'it did see them — this is a judgement, not ignorance');
});

test('commits once its own power clears the attack ratio', () => {
  const mine = [makeUnit({ teamId: 1 }), makeUnit({ teamId: 1 }), makeUnit({ teamId: 1 })];
  const theirs = [makeUnit({ teamId: 2, health: GUN_DEF.maxHealth / 2 })];
  const ctx = makeCtx({ vehicles: [...mine, ...theirs] });
  const ai = makeCommander(ctx);

  ai._updatePosture(mine);

  assert.equal(ai.posture, 'attack');
});

test('retreats when badly outmatched', () => {
  const mine = [makeUnit({ teamId: 1 })];
  const theirs = [makeUnit({ teamId: 2 }), makeUnit({ teamId: 2 }), makeUnit({ teamId: 2 })];
  const ctx = makeCtx({ vehicles: [...mine, ...theirs] });
  const ai = makeCommander(ctx);

  ai._updatePosture(mine);

  assert.equal(ai.posture, 'retreat');
});

test('a retreat is not abandoned the moment the ratio ticks back over the floor', () => {
  // Ratio 1.0 — comfortably above the 0.6 that triggered the withdrawal, and
  // still short of the 1.25 needed to turn around. The gap between the two
  // thresholds is the whole hysteresis: collapse them onto one value and this
  // is the case that flaps straight back out at parity.
  const mine = [makeUnit({ teamId: 1 }), makeUnit({ teamId: 1 })];
  const theirs = [makeUnit({ teamId: 2 }), makeUnit({ teamId: 2 })];
  const ctx = makeCtx({ vehicles: [...mine, ...theirs] });
  const ai = makeCommander(ctx);
  ai.posture = 'retreat';

  ai._updatePosture(mine);

  assert.equal(ai.posture, 'mass', 'keeps rebuilding rather than flapping straight back out');
});

test('retreat target is home, not the enemy', () => {
  const ctx = makeCtx();
  const ai = makeCommander(ctx, { homePoint: { x: 42, z: -7 } });
  ai.posture = 'retreat';

  assert.deepEqual(ai._pickArmyTarget(), { x: 42, z: -7 });
});

// ---- the fog still binds ----

test('an unscouted enemy falls back to the flat headcount gate, not a free attack', () => {
  // One unit, and an enemy army of three it has never laid eyes on. Measured
  // strength would be zero — a ratio of Infinity, and an immediate attack.
  // The headcount gate (attackAt is 2 on normal) is what holds it back, which
  // is exactly the behaviour that existed before any of this.
  const mine = [makeUnit({ teamId: 1 })];
  const theirs = [makeUnit({ teamId: 2 }), makeUnit({ teamId: 2 }), makeUnit({ teamId: 2 })];
  const ctx = makeCtx({ vehicles: [...mine, ...theirs] });
  const ai = makeCommander(ctx, { fog: NONE_SEEN });

  ai._updatePosture(mine);

  assert.equal(ai.enemyStrengthKnown, false, 'nothing seen is not the same claim as nothing there');
  assert.equal(ai.enemyStrength, 0);
  assert.equal(ai.posture, 'mass');
});

test('an unscouted enemy opens the headcount gate once there are enough units', () => {
  const mine = [makeUnit({ teamId: 1 }), makeUnit({ teamId: 1 })];
  const ctx = makeCtx({ vehicles: [...mine, makeUnit({ teamId: 2 })] });
  const ai = makeCommander(ctx, { fog: NONE_SEEN });

  ai._updatePosture(mine);

  assert.equal(ai.posture, 'attack', 'unchanged from the pre-strength behaviour');
});

// ---- retreat and heal ----

const BAY_DEF = { id: 'repair-bay', repair: { creditsPerHealth: 1 } };

function makeBay(teamId = 1) {
  return { def: BAY_DEF, mode: 'idle', teamId, x: 0, z: 0, dead: false };
}

test('a unit below the retreat threshold is sent to a repair bay', () => {
  const hurt = makeUnit({ health: GUN_DEF.maxHealth * 0.35 });
  const ctx = makeCtx({ vehicles: [hurt], structures: [makeBay()] });
  const ai = makeCommander(ctx);

  ai._maybeRetreat(hurt);

  assert.ok(hurt.repair, 'handed to repairController through the field it already owns');
  assert.equal(hurt.repair.state, 'to-bay');
});

test('a unit far from the bay drives itself home rather than being handed over', () => {
  // The case a real match found: repairController's driver is a trimmed local
  // one with no pathfinder, and handing it a 400-unit trek leaves the unit
  // stuck in `to-bay` indefinitely. Beyond TERMINAL_RADIUS the commander keeps
  // the wheel and uses the same NavGrid-backed driver the army uses.
  const hurt = makeUnit({ health: GUN_DEF.maxHealth * 0.35, x: 400, z: 0 });
  hurt.hasOrder = true; // an attack order, pointing the wrong way
  const ctx = makeCtx({ vehicles: [hurt], structures: [makeBay()] });
  const ai = makeCommander(ctx);

  ai._maybeRetreat(hurt);

  assert.equal(hurt.repair, null, 'not handed to repairController from out there');
  assert.equal(ai._isRetreating(hurt), true, 'still off the roster while it withdraws');
});

test('a retreating unit drops the attack order it was carrying', () => {
  const hurt = makeUnit({ health: GUN_DEF.maxHealth * 0.35, x: 400, z: 0 });
  hurt.hasOrder = true;
  let cancelled = false;
  hurt.arrive = () => { cancelled = true; hurt.hasOrder = false; };
  const ctx = makeCtx({ vehicles: [hurt], structures: [makeBay()] });

  makeCommander(ctx)._maybeRetreat(hurt);

  assert.equal(cancelled, true, 'otherwise it keeps driving at the enemy while "retreating"');
  assert.equal(hurt.hasOrder, true, 'and a fresh leg toward the bay was issued');
});

test('a retreat is abandoned when there is nowhere to go', () => {
  const hurt = makeUnit({ health: GUN_DEF.maxHealth * 0.35, x: 400, z: 0 });
  const ctx = makeCtx({ vehicles: [hurt], structures: [] });
  const ai = makeCommander(ctx);

  ai._maybeRetreat(hurt);

  assert.equal(ai._isRetreating(hurt), false, 'fighting on beats wandering toward no bay');
});

test('a fully repaired unit rejoins the roster', () => {
  const back = makeUnit({ health: GUN_DEF.maxHealth, x: 400, z: 0 });
  back._aiRetreat = true;
  const ctx = makeCtx({ vehicles: [back], structures: [makeBay()] });
  const ai = makeCommander(ctx);

  ai._maybeRetreat(back);

  assert.equal(ai._isRetreating(back), false);
});

test('a partly repaired unit keeps withdrawing rather than turning around', () => {
  // Above the 0.4 trigger but not yet whole. Releasing here would send it
  // straight back out at 60% health, which is the flap the trigger exists to
  // avoid — and it would arrive needing to retreat again immediately.
  const partial = makeUnit({ health: GUN_DEF.maxHealth * 0.6, x: 400, z: 0 });
  partial._aiRetreat = true;
  const ctx = makeCtx({ vehicles: [partial], structures: [makeBay()] });
  const ai = makeCommander(ctx);

  ai._maybeRetreat(partial);

  assert.equal(ai._isRetreating(partial), true);
});

test('a withdrawal that stops making progress is abandoned', () => {
  const wedged = makeUnit({ health: GUN_DEF.maxHealth * 0.1, x: 400, z: 0 });
  const ctx = makeCtx({ vehicles: [wedged], structures: [makeBay()] });
  const ai = makeCommander(ctx);

  ai._maybeRetreat(wedged, 1);
  assert.equal(ai._isRetreating(wedged), true, 'starts out withdrawing');

  // Never moves. A unit stuck on the way home is worse than one that stayed:
  // it is subtracted from the army the commander is deciding with.
  for (let i = 0; i < 40; i++) ai._maybeRetreat(wedged, 1);

  assert.equal(ai._isRetreating(wedged), false, 'back on the roster, still shooting');
});

test('a withdrawal that is closing on its bay is not abandoned', () => {
  const moving = makeUnit({ health: GUN_DEF.maxHealth * 0.1, x: 400, z: 0 });
  const ctx = makeCtx({ vehicles: [moving], structures: [makeBay()] });
  const ai = makeCommander(ctx);

  for (let i = 0; i < 40; i++) {
    moving.group.position.x -= 5; // actually getting somewhere
    ai._maybeRetreat(moving, 1);
  }

  assert.equal(ai._isRetreating(moving), true, 'progress resets the give-up timer');
});

test('a healthy unit is left alone', () => {
  const fine = makeUnit({ health: GUN_DEF.maxHealth * 0.9 });
  const ctx = makeCtx({ vehicles: [fine], structures: [makeBay()] });
  makeCommander(ctx)._maybeRetreat(fine);
  assert.equal(fine.repair, null);
});

test('a unit the team cannot afford to repair keeps fighting rather than flapping a claim', () => {
  const hurt = makeUnit({ health: GUN_DEF.maxHealth * 0.35 });
  const ctx = makeCtx({ vehicles: [hurt], structures: [makeBay()] });
  const ai = makeCommander(ctx, { credits: 1 });

  ai._maybeRetreat(hurt);

  assert.equal(hurt.repair, null);
});

test('retreating units are excluded from the army the strength ratio is computed over', () => {
  const leaving = makeUnit({ teamId: 1, health: GUN_DEF.maxHealth * 0.35 });
  const holding = makeUnit({ teamId: 1 });
  const theirs = makeUnit({ teamId: 2 });
  const ctx = makeCtx({ vehicles: [leaving, holding, theirs], structures: [makeBay()] });
  const ai = makeCommander(ctx);

  ai._manageArmy(1);

  assert.ok(leaving.repair, 'pulled out');
  // Counting the whole roster gives 1.0 + 0.35 = 1.35 against one full enemy —
  // over the 1.25 margin, and an attack. Counting only what can actually be
  // committed gives 1.0, which is not.
  assert.equal(ai.posture, 'mass', 'does not commit an army that is leaving');
});

test('self-preservation runs regardless of posture', () => {
  const hurt = makeUnit({ teamId: 1, health: GUN_DEF.maxHealth * 0.3 });
  const ctx = makeCtx({ vehicles: [hurt], structures: [makeBay()] });
  const ai = makeCommander(ctx);
  // Not 'attack' — a self-preservation check that only runs in one posture is
  // switched off precisely when a unit most needs it.
  ai.posture = 'economy';

  ai._manageArmy(1);

  assert.ok(hurt.repair);
});

// ---- discovering a base ----

function enemyBaseAt(x, z, teamId = 2) {
  return makeUnit({ def: BASE_DEF, teamId, x, z });
}

test('a newly-found undefended base is struck immediately', () => {
  const mine = [makeUnit({ teamId: 1 })];
  const base = enemyBaseAt(300, 0);
  const ctx = makeCtx({ vehicles: [...mine, base] });
  const ai = makeCommander(ctx);

  ai._updatePosture(mine);

  assert.equal(ai.posture, 'attack');
  assert.deepEqual(ai._pickArmyTarget(), { x: 300, z: 0 });
});

test('the strike fires at most once per enemy team, ever', () => {
  const mine = [makeUnit({ teamId: 1 })];
  const base = enemyBaseAt(300, 0);
  const ctx = makeCtx({ vehicles: [...mine, base] });
  const ai = makeCommander(ctx);

  ai._updatePosture(mine);
  assert.equal(ai.posture, 'attack', 'first sight');

  ai._updatePosture(mine);
  // Second look: no free pass. One gun platform against a lone base is not a
  // ratio that justifies committing on the ordinary arithmetic — the base is
  // unarmed, so enemy power is zero and the headcount gate applies instead.
  assert.equal(ai._opportunisticTarget, null, 'the latch held');
  assert.deepEqual([...ai._foundEnemyBase], [2]);
});

test('a defended base is discovered but not struck', () => {
  const mine = [makeUnit({ teamId: 1 })];
  const base = enemyBaseAt(300, 0);
  const guards = [
    makeUnit({ teamId: 2, x: 310, z: 0 }),
    makeUnit({ teamId: 2, x: 290, z: 0 }),
    makeUnit({ teamId: 2, x: 300, z: 10 }),
  ];
  const ctx = makeCtx({ vehicles: [...mine, base, ...guards] });
  const ai = makeCommander(ctx);

  ai._updatePosture(mine);

  assert.equal(ai._opportunisticTarget, null, 'looked, and thought better of it');
  assert.ok(ai._foundEnemyBase.has(2), 'still counts as discovered — no second look later');
  assert.equal(ai.posture, 'retreat', 'three guns against one is the ordinary arithmetic talking');
});

test('an unscouted base is not discovered at all', () => {
  const mine = [makeUnit({ teamId: 1 })];
  const ctx = makeCtx({ vehicles: [...mine, enemyBaseAt(300, 0)] });
  const ai = makeCommander(ctx, { fog: NONE_SEEN });

  ai._updatePosture(mine);

  assert.equal(ai._foundEnemyBase.size, 0);
  assert.equal(ai._opportunisticTarget, null);
});

// ---- home defence outranks everything ----

test('a threat near home outranks an attack the strength comparison would allow', () => {
  const mine = [makeUnit({ teamId: 1 }), makeUnit({ teamId: 1 }), makeUnit({ teamId: 1 })];
  mine[0].threatUntil = Infinity; // simClock.time is never Infinity — "recent", clock-free
  mine[0].threatFrom = { x: -60, z: 20 };
  const ctx = makeCtx({ vehicles: [...mine, makeUnit({ teamId: 2, health: 1 })] });
  const ai = makeCommander(ctx);

  ai._updatePosture(mine);

  assert.equal(ai.posture, 'defense');
  assert.deepEqual(ai._pickArmyTarget(), { x: -60, z: 20 }, 'heads for where the shooting came from');
});

test('a threat far from home does not pull the army back', () => {
  const mine = [makeUnit({ teamId: 1 }), makeUnit({ teamId: 1 })];
  const scoutedOut = makeUnit({ teamId: 1, x: 900, z: 900 });
  scoutedOut.threatUntil = Infinity;
  scoutedOut.threatFrom = { x: 910, z: 900 };
  const ctx = makeCtx({ vehicles: [...mine, scoutedOut] });
  const ai = makeCommander(ctx);

  ai._updatePosture([...mine, scoutedOut]);

  assert.notEqual(ai.posture, 'defense');
});

// ---- the discovery latch has to survive a save ----

test('serialize carries the discovered-base latch', () => {
  const ctx = makeCtx();
  const ai = makeCommander(ctx);
  ai._foundEnemyBase.add(2);
  ai._foundEnemyBase.add(3);

  const saved = serialize({
    world: { trackMask: null },
    heightmap: { params: {} },
    terraform: { pads: [] },
    vehicles: { instances: [], active: null },
    structures: { instances: [] },
    game: { mode: 'ai', teams: [], aiCommanders: [ai], harvesterAI: null },
  });

  assert.deepEqual(saved.aiCommanders[0].foundEnemyBaseTeamIds, [2, 3]);
  // Without this, loading a save hands every already-found base a second free
  // run at the once-per-team strike.
});

// ---- composition ----
//
// These go through commands.js for real — commandsFor generates a `build-<id>`
// per produced unit and its own `enabled` runs the affordability check — so
// what is under test is the selection the AI actually performs, not a
// paraphrase of it. Only produceUnit is stubbed, since spawning needs a world.

const CHEAP_AND_GOOD = {
  id: 'cheap', name: 'Cheap', tags: ['combat'], cost: 100, maxHealth: 400,
  turret: { damage: 20, fireInterval: 1 },
};
const DEAR_AND_BAD = {
  id: 'dear', name: 'Dear', tags: ['combat'], cost: 900, maxHealth: 100,
  turret: { damage: 5, fireInterval: 2 },
};

function makeFactoryCtx(producedDefs, { owned = [], credits = 10000 } = {}) {
  const built = [];
  const defs = producedDefs;
  const factory = {
    teamId: 1,
    mode: 'idle',
    def: { id: 'armed-factory', produces: defs.map((d) => d.id) },
  };
  // weaponTier is read by the armed factory's own upgrade command, which
  // commandsFor builds alongside the build commands whether or not this test
  // looks at it.
  const team = { id: 1, credits, weaponTier: 0, spend: () => true };
  const ctx = makeCtx({
    structures: [factory],
    vehicles: owned.map((def) => ({ teamId: 1, def, dead: false, group: { position: { x: 0, y: 0, z: 0 } } })),
  });
  // Falls through to the real catalog: an armed factory's own static command
  // list still names gun-platform, and its enabled() resolves that def whether
  // this test cares about it or not.
  ctx.vehicles.defOf = (id) => defs.find((d) => d.id === id) ?? VEHICLE_CATALOG.find((d) => d.id === id);
  ctx.game.teamOf = () => team;
  // No base station in these fixtures, so baseSpawnAnchor falls back to the
  // factory's own spot — which is fine, since produceUnit is stubbed anyway.
  ctx.vehicles.instanceOf = () => null;
  ctx.produceUnit = (def) => built.push(def.id);
  return { ctx, team, built };
}

test('_tryBuildUnit picks the better value-per-cost combat def, not the first listed', () => {
  assert.ok(valuePerCost(CHEAP_AND_GOOD) > valuePerCost(DEAR_AND_BAD), 'premise');
  // Worst listed first, so "first found" and "best" are different answers.
  const { ctx, team, built } = makeFactoryCtx([DEAR_AND_BAD, CHEAP_AND_GOOD]);
  const ai = makeCommander(ctx, team);

  assert.equal(ai._tryBuildUnit('combat', 5), true);
  assert.deepEqual(built, ['cheap']);
});

test('_tryBuildUnit with a single candidate behaves exactly as before', () => {
  const { ctx, team, built } = makeFactoryCtx([DEAR_AND_BAD]);
  const ai = makeCommander(ctx, team);

  assert.equal(ai._tryBuildUnit('combat', 5), true);
  assert.deepEqual(built, ['dear'], 'the only option is still the chosen one');
});

test('_tryBuildUnit skips a better def the team cannot afford', () => {
  const { ctx, team, built } = makeFactoryCtx([DEAR_AND_BAD, CHEAP_AND_GOOD], { credits: 500 });
  const ai = makeCommander(ctx, team);

  assert.equal(ai._tryBuildUnit('combat', 5), true);
  assert.deepEqual(built, ['cheap'], 'affordability is commands.js own gate, still respected');
});

test('_tryBuildUnit respects the per-unit cap', () => {
  const { ctx, team, built } = makeFactoryCtx([CHEAP_AND_GOOD], { owned: [CHEAP_AND_GOOD] });
  const ai = makeCommander(ctx, team);

  assert.equal(ai._tryBuildUnit('combat', 1), false);
  assert.deepEqual(built, []);
});

test('_tryBuildUnit builds one unit per call, not one per candidate', () => {
  const { ctx, team, built } = makeFactoryCtx([DEAR_AND_BAD, CHEAP_AND_GOOD]);
  const ai = makeCommander(ctx, team);

  ai._tryBuildUnit('combat', 5);

  assert.equal(built.length, 1, 'the one-action-per-call contract _manageEconomy chains on');
});
