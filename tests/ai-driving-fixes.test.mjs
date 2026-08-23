/**
 * Four defects that a 44-minute expert-difficulty match exposed, each of which
 * stopped an AI unit permanently rather than degrading it.
 *
 * The saved diagnostic is the source for every number quoted below — these are
 * not invented scenarios. See docs/plans/ai-driving-fixes.md.
 *
 * Dependency-free, same convention as ai-posture.test.mjs: real classes driven
 * against plain mocks, no renderer, no heightmap, no network.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AiCommander } from '../src/vehicles/aiCommander.js';
import { HarvesterAI } from '../src/vehicles/harvesterAI.js';
import { RepairController } from '../src/vehicles/repairController.js';
import { FacilityControl, CLEARED, DOCKED } from '../src/vehicles/facilityControl.js';

const DRY_HEIGHTMAP = { heightAt: () => 10, seaLevelY: 0 };

// The real constants these fixes turn on, restated so a change to either side
// is caught here rather than silently reopening the gap.
const DOCK_DISTANCE = 22;
const DOCK_OFFSET = 12; // harvester-facility's dockOffset

// ---------------------------------------------------------------------------
// Fix 1 — the dock dead band
// ---------------------------------------------------------------------------

/**
 * Arrival is measured to the dock; the drift release used to be measured to
 * the building centre. With the dock 12 units out, a harvester could be inside
 * the 22-unit arrival radius and beyond the 33-unit release radius at the same
 * time — and then cycled between the two forever without ever issuing an order.
 */
test('no position can be both arrived and drifted', () => {
  const arriveRadius = DOCK_DISTANCE;
  const releaseRadius = DOCK_DISTANCE * 1.5;

  // Sweep the whole plane a harvester could occupy around a facility at the
  // origin with its dock on +x, at a resolution far finer than the 1.0-unit
  // band the bug lived in.
  let overlaps = 0;
  for (let x = -60; x <= 60; x += 0.25) {
    for (let z = -60; z <= 60; z += 0.25) {
      const toDock = Math.hypot(x - DOCK_OFFSET, z);
      const arrived = toDock <= arriveRadius;
      // Fixed: released against the same reference arrival uses.
      const drifted = toDock > releaseRadius;
      if (arrived && drifted) overlaps++;
    }
  }
  assert.equal(overlaps, 0, 'arrival and release must be mutually exclusive');
});

test('the old centre-based release did overlap, and by ~1 unit', () => {
  // The control for the test above, kept as a test in its own right: it pins
  // *why* the reference point matters instead of leaving it as an assertion
  // about nothing. A point 33.66 from the centre — exactly where the match's
  // frozen harvester sat — is inside the arrival radius and past the old
  // release radius simultaneously.
  const centreDistance = 33.66;
  const toDock = centreDistance - DOCK_OFFSET; // dead ahead of the dock
  assert.ok(toDock <= DOCK_DISTANCE, 'arrived, measured to the dock');
  assert.ok(centreDistance > DOCK_DISTANCE * 1.5, 'drifted, measured to the centre');
  // Width of the band: reachable centre-distance tops out at dock + radius.
  const bandWidth = DOCK_OFFSET + DOCK_DISTANCE - DOCK_DISTANCE * 1.5;
  assert.ok(bandWidth > 0 && bandWidth <= 1.5, `~1 unit wide, got ${bandWidth}`);
});

const FACILITY_DEF = {
  id: 'harvester-facility',
  unloadRate: 80,
  dockOffset: DOCK_OFFSET,
};

function makeFacility({ x = 0, z = 0 } = {}) {
  return {
    id: 1,
    teamId: 1,
    def: FACILITY_DEF,
    mode: 'idle',
    x,
    z,
    dock: { x: x + DOCK_OFFSET, z },
    upgradeLevel: 0,
    group: { userData: {} },
  };
}

