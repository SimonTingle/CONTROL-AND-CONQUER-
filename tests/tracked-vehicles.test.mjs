/**
 * Tracked vehicles added to the catalog (tracked-harvester, tracked-tank,
 * heavy-tracked-tank), and the driving behaviour specific to them: pivoting
 * in place instead of reversing on a sharp misalignment
 * (vehicleController.js), and never being routed toward a backward-hemisphere
 * detour angle (harvesterAI.js / repairController.js).
 *
 * See docs/plans/tracked-vehicles-and-sell.md for the investigation this
 * closes: the original complaint was that vehicles spend too long driving
 * backwards, traced to the detour ladder's last angle(s) pointing behind the
 * vehicle. Tracked vehicles can pivot to face any bearing without moving at
 * all, so they never need to be sent toward one.
 *
 * Dependency-free: catalog data is plain objects; the driving tests use the
 * same mock-instance conventions as tests/vehicle-steering-aim.test.mjs
 * (VehicleInstance) and tests/harvester-field-selection.test.mjs
 * (HarvesterAI), no WebGL or real heightmap.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';
import { VehicleInstance } from '../src/vehicles/vehicleController.js';
import { HarvesterAI } from '../src/vehicles/harvesterAI.js';

const byId = (id) => VEHICLE_CATALOG.find((d) => d.id === id);

// --- catalog sanity ---

test('tracked-harvester costs double the wheeled harvester and climbs steeper ground', () => {
  const wheeled = byId('crystal-harvester');
  const tracked = byId('tracked-harvester');
  assert.equal(tracked.cost, wheeled.cost * 2);
  assert.ok(tracked.maxClimbGrade > wheeled.maxClimbGrade);
  assert.equal(tracked.shape.tracked, true);
  // Selling point is mobility, not a bigger or faster haul.
  assert.equal(tracked.capacity, wheeled.capacity);
  assert.equal(tracked.fillRate, wheeled.fillRate);
});

test('tracked-tank costs double gun-platform, same turret, steeper climb', () => {
  const wheeled = byId('gun-platform');
  const tracked = byId('tracked-tank');
  assert.equal(tracked.cost, wheeled.cost * 2);
  assert.ok(tracked.maxClimbGrade > wheeled.maxClimbGrade);
  assert.equal(tracked.shape.tracked, true);
  assert.equal(tracked.turret.damage, wheeled.turret.damage);
});

test('heavy-tracked-tank costs 3x tracked-tank and out-climbs every wheeled vehicle', () => {
  const tank = byId('tracked-tank');
  const heavy = byId('heavy-tracked-tank');
  assert.equal(heavy.cost, tank.cost * 3);
  assert.equal(heavy.shape.tracked, true);
  for (const def of VEHICLE_CATALOG) {
    if (def.shape?.tracked) continue;
    assert.ok(heavy.maxClimbGrade > def.maxClimbGrade, `beats wheeled ${def.id}`);
  }
});

// --- sharp-turn escape: pivot vs. reverse ---

const DRY_HEIGHTMAP = { heightAt: () => 10, seaLevelY: 0 };

function makeVehicle(def, { tracked, heading = 0, target } = {}) {
  const inst = Object.create(VehicleInstance.prototype);
  Object.assign(inst, {
    def,
    mode: 'mobile',
    group: { position: { x: 0, y: 0, z: 0 } },
    heading,
    forwardSpeed: 5, // nonzero, so a reverse (which zeroes it) is observable
    speed: 0,
    accelerating: false,
    blocked: false,
    grade: 0,
    tracked,
    escapeCooldown: 0,
    reverseTimer: null,
    target,
    yielding: false,
    avoidOffset: null,
    _nearby: null,
    _applyBlockedDamage() {},
    arrive(reason) { inst._arrivedReason = reason; inst.target = null; },
    beginReverse(duration, bias) { inst._reversed = { duration, bias }; },
    advance() {},
  });
  return inst;
}

test('a tracked vehicle facing sharply away from its target pivots instead of reversing', () => {
  const tank = makeVehicle(byId('tracked-tank'), {
    tracked: true,
    heading: 0,
    target: { x: -20, y: 0 }, // straight behind: ~180° misalignment
  });
  let steered = null;
  tank.applySteering = (dt, targetAngle) => { steered = targetAngle; };
  tank.driveToTarget(1 / 60, DRY_HEIGHTMAP);

  assert.equal(tank._reversed, undefined, 'must not reverse');
  assert.equal(tank.forwardSpeed, 0, 'holds still while it turns in place');
  assert.notEqual(steered, null, 'still steers toward the target');
});

test('negative control: the identical wheeled vehicle in the identical spot does reverse', () => {
  const wheeled = makeVehicle(byId('tracked-tank'), {
    tracked: false, // same def, only the drivetrain flag flipped — isolates the gate
    heading: 0,
    target: { x: -20, y: 0 },
  });
  wheeled.driveToTarget(1 / 60, DRY_HEIGHTMAP);

  assert.ok(wheeled._reversed, 'wheeled vehicle still takes the three-point turn');
});

// --- detour ladder: tracked vehicles skip the backward-hemisphere angles ---

function makeHarvester(id, { tracked = false } = {}) {
  return {
    id,
    def: { capacity: 320, maxClimbGrade: 0.6 },
    tracked,
    reverseTimer: null,
    blocked: false,
    dead: false,
    group: { position: { x: 0, y: 0, z: 0 } },
    setTarget() { return true; },
    beginReverse() { this._reversed = true; },
  };
}

function makeHarvesterAI(harvesters) {
  return new HarvesterAI({
    vehicles: { instances: harvesters },
    world: { blooms: { nearestTo: () => null } },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [] },
    game: {},
    facilityControl: null,
  });
}

test('a tracked harvester never reverses from _onAbandoned, even mid-detour', () => {
  const h = makeHarvester('T', { tracked: true });
  const ai = makeHarvesterAI([h]);
  const s = ai._stateFor(h);
  s.detours = 1; // "already trying" — the condition that would otherwise trigger a reverse
  ai._onAbandoned(h, s, { x: 100, z: 0 }, 100);
  assert.equal(h._reversed, undefined, 'tracked harvester must not reverse');
});

test('negative control: a wheeled harvester in the identical situation does reverse', () => {
  const h = makeHarvester('W', { tracked: false });
  const ai = makeHarvesterAI([h]);
  const s = ai._stateFor(h);
  s.detours = 1;
  ai._onAbandoned(h, s, { x: 100, z: 0 }, 100);
  assert.equal(h._reversed, true, 'wheeled harvester still reverses — proves the gate is tracked-specific');
});

test('a tracked harvester skips a detour angle at or past the forward-hemisphere limit', () => {
  // DETOUR_ANGLES[2] is 1.6 rad (~91.7°) — at/past the PI/2 cutoff.
  const h = makeHarvester('T', { tracked: true });
  const ai = makeHarvesterAI([h]);
  const s = ai._stateFor(h);
  s.detours = 2;
  ai._onAbandoned(h, s, { x: 100, z: 0 }, 100);
  assert.equal(s.detours, 3, 'skipped straight past the backward-hemisphere angle');
  assert.equal(s.waypoint, null, 'no waypoint set for the skipped angle');
});

test('negative control: a wheeled harvester at the same detour index still gets the waypoint', () => {
  const h = makeHarvester('W', { tracked: false });
  const ai = makeHarvesterAI([h]);
  const s = ai._stateFor(h);
  s.detours = 2;
  ai._onAbandoned(h, s, { x: 100, z: 0 }, 100);
  assert.equal(s.detours, 3);
  assert.ok(s.waypoint, 'wheeled harvester still gets a waypoint at that angle');
});

test('a tracked harvester still tries a forward-hemisphere detour angle normally', () => {
  // DETOUR_ANGLES[0] is 0.9 rad (~51.6°) — well inside the forward hemisphere.
  const h = makeHarvester('T', { tracked: true });
  const ai = makeHarvesterAI([h]);
  const s = ai._stateFor(h);
  s.detours = 0;
  ai._onAbandoned(h, s, { x: 100, z: 0 }, 100);
  assert.equal(s.detours, 1);
  assert.ok(s.waypoint, 'forward-hemisphere angle is still used');
});
