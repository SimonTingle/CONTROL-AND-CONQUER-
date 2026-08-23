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