function makeHarvester({ x, z, load = 320, teamId = 1 }) {
  return {
    id: 13,
    teamId,
    dead: false,
    def: { id: 'crystal-harvester', capacity: 320, maxHealth: 220, unloadRate: 96 },
    health: 220,
    speed: 0,
    mode: 'mobile',
    repair: null,
    clearance: null,
    group: { position: { x, y: 0, z }, userData: {} },
    _load: load,
  };
}

test('a harvester inside the old dead band unloads instead of ping-ponging', () => {
  // 33.66 from the centre, dead ahead of the dock — the exact geometry the
  // match's frozen harvester was in, carrying a full 320 load and 0 delivered.
  const facility = makeFacility();
  const inst = makeHarvester({ x: 33.66, z: 0 });
  const earned = [];
  const ai = new HarvesterAI({
    vehicles: { instances: [inst] },
    world: { blooms: { nearestTo: () => null } },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [facility] },
    game: { teamOf: () => ({ earn: (n) => earned.push(n), stats: { harvesterEarningsTotal: 0 } }) },
    facilityControl: { markDocked: () => true, statusOf: () => DOCKED, release: () => {} },
  });

  const s = ai._stateFor(inst);
  s.state = 'unloading';
  s.load = 320;

  ai._unload(inst, s, 1);

  assert.notEqual(s.state, 'to-base', 'must not bounce straight back out');
  assert.ok(earned.length > 0, 'credits actually delivered');
  assert.ok(s.load < 320, 'load decremented');
});

test('a harvester genuinely off the dock still releases', () => {
  // The drift check must keep working — this is the behaviour it exists for.
  const facility = makeFacility();
  const inst = makeHarvester({ x: 90, z: 0 }); // 78 from the dock, well past 33
  const released = [];
  const ai = new HarvesterAI({
    vehicles: { instances: [inst] },
    world: { blooms: { nearestTo: () => null } },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [facility] },
    game: { teamOf: () => ({ earn: () => {}, stats: {} }) },
    facilityControl: { markDocked: () => true, statusOf: () => DOCKED, release: (i) => released.push(i) },
  });

  const s = ai._stateFor(inst);
  s.state = 'unloading';
  s.load = 320;

  ai._unload(inst, s, 1);

  assert.equal(s.state, 'to-base', 'drifted vehicles still give the dock up');
  assert.equal(s.load, 320, 'nothing unloaded from out there');
});

// ---------------------------------------------------------------------------
// Fix 2 — two controllers driving one scout
// ---------------------------------------------------------------------------

function makeScout({ repair = null } = {}) {
  const scout = {
    id: 4,
    teamId: 1,
    dead: false,
    def: { id: 'scout-buggy', tags: ['recon', 'combat'], maxHealth: 100 },
    health: 15,
    mode: 'mobile',
    menuOpen: false,
    hasOrder: false,
    repair,
    clearance: null,
    group: { position: { x: 0, y: 0, z: 0 } },
    setTargetCalls: 0,
    setTarget() {
      this.setTargetCalls++;
      this.hasOrder = true;
      return true;
    },
    arrive() {
      this.hasOrder = false;
    },
  };
  return scout;
}

function makeCommander(scouts) {
  const ctx = {
    game: { difficulty: { id: 'expert' }, teams: [{}, {}] },
    vehicles: { instances: scouts, active: null, defOf: () => null },
    structures: { instances: [] },
    heightmap: DRY_HEIGHTMAP,
  };
  return new AiCommander({
    team: { id: 1, defeated: false, homePoint: { x: 0, z: 0 }, credits: 0 },
    buildDelaySeconds: 0,
    ctx,
    camera: null,
  });
}

test('a scout in the repair flow is left to repairController', () => {
  // aiCommander runs before repairController in the tick. Re-issuing an
  // explore order here is what kept repairController's `!hasOrder` branch —
  // where both its detour ladder and its give-up live — permanently
  // unreachable, so `inst.repair` never cleared.
  const scout = makeScout({ repair: { bayId: 19, state: 'to-bay' } });
  const ai = makeCommander([scout]);

  ai._driveOneScout(scout, 1);

  assert.equal(scout.setTargetCalls, 0, 'must not steer a vehicle it does not own');
});

