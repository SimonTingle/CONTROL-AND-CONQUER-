/**
 * TrafficController's swerve-instead-of-stop avoidance: when a yielding
 * vehicle is flagged, it should also get a lateral steering nudge
 * (`avoidOffset`) rather than just the flat `yielding` flag the old
 * stop-on-sight behaviour relied on alone.
 *
 * Dependency-free: plain mock vehicles shaped like the fields
 * trafficController.js actually reads (group.position, heading, def.dims,
 * createdAt, hasOrder, dead), same convention as ai-defense.test.mjs.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TrafficController, computeAvoidOffset } from '../src/vehicles/trafficController.js';

function makeVehicle({ x, z, heading = 0, createdAt = 0, hasOrder = true, dead = false }) {
  return {
    group: { position: { x, z } },
    heading,
    def: { dims: { hullLength: 6, hullWidth: 4 } },
    createdAt,
    hasOrder,
    dead,
    yielding: false,
    avoidOffset: null,
    reverseTimer: null,
    beginReverse() {},
  };
}

function makeController(vehicles) {
  return new TrafficController({ vehicles: { instances: vehicles, active: null } });
}

test('computeAvoidOffset nudges away from the obstacle side, dead-ahead-but-off-center', () => {
  // a at origin facing +x (heading 0); b sits ahead and to a's left (+z).
  const a = makeVehicle({ x: 0, z: 0, heading: 0 });
  const b = makeVehicle({ x: 10, z: 3, heading: Math.PI });
  const offset = computeAvoidOffset(a, b);
  // b is to a's left, so a should swerve right: negative z, since a's
  // heading is along +x and "right" of +x is -z.
  assert.ok(offset.z < 0, `expected a negative z offset (swerve right), got ${offset.z}`);
  // Heading is purely along +x, so the lateral nudge should be almost pure z.
  assert.ok(Math.abs(offset.x) < Math.abs(offset.z), 'offset should be mostly lateral, not forward/back');
});

test('computeAvoidOffset magnitude fades toward the cone edge versus dead-ahead', () => {
  const a = makeVehicle({ x: 0, z: 0, heading: 0 });
  const deadAhead = makeVehicle({ x: 10, z: 0.001, heading: Math.PI });
  const nearEdge = makeVehicle({ x: 10, z: 17, heading: Math.PI }); // bearing near the 60° cone edge

  const magOf = (off) => Math.hypot(off.x, off.z);
  const magAhead = magOf(computeAvoidOffset(a, deadAhead));
  const magEdge = magOf(computeAvoidOffset(a, nearEdge));
  assert.ok(magEdge < magAhead, `expected edge-of-cone offset (${magEdge}) smaller than dead-ahead (${magAhead})`);
});

test('TrafficController.update() sets avoidOffset alongside yielding for the yielding vehicle only', () => {
  // a heads toward b (dead ahead); b heads away, so only a sees b as blocking.
  const a = makeVehicle({ x: 0, z: 0, heading: 0, createdAt: 5 });
  const b = makeVehicle({ x: 8, z: 0, heading: 0, createdAt: 1 });
  const controller = makeController([a, b]);

  controller.update(1 / 60);

  assert.equal(a.yielding, true, 'a should be yielding — b is dead ahead and within the avoidance radius');
  assert.notEqual(a.avoidOffset, null, 'a should have a non-null avoidOffset');
  assert.deepEqual(a.avoidOffset, computeAvoidOffset(a, b));
  assert.equal(b.yielding, false, 'b is not autonomous-blocked by a (a is behind b, outside its cone)');
  assert.equal(b.avoidOffset, null);
});
