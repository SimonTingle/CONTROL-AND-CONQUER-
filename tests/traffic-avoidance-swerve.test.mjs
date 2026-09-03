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

// --- the broad phase ------------------------------------------------------

/**
 * The pairwise pass used to measure every vehicle against every other, every
 * tick — O(U^2) at 60Hz, which is fine at the 40-unit matches it was written
 * for and much less so once matches went to 20 teams. It now runs off a
 * uniform grid (docs/plans/fps-regression-second-pass.md).
 *
 * `_resolveAvoidance` and `_resolveCollision` mutate the instances they are
 * handed, so the *order* pairs are visited in is part of the simulation
 * result. A grid naturally emits pairs in bucket order; if that order shipped,
 * two clients on different builds would simulate the same fight differently
 * and desync. These tests hold the broad phase to the exact sequence the
 * nested loop produced.
 */

/** What the old nested loop emitted, verbatim. */
function brutePairs(instances) {
  const pairs = [];
  for (let i = 0; i < instances.length; i++) {
    if (instances[i].dead) continue;
    for (let j = i + 1; j < instances.length; j++) {
      if (instances[j].dead) continue;
      pairs.push([i, j]);
    }
  }
  return pairs;
}

function pairsNearerThan(instances, reach) {
  return brutePairs(instances).filter(([i, j]) => {
    const a = instances[i].group.position;
    const b = instances[j].group.position;
    return Math.hypot(a.x - b.x, a.z - b.z) <= reach;
  });
}

test('the broad phase emits every near pair, in nested-loop order', () => {
  // A crowd: some overlapping, some adjacent, some far apart, deliberately
  // not in spatial order so bucket order and index order genuinely differ.
  const vehicles = [
    makeVehicle({ x: 300, z: -300 }),
    makeVehicle({ x: 0, z: 0 }),
    makeVehicle({ x: -300, z: 300 }),
    makeVehicle({ x: 4, z: 1 }),
    makeVehicle({ x: 302, z: -298 }),
    makeVehicle({ x: -2, z: -3 }),
    makeVehicle({ x: 1000, z: 1000 }),
  ];
  const controller = makeController(vehicles);

  const pairs = controller._nearPairs(vehicles);

  // Ascending (i, j) — the order the nested loop produced.
  const sorted = [...pairs].sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  assert.deepEqual(pairs, sorted, 'broad phase emitted pairs out of nested-loop order');

  // Every genuinely-close pair is present. Hull 6x4 gives radius 3, so reach
  // is 3 + 3 + AVOIDANCE_MARGIN(6) = 12.
  const expected = pairsNearerThan(vehicles, 12);
  const got = new Set(pairs.map(([i, j]) => `${i},${j}`));
  for (const [i, j] of expected) {
    assert.ok(got.has(`${i},${j}`), `broad phase dropped the near pair (${i}, ${j})`);
  }

  // And it is a genuine reduction, or this test is measuring nothing.
  assert.ok(
    pairs.length < brutePairs(vehicles).length,
    'broad phase returned every pair — it is not actually culling',
  );
});

test('the broad phase skips dead vehicles, as the nested loop did', () => {
  const vehicles = [
    makeVehicle({ x: 0, z: 0 }),
    makeVehicle({ x: 2, z: 0, dead: true }),
    makeVehicle({ x: 4, z: 0 }),
  ];
  const controller = makeController(vehicles);

  const pairs = controller._nearPairs(vehicles);
  for (const [i, j] of pairs) {
    assert.ok(!vehicles[i].dead && !vehicles[j].dead, 'a corpse reached the pair list');
  }
  assert.deepEqual(pairs, [[0, 2]]);
});

test('vehicles far apart produce no pairs at all', () => {
  const vehicles = [
    makeVehicle({ x: 0, z: 0 }),
    makeVehicle({ x: 5000, z: 0 }),
    makeVehicle({ x: 0, z: 5000 }),
  ];
  assert.deepEqual(makeController(vehicles)._nearPairs(vehicles), []);
});