test('a healthy scout is still driven normally', () => {
  const scout = makeScout();
  const ai = makeCommander([scout]);

  ai._driveOneScout(scout, 1);

  assert.ok(scout.setTargetCalls > 0, 'exploration is unaffected');
});

// ---------------------------------------------------------------------------
// Fix 3 — the lease must cover the leg after the dock point
// ---------------------------------------------------------------------------

function makeBay() {
  return {
    id: 18,
    teamId: 1,
    def: { id: 'repair-bay', repair: { creditsPerHealth: 1, secondsPerHealth: 0.1 }, upgradeTiers: [] },
    mode: 'idle',
    x: 0,
    z: 0,
    dock: { x: 16, z: 0 },
    upgradeLevel: 0,
    group: { userData: {} },
  };
}

function makeRepairCtx(inst, bay) {
  const facilityControl = new FacilityControl({ vehicles: { instances: [inst] } });
  const controller = new RepairController({
    vehicles: { instances: [inst], active: null },
    structures: { instances: [bay] },
    heightmap: DRY_HEIGHTMAP,
    game: { teamOf: () => ({ credits: 10000, spend: () => true }) },
    facilityControl,
  });
  return { controller, facilityControl };
}

test('claiming the dock point does not yet stop the lease clock', () => {
  // markDocked used to fire here, one leg early. The `entering` drive that
  // follows is still an approach and can still fail — and `_expireLeases`
  // never inspects a docked holder, so a vehicle that stalled in `entering`
  // held the bay with nothing able to reclaim it. One held a bay for 372
  // seconds from 228 units away, with seven vehicles queued behind it.
  const bay = makeBay();
  const inst = makeScout();
  inst.repair = { bay, state: 'to-bay' };
  const { controller, facilityControl } = makeRepairCtx(inst, bay);

  facilityControl.request(inst, bay, 'repair');
  assert.equal(facilityControl.statusOf(inst), CLEARED, 'holds the corridor');

  controller._claimDock(inst, inst.repair, bay);

  assert.equal(inst.repair.state, 'entering');
  assert.equal(
    facilityControl.statusOf(inst),
    CLEARED,
    'still merely cleared — the lease must keep running across this leg'
  );
});

test('arriving at the pad is what converts the clearance to a service claim', () => {
  const bay = makeBay();
  const inst = makeScout();
  inst.repair = { bay, state: 'entering', claimedOrder: true, detours: 0 };
  inst.group.position.x = 0; // already on the pad, so _driveTo reports arrival
  inst.group.position.z = 0;
  const { controller, facilityControl } = makeRepairCtx(inst, bay);
  facilityControl.request(inst, bay, 'repair');

  controller._entering(inst, inst.repair, 0.1);

  assert.equal(inst.repair.state, 'repairing');
  assert.equal(facilityControl.statusOf(inst), DOCKED, 'now in service, lease stopped');
});

test('losing the clearance mid-approach re-queues instead of servicing', () => {
  // The hole the lease change opens if left unhandled: the slot can now be
  // revoked while a vehicle crosses the last leg, and it must not then park on
  // a bay it no longer holds — that is two vehicles on one pad.
  const bay = makeBay();
  const inst = makeScout();
  inst.repair = { bay, state: 'entering', claimedOrder: true, detours: 0 };
  const { controller, facilityControl } = makeRepairCtx(inst, bay);
  // No clearance at all — stands in for one revoked mid-leg.
  inst.clearance = null;

  controller._entering(inst, inst.repair, 0.1);

  assert.equal(inst.repair.state, 'queued', 're-queues rather than servicing');
});

// ---------------------------------------------------------------------------
// Fix 4 — combatCap is a budget for the army, not for each unit type
// ---------------------------------------------------------------------------

const GUN = { id: 'gun-platform', tags: ['combat'], cost: 650, maxHealth: 400, turret: { damage: 22, fireInterval: 1.4 } };
const SCOUT = { id: 'scout-buggy', tags: ['recon', 'combat'], cost: 350, maxHealth: 100, turret: { damage: 2, fireInterval: 1.5 } };
const HARVESTER = { id: 'crystal-harvester', tags: ['economy'], cost: 600, maxHealth: 220 };
const CUSTOM_HARVESTER = { id: 'custom:abc', tags: ['economy'], cost: 600, maxHealth: 220 };

