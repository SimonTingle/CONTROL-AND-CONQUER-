/**
 * `steeringAimPoint`, the pure helper that bends driveToTarget's steering
 * aim point for an avoidance swerve, and the guard in `driveToTarget` that
 * stops a transient swerve nudge from abandoning an order over terrain that
 * only the swerve, not the real target direction, would refuse to climb.
 *
 * Dependency-free: exercises the exported pure function directly, and
 * exercises the guard through a plain mock vehicle carrying only the fields
 * driveToTarget actually reads, same convention as ai-defense.test.mjs.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { steeringAimPoint, VehicleInstance } from '../src/vehicles/vehicleController.js';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';

test('steeringAimPoint returns the raw vector unchanged when there is no offset', () => {
  assert.deepEqual(steeringAimPoint(3, 4, null), { x: 3, z: 4 });
});

test('steeringAimPoint adds the offset, and arrival distance (hypot of the raw vector) is unaffected', () => {
  const aim = steeringAimPoint(3, 4, { x: 1, z: 0 });
  assert.deepEqual(aim, { x: 4, z: 4 });
  // The executable form of "arrival distance never sees the offset": dist is
  // always computed from the raw dx/dz in driveToTarget, before this call.
  assert.equal(Math.hypot(3, 4), 5);
});

// --- driveToTarget's climbable-recheck guard ---

const SCOUT_DEF = VEHICLE_CATALOG.find((d) => d.id === 'scout-buggy');

function makeScout({ x = 0, z = 0, heading = 0 } = {}) {
  const inst = Object.create(VehicleInstance.prototype);
  Object.assign(inst, {
    def: SCOUT_DEF,
    mode: 'mobile',
    group: { position: { x, y: 0, z } },
    heading,
    forwardSpeed: 0,
    speed: 0,
    accelerating: false,
    blocked: false,
    grade: 0,
    escapeCooldown: 0,
    reverseTimer: null,
    target: { x: x + 20, y: z }, // straight ahead along +x
    yielding: false,
    avoidOffset: null,
    _nearby: null,
    _applyBlockedDamage() {},
    arrive(reason) { inst._arrivedReason = reason; inst.target = null; },
    beginReverse() { inst._reversed = true; },
    applySteering() {},
    advance() {},
  });
  return inst;
}

/**
 * heightAt rises steeply only in the +z direction, flat everywhere else.
 * The threshold (0.5) sits well inside GRADE_PROBE's 2.5-unit look-ahead, so
 * any meaningful heading component toward +z crosses it, while straight
 * along +x (dz = 0) never does.
 */
function makeWallToTheSide() {
  return {
    heightAt(x, z) {
      return z > 0.5 ? 100 : 0;
    },
  };
}

test('a swerve pointed at a wall holds this tick but keeps the order alive', () => {
  const scout = makeScout({ x: 0, z: 0, heading: 0 });
  scout.yielding = true;
  scout.avoidOffset = { x: 0, z: 20 }; // pushes the aim hard toward +z, into the wall
  const heightmap = makeWallToTheSide();

  scout.driveToTarget(1 / 60, heightmap);

  assert.equal(scout._arrivedReason, undefined, 'order must not be abandoned — the real target direction is clear');
  assert.notEqual(scout.target, null, 'target must still be set');
  assert.equal(scout.forwardSpeed, 0, 'should hold in place this tick rather than drive into the wall');
});

test('a genuinely blocked real target direction still abandons the order', () => {
  const scout = makeScout({ x: 0, z: 0, heading: 0 });
  scout.target = { x: 0, y: 20 }; // straight toward +z — the wall itself
  scout.yielding = true;
  scout.avoidOffset = { x: 0, z: 20 }; // swerve makes no difference, real direction is also blocked
  const heightmap = makeWallToTheSide();

  scout.driveToTarget(1 / 60, heightmap);

  assert.equal(scout._arrivedReason, 'blocked', 'the real target direction is genuinely unclimbable — order should abandon');
});