function makeBuildCommander(owned, produces) {
  const built = [];
  const defs = [GUN, SCOUT, HARVESTER, CUSTOM_HARVESTER];
  const factory = { teamId: 1, mode: 'idle', def: { id: 'armed-factory', produces } };
  const team = { id: 1, credits: 10000, weaponTier: 0, spend: () => true };
  const ctx = {
    game: { difficulty: { id: 'expert' }, teams: [{}, {}], teamOf: () => team },
    vehicles: {
      instances: owned.map((def, i) => ({ id: 100 + i, teamId: 1, def, dead: false, group: { position: { x: 0, y: 0, z: 0 } } })),
      active: null,
      instanceOf: () => null,
      defOf: (id) => defs.find((d) => d.id === id),
    },
    structures: { instances: [factory] },
    heightmap: DRY_HEIGHTMAP,
    produceUnit: (def) => built.push(def.id),
  };
  const ai = new AiCommander({
    team: { id: 1, defeated: false, homePoint: { x: 0, z: 0 }, credits: 10000 },
    buildDelaySeconds: 0,
    ctx,
    camera: null,
  });
  return { ai, built };
}

test('combat budget counts every combat-tagged unit, not each id separately', () => {
  // Seven combat-tagged units already owned, of two different ids — the exact
  // shape a real match reached (7 tanks, then 7 scouts, against combatCap 7).
  const owned = [GUN, GUN, GUN, GUN, GUN, GUN, SCOUT];
  const { ai, built } = makeBuildCommander(owned, ['gun-platform', 'scout-buggy']);

  assert.equal(ai._tryBuildUnit('combat', 7), false, 'budget is spent');
  assert.deepEqual(built, [], 'no scout bought to top up a per-id allowance');
});

test('the combat budget still builds while there is room', () => {
  const { ai, built } = makeBuildCommander([GUN, GUN], ['gun-platform', 'scout-buggy']);

  assert.equal(ai._tryBuildUnit('combat', 7), true);
  assert.deepEqual(built, ['gun-platform'], 'and value-per-cost still picks the tank');
});

test('economy deliberately keeps its per-id allowance', () => {
  // Two harvester types under a cap of 2 currently yields four harvesters, and
  // that surplus is most of why the AI economies that work, work. Changing it
  // belongs to a measured balance pass, not to this fix — so it is asserted
  // here to keep the exception explicit rather than accidental.
  const { ai, built } = makeBuildCommander(
    [HARVESTER, HARVESTER],
    ['crystal-harvester', 'custom:abc']
  );

  assert.equal(ai._tryBuildUnit('economy', 2), true);
  assert.deepEqual(built, ['custom:abc'], 'the second type is still reachable');
});

// ---------------------------------------------------------------------------
// Fix 5 — a hold must not be able to suppress the escapes forever
// ---------------------------------------------------------------------------

test('every escape cooldown outlasts the reverse it gates', () => {
  // Read out of the source, not restated here. An earlier draft of this test
  // hardcoded the multipliers and so passed against the broken value too —
  // which is the whole failure mode a negative control exists to catch.
  //
  // The invariant: `escapeCooldown` is measured from the *start* of a reverse,
  // so it has to exceed that reverse's duration or there is no forward travel
  // between attempts at all, and the escape re-arms on the tick after each one
  // ends — pinning `reverseTimer` non-null indefinitely, which in turn
  // switches off the stall and no-progress escapes downstream.
  const src = readFileSync(new URL('../src/vehicles/vehicleController.js', import.meta.url), 'utf8');
  const durationOf = (name) => {
    const m = src.match(new RegExp(`const ${name} = ([\\d.]+);`));
    assert.ok(m, `${name} not found — has it been renamed?`);
    return parseFloat(m[1]);
  };
  const multiplierFor = (name) => {
    const m = src.match(new RegExp(`escapeCooldown = ${name} \\* ([\\d.]+);`));
    assert.ok(m, `no escapeCooldown assignment found for ${name}`);
    return parseFloat(m[1]);
  };

  for (const name of ['SHARP_TURN_REVERSE', 'BLOCKED_REVERSE']) {
    const duration = durationOf(name);
    const multiplier = multiplierFor(name);
    assert.ok(
      multiplier > 1,
      `${name}: cooldown is ${multiplier}x its own ${duration}s reverse — it expires mid-manoeuvre, ` +
        'so the escape re-arms with no forward travel in between'
    );
    // And the gap stays short, which is what the manoeuvre was tuned for.
    assert.ok((multiplier - 1) * duration <= 1.6, `${name}: gap should stay a beat, not a pause`);
  }
});

test('a harvester held mid-reverse indefinitely still escalates', () => {
  // The freeze, reproduced: an order live, zero speed, and `reverseTimer`
  // re-armed every tick so it is never null. Before the grace period both the
  // stall and no-progress escapes were switched off by that alone, and the
  // harvester sat still for fourteen simulated minutes.
  const facility = makeFacility();
  const inst = makeHarvester({ x: 200, z: 0 });
  inst.speed = 0;
  inst.hasOrder = true;
  inst.yielding = false;
  inst.reverseTimer = 0.4; // mid-reverse, and it never expires
  inst.arrive = () => { inst.hasOrder = false; };
  inst.setTarget = () => { inst.hasOrder = true; return true; };

  const ai = new HarvesterAI({
    vehicles: { instances: [inst] },
    world: { blooms: { nearestTo: () => null } },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [facility] },
    game: { teamOf: () => ({ earn: () => {}, stats: {} }) },
    facilityControl: {
      inTerminalArea: () => false,
      isCleared: () => false,
      request: () => {},
      markDocked: () => false,
      statusOf: () => null,
      release: () => {},
      holdingFix: () => null,
    },
  });

  const s = ai._stateFor(inst);
  s.state = 'to-base';
  s.load = 320;

  let abandoned = 0;
  ai._onAbandoned = () => { abandoned++; };

  // Twenty seconds of being permanently mid-reverse.
  for (let i = 0; i < 20 / 0.1; i++) ai._travel(inst, s, 0.1, DOCK_DISTANCE, () => {});

  assert.ok(s.holdTimer > 0, 'the hold is being timed at all');
  assert.ok(abandoned > 0, 'the escape fires once the hold outstays its grace');
});

test('a brief reverse is still treated as a deliberate manoeuvre', () => {
  // The behaviour the gate exists for must survive: a real three-point turn
  // must not be diagnosed as a stall and detoured out of.
  const facility = makeFacility();
  const inst = makeHarvester({ x: 200, z: 0 });
  inst.speed = 0;
  inst.hasOrder = true;
  inst.reverseTimer = 0.4;
  inst.arrive = () => { inst.hasOrder = false; };
  inst.setTarget = () => { inst.hasOrder = true; return true; };

  const ai = new HarvesterAI({
    vehicles: { instances: [inst] },
    world: { blooms: { nearestTo: () => null } },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [facility] },
    game: { teamOf: () => ({ earn: () => {}, stats: {} }) },
    facilityControl: {
      inTerminalArea: () => false, isCleared: () => false, request: () => {},
      markDocked: () => false, statusOf: () => null, release: () => {}, holdingFix: () => null,
    },
  });

  const s = ai._stateFor(inst);
  s.state = 'to-base';
  s.load = 320;

  let abandoned = 0;
  ai._onAbandoned = () => { abandoned++; };

  for (let i = 0; i < 4 / 0.1; i++) ai._travel(inst, s, 0.1, DOCK_DISTANCE, () => {});

  assert.equal(abandoned, 0, 'four seconds of reversing is a manoeuvre, not a freeze');
  assert.equal(s.stallTimer, 0, 'and it is not accruing stall either');
});

test('fleeing is never bounded — it is a decision, not a manoeuvre', () => {
  // A harvester holding station under its facility's guns should stay there for
  // as long as the threat lasts; timing it out would send it back into fire.
  const facility = makeFacility();
  const inst = makeHarvester({ x: 200, z: 0 });
  inst.speed = 0;
  inst.hasOrder = true;
  // Mid-reverse *and* fleeing: without this the mechanical hold is false, the
  // grace timer never runs, and the test passes whether or not FLEEING is
  // exempt — proving nothing.
  inst.reverseTimer = 0.4;
  inst.yielding = false;
  inst.arrive = () => { inst.hasOrder = false; };
  inst.setTarget = () => { inst.hasOrder = true; return true; };

  const ai = new HarvesterAI({
    vehicles: { instances: [inst] },
    world: { blooms: { nearestTo: () => null } },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [facility] },
    game: { teamOf: () => ({ earn: () => {}, stats: {} }) },
    facilityControl: {
      inTerminalArea: () => false, isCleared: () => false, request: () => {},
      markDocked: () => false, statusOf: () => null, release: () => {}, holdingFix: () => null,
    },
  });

  const s = ai._stateFor(inst);
  s.state = 'fleeing';
  s.dest = { x: 0, z: 0 };

  let abandoned = 0;
  ai._onAbandoned = () => { abandoned++; };

  for (let i = 0; i < 30 / 0.1; i++) ai._travel(inst, s, 0.1, DOCK_DISTANCE, () => {});

  assert.equal(abandoned, 0, 'thirty seconds of holding station is allowed');
});

// ---------------------------------------------------------------------------
// Fix 6 — three ways an escalation could never arrive
//
// All three were found the same way: the re-run after Fix 5 still left AI
// harvesters motionless for minutes at a time, and instrumenting them showed
// the escapes were not being *suppressed* so much as never *reached*.
// ---------------------------------------------------------------------------

function makeDriveInst({ x = 0, z = 0 } = {}) {
  const inst = {
    id: 15,
    teamId: 1,
    dead: false,
    def: { id: 'crystal-harvester', capacity: 320, maxHealth: 220, maxClimbGrade: 1.2 },
    health: 220,
    speed: 0,
    mode: 'mobile',
    menuOpen: false,
    throttle: 0,
    steer: 0,
    hasOrder: false,
    repair: null,
    clearance: null,
    yielding: false,
    reverseTimer: null,
    blocked: false,
    group: { position: { x, y: 0, z }, userData: {} },
    targets: [],
    setTarget(tx, tz) {
      this.targets.push({ x: tx, z: tz });
      this.hasOrder = true;
      return true;
    },
    arrive() {
      this.hasOrder = false;
    },
    beginReverse(d) {
      this.reverseTimer = d;
    },
  };
  return inst;
}

const STUB_CLEARANCE = {
  inTerminalArea: () => false,
  isCleared: () => false,
  request: () => {},
  requeue: () => {},
  markDocked: () => false,
  statusOf: () => null,
  release: () => {},
  holdingFix: () => null,
};

function makeHarvesterAI(inst, structures = []) {
  return new HarvesterAI({
    vehicles: { instances: [inst] },
    world: { blooms: { nearestTo: () => null } },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: structures },
    game: { teamOf: () => ({ earn: () => {}, stats: {}, credits: 10000 }) },
    facilityControl: STUB_CLEARANCE,
  });
}

test('repairController re-issues an order it lost on a waypoint leg', () => {
  // The freeze: `_driveTo`'s waypoint branch returned whether or not the
  // waypoint had been reached, so everything below it — the re-issue, the
  // stall check, the no-progress check — was unreachable while one was live.
  // A vehicle whose order went missing there (driveToTarget drops one on a
  // terrain block; a leg change cancels one outright) sat with a live
  // waypoint, no order and every timer at 0.00, holding its place in a bay
  // queue. Two of Jade's harvesters did that for eight minutes each, one of
  // them carrying a full load, while the team's income stayed exactly flat.
  const bay = makeBay();
  const inst = makeScout();
  inst.group.position.x = 300;
  inst.group.position.z = 300;
  inst.hasOrder = false;
  inst.repair = {
    bay,
    state: 'to-bay',
    claimedOrder: true, // mid-leg, so the claim block does not run
    detours: 2,
    waypoint: { x: 340, z: 340 }, // live, and nowhere near
  };
  const { controller } = makeRepairCtx(inst, bay);

  controller._driveTo(inst, inst.repair, bay.dock.x, bay.dock.z, 0.1);

  assert.ok(inst.setTargetCalls > 0, 'the leg must not go inert with no order');
});

test('repairController drops a stale waypoint when the leg changes', () => {
  // `claimedOrder = false` is how every caller says "new leg, new
  // destination". The waypoint belonged to the old one; keeping it aims the
  // vehicle at a goal this leg no longer has.
  const bay = makeBay();
  const inst = makeScout();
  inst.group.position.x = 300;
  inst.group.position.z = 300;
  inst.hasOrder = false;
  inst.repair = {
    bay,
    state: 'queued',
    claimedOrder: false,
    detours: 0,
    waypoint: { x: -900, z: -900 }, // the previous leg's, in the wrong direction
  };
  const { controller } = makeRepairCtx(inst, bay);
  const aimed = [];
  const setTarget = inst.setTarget.bind(inst);
  inst.setTarget = (tx, tz, hm) => { aimed.push({ x: tx, z: tz }); return setTarget(tx, tz, hm); };

  controller._driveTo(inst, inst.repair, bay.dock.x, bay.dock.z, 0.1);

  assert.equal(inst.repair.waypoint, null, 'the old waypoint is not carried over');
  assert.deepEqual(aimed.at(-1), { x: bay.dock.x, z: bay.dock.z }, "aims at this leg's destination");
});

test('an intermittent hold cannot keep wiping the no-progress evidence', () => {
  // Fix 5 bounded a hold that never *ends*. This is the other shape: a hold
  // that ends and immediately starts again. driveToTarget's terrain-blocked
  // escape reverses, the reverse completes, the vehicle drives back at the
  // same unclimbable grade and reverses again — roughly a two-second cycle.
  // Zeroing the counter on every cycle meant it never passed a few tenths of a
  // second. Amber's harvester rode that loop for the entire match: full speed,
  // six units of ground covered, `stall` and `noProgress` both 0.00 throughout,
  // and its team finished on 320 credits.
  const facility = makeFacility();
  const inst = makeDriveInst({ x: 200, z: 0 });
  inst.hasOrder = true;
  inst.speed = 6; // well above STALL_SPEED, so the stall check never fires
  const ai = makeHarvesterAI(inst, [facility]);

  const s = ai._stateFor(inst);
  s.state = 'to-base';
  s.load = 320;

  let abandoned = 0;
  ai._onAbandoned = () => { abandoned++; };

  // Twenty seconds of block-reverse-block, never moving, never arriving.
  for (let i = 0; i < 20 / 0.1; i++) {
    inst.reverseTimer = i % 20 < 12 ? 0.5 : null; // ~1.2s holding, ~0.8s not
    ai._travel(inst, s, 0.1, DOCK_DISTANCE, () => {});
  }

  assert.ok(abandoned > 0, 'the moving-but-getting-nowhere fraction must accumulate');
});

test('reaching a detour waypoint does not put the ladder back to zero', () => {
  // Reaching a waypoint means the manoeuvre worked, not that the leg is going
  // anywhere — a harvester wedged short of its field can reach waypoints all
  // day. Resetting here held the ladder at zero, so it never reached
  // DETOUR_ANGLES.length and the give-up past it (ban the field, go elsewhere)
  // was unreachable.
  const inst = makeDriveInst({ x: 0, z: 0 });
  inst.hasOrder = true;
  inst.speed = 6;
  const ai = makeHarvesterAI(inst);

  const s = ai._stateFor(inst);
  s.state = 'to-field';
  s.field = { id: 7, x: 100, z: 0, radius: 14, stock: 900 };

  ai._onAbandoned(inst, s, { x: 100, z: 0 }, 100);
  assert.equal(s.detours, 1, 'the ladder advanced');
  assert.ok(s.waypoint, 'and picked a waypoint');

  // Arrive at it, exactly as a vehicle that drives perfectly well would.
  inst.group.position.x = s.waypoint.x;
  inst.group.position.z = s.waypoint.z;
  ai._travel(inst, s, 0.1, DOCK_DISTANCE, () => {});

  assert.equal(s.waypoint, null, 'the waypoint is consumed');
  assert.equal(s.detours, 1, 'but the ladder keeps its place');
});

test('a harvester that reaches every waypoint and never arrives still gives up', () => {
  // The consequence of the test above, end to end: the ladder has to be able
  // to run out for the ban to be reachable at all.
  const inst = makeDriveInst({ x: 0, z: 0 });
  inst.hasOrder = true;
  inst.speed = 6;
  const ai = makeHarvesterAI(inst);

  const s = ai._stateFor(inst);
  s.state = 'to-field';
  s.field = { id: 7, x: 100, z: 0, radius: 14, stock: 900 };

  for (let cycle = 0; cycle < 10 && !s.bans.has(7); cycle++) {
    ai._onAbandoned(inst, s, { x: 100, z: 0 }, 100);
    if (!s.waypoint) continue;
    // Teleport onto the waypoint but back to the same distance from the field,
    // so the vehicle is demonstrably driving and demonstrably getting nowhere.
    inst.group.position.x = s.waypoint.x;
    inst.group.position.z = s.waypoint.z;
    ai._travel(inst, s, 0.1, DOCK_DISTANCE, () => {});
    inst.group.position.x = 0;
    inst.group.position.z = 0;
  }

  assert.ok(s.bans.has(7), 'the field is eventually banned and something else tried');
});

test('genuine progress does reset the ladder', () => {
  // The other half of the rule: detours that are working must not count
  // against the vehicle, or a long approach would ban its own destination.
  const inst = makeDriveInst({ x: 0, z: 0 });
  inst.hasOrder = true;
  inst.speed = 6;
  const ai = makeHarvesterAI(inst);

  const s = ai._stateFor(inst);
  s.state = 'to-field';
  s.field = { id: 7, x: 100, z: 0, radius: 14, stock: 900 };
  s.detours = 3;
  s.bestDistance = 100;

  inst.group.position.x = 40; // 60 out — a big improvement on 100
  ai._travel(inst, s, 0.1, DOCK_DISTANCE, () => {});

  assert.equal(s.detours, 0, 'closer than ever before starts the ladder again');
});

test('a loaded harvester finishes the delivery before queueing for repair', () => {
  // Breaking off from TO_BASE throws away a completed round trip and takes the
  // load out of the economy for as long as the bay queue is — measured at eight
  // to ten minutes behind a handful of damaged scouts, during which the team
  // earned nothing and its credits drained paying for *their* repairs.
  const bay = makeBay();
  const inst = makeDriveInst({ x: 200, z: 0 });
  inst.health = 60; // well under REPAIR_RETREAT_FRACTION of 220
  const ai = makeHarvesterAI(inst, [bay]);

  const s = ai._stateFor(inst);
  s.state = 'to-base';
  s.load = 320;

  assert.equal(ai._maybeRetreatForRepair(inst, s, 0.1), false, 'deliver first');
  assert.equal(s.state, 'to-base', 'and stay on the delivery');
});

test('the same harvester retreats the moment it is empty', () => {
  // Deferred, not skipped — IDLE re-checks it as soon as the unload finishes.
  const bay = makeBay();
  const inst = makeDriveInst({ x: 200, z: 0 });
  inst.health = 60;
  const ai = makeHarvesterAI(inst, [bay]);

  const s = ai._stateFor(inst);
  s.state = 'idle';
  s.load = 0;

  assert.equal(ai._maybeRetreatForRepair(inst, s, 0.1), true);
  assert.equal(s.state, 'to-repair');
});
