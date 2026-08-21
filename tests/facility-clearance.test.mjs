/**
 * FacilityControl: the derived clearance ledger.
 *
 * The point of the derived design is that every rule below is pure logic over
 * ids and plain objects — no heightmap, no meshes, no browser — so these are
 * assertions about the real controller, not a stub of it.
 *
 * Dependency-free: plain mock vehicles/structures shaped like the fields
 * facilityControl.js actually reads, same convention as
 * traffic-avoidance-swerve.test.mjs.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FacilityControl,
  APPROACH_RADIUS,
  TERMINAL_RADIUS,
  CLEARED,
  DOCKED,
  HOLDING,
} from '../src/vehicles/facilityControl.js';
import { simClock, resetSimClock } from '../src/core/simClock.js';

function makeVehicle(id, { x = 0, z = 0 } = {}) {
  return { id, dead: false, clearance: null, group: { position: { x, z } } };
}

function makeFacility(id = 1, { x = 0, z = 0 } = {}) {
  return { id, x, z, dead: false, mode: 'idle', def: { id: 'harvester-facility' } };
}

/** Flat, dry ground everywhere — terrain probing is exercised separately. */
const flatHeightmap = { heightAt: () => 20, seaLevelY: 0 };

function makeControl(vehicles, structures) {
  return new FacilityControl({
    vehicles: { instances: vehicles },
    structures: { instances: structures },
    heightmap: flatHeightmap,
  });
}

test('exactly one vehicle is cleared into a facility at a time', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const a = makeVehicle(1);
  const b = makeVehicle(2);
  const c = makeVehicle(3);
  const control = makeControl([a, b, c], [facility]);

  for (const v of [a, b, c]) control.request(v, facility);
  control.update();

  const cleared = [a, b, c].filter((v) => control.statusOf(v) === CLEARED);
  assert.equal(cleared.length, 1, 'exactly one vehicle should hold the corridor');
  assert.equal(control.queueDepth(facility), 2, 'the other two should be holding');
});

test('the corridor goes to the earliest request, not to array order', () => {
  resetSimClock(0);
  const facility = makeFacility();
  // Deliberately listed newest-id-first: with the old "whoever the instances
  // loop reaches first" handoff this ordering alone would change the winner.
  const late = makeVehicle(1);
  const early = makeVehicle(9);
  const control = makeControl([late, early], [facility]);

  resetSimClock(10);
  control.request(early, facility);
  resetSimClock(50);
  control.request(late, facility);
  control.update();

  assert.equal(control.statusOf(early), CLEARED);
  assert.equal(control.statusOf(late), HOLDING);
});

test('an exact tie on request tick is broken by vehicle id, not array order', () => {
  resetSimClock(7);
  const facility = makeFacility();
  const high = makeVehicle(8);
  const low = makeVehicle(3);
  const control = makeControl([high, low], [facility]);

  control.request(high, facility);
  control.request(low, facility);
  control.update();

  assert.equal(control.statusOf(low), CLEARED, 'lower id wins an exact tie');
  assert.equal(control.statusOf(high), HOLDING);
});

test('holding slots are unique, and a fifth waiter does not alias the first', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const fleet = [1, 2, 3, 4, 5, 6].map(makeVehicle);
  const control = makeControl(fleet, [facility]);

  for (const v of fleet) control.request(v, facility);
  control.update();

  const holders = fleet.filter((v) => control.statusOf(v) === HOLDING);
  const slots = holders.map((v) => v.clearance.slot);
  assert.equal(new Set(slots).size, slots.length, 'slot indices must be unique');

  // The real regression: the old allocators kept indices unique while the ring
  // angle was `slot * 2π/4`, so slot 4 landed on the identical world point as
  // slot 0. Uniqueness of the *index* was never the property that mattered.
  const points = holders.map((v) => control.holdingFix(v, facility));
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
      assert.ok(d > 1, `holding fixes ${i} and ${j} coincide (distance ${d.toFixed(3)})`);
    }
  }
});

test('holding fixes sit outside the approach corridor they are waiting on', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const fleet = [1, 2, 3, 4, 5].map(makeVehicle);
  const control = makeControl(fleet, [facility]);
  for (const v of fleet) control.request(v, facility);
  control.update();

  for (const v of fleet.filter((x) => control.statusOf(x) === HOLDING)) {
    const fix = control.holdingFix(v, facility);
    const d = Math.hypot(fix.x - facility.x, fix.z - facility.z);
    assert.ok(
      d > APPROACH_RADIUS,
      `a waiter would park at ${d.toFixed(1)}, inside the ${APPROACH_RADIUS} corridor`
    );
  }
});

test('a clearance that never becomes a dock is revoked and passed to the next in line', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const stuck = makeVehicle(1);
  const waiting = makeVehicle(2);
  const control = makeControl([stuck, waiting], [facility]);

  control.request(stuck, facility);
  control.request(waiting, facility);
  control.update();
  assert.equal(control.statusOf(stuck), CLEARED);
  assert.equal(control.statusOf(waiting), HOLDING);

  // It holds the corridor and never arrives. Well past the lease.
  resetSimClock(60 * 120);
  control.update();

  assert.equal(control.statusOf(waiting), CLEARED, 'the queue must drain past a stuck holder');
  assert.equal(control.statusOf(stuck), HOLDING, 'the stuck vehicle goes to the back');
  assert.equal(stuck.clearance.revokes, 1);
});

test('a docked vehicle keeps the corridor indefinitely — the lease bounds approach, not service', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const hauler = makeVehicle(1);
  const waiting = makeVehicle(2);
  const control = makeControl([hauler, waiting], [facility]);

  control.request(hauler, facility);
  control.request(waiting, facility);
  control.update();
  assert.ok(control.markDocked(hauler));

  resetSimClock(60 * 600); // ten simulated minutes of unloading
  control.update();

  assert.equal(control.statusOf(hauler), DOCKED, 'a long unload must not be revoked');
  assert.equal(control.statusOf(waiting), HOLDING, 'and must not let anyone else in');
});

test('repeated revokes report the vehicle as genuinely stuck', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const stuck = makeVehicle(1);
  const other = makeVehicle(2);
  const control = makeControl([stuck, other], [facility]);
  control.request(stuck, facility);
  control.request(other, facility);

  assert.equal(control.isStuck(stuck), false);
  // Both vehicles take a turn holding the corridor and failing to arrive.
  for (let i = 1; i <= 4; i++) {
    resetSimClock(60 * 120 * i);
    control.update();
  }
  assert.equal(control.isStuck(stuck), true, 'a vehicle revoked repeatedly is not merely waiting');
});

test('a destroyed claimant frees its slot with no explicit release', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const doomed = makeVehicle(1);
  const survivor = makeVehicle(2);
  const fleet = [doomed, survivor];
  const control = makeControl(fleet, [facility]);

  control.request(doomed, facility);
  control.request(survivor, facility);
  control.update();
  assert.equal(control.statusOf(doomed), CLEARED);

  // Destroyed and flushed out of the fleet — the old design needed an
  // onDestroy hook here, and released against a *searched* facility.
  fleet.splice(fleet.indexOf(doomed), 1);
  control.update();

  assert.equal(control.statusOf(survivor), CLEARED, 'the corridor must not stay held by a corpse');
  assert.equal(control.queueDepth(facility), 0);
});

test('a vehicle marked dead but not yet flushed also releases its claim', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const dying = makeVehicle(1);
  const survivor = makeVehicle(2);
  const control = makeControl([dying, survivor], [facility]);
  control.request(dying, facility);
  control.request(survivor, facility);
  control.update();

  dying.dead = true;
  control.update();

  assert.equal(dying.clearance, null);
  assert.equal(control.statusOf(survivor), CLEARED);
});

test('a destroyed facility clears every claim against it', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const a = makeVehicle(1);
  const b = makeVehicle(2);
  const control = makeControl([a, b], [facility]);
  control.request(a, facility);
  control.request(b, facility);
  control.update();

  facility.dead = true;
  control.update();

  assert.equal(a.clearance, null);
  assert.equal(b.clearance, null);
});

test('a restored fleet with two conflicting claims is repaired by the rebuild', () => {
  // Exactly the snapshot case: `queuePosition` used to be serialized while the
  // facility's Set was not, so a load could leave two vehicles believing they
  // held the same thing. Here both are restored mid-approach.
  resetSimClock(500);
  const facility = makeFacility();
  const early = makeVehicle(4);
  const late = makeVehicle(5);
  early.clearance = {
    facilityId: facility.id, kind: 'dock', slot: null,
    status: CLEARED, requestedTick: 100, grantedAt: null, revokes: 0,
  };
  late.clearance = {
    facilityId: facility.id, kind: 'dock', slot: null,
    status: CLEARED, requestedTick: 300, grantedAt: null, revokes: 0,
  };
  const control = makeControl([early, late], [facility]);

  control.update();

  assert.equal(control.statusOf(early), CLEARED, 'the earlier request keeps the corridor');
  assert.equal(control.statusOf(late), HOLDING, 'the conflicting claim is demoted, not honoured');
  assert.notEqual(late.clearance.slot, null, 'and is given a real holding slot');
});

test('a vehicle in service supersedes one merely cleared to approach', () => {
  resetSimClock(500);
  const facility = makeFacility();
  const docked = makeVehicle(1);
  const approaching = makeVehicle(2);
  docked.clearance = {
    facilityId: facility.id, kind: 'dock', slot: null,
    status: DOCKED, requestedTick: 10, grantedAt: null, revokes: 0,
  };
  approaching.clearance = {
    facilityId: facility.id, kind: 'dock', slot: null,
    status: CLEARED, requestedTick: 5, grantedAt: null, revokes: 0,
  };
  const control = makeControl([docked, approaching], [facility]);

  control.update();

  assert.equal(control.statusOf(docked), DOCKED);
  assert.equal(
    control.statusOf(approaching),
    HOLDING,
    'nobody may be in the corridor while the service point is occupied'
  );
});

test('rebuilding twice from identical state produces identical assignments', () => {
  const build = () => {
    resetSimClock(0);
    const facility = makeFacility();
    const fleet = [3, 1, 4, 2].map(makeVehicle);
    const control = makeControl(fleet, [facility]);
    for (const v of fleet) control.request(v, facility);
    control.update();
    return fleet.map((v) => [v.id, control.statusOf(v), v.clearance.slot]);
  };
  assert.deepEqual(build(), build());
});

test('requesting every tick does not reset a vehicle place in the queue', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const persistent = makeVehicle(1);
  const quiet = makeVehicle(2);
  const control = makeControl([persistent, quiet], [facility]);

  control.request(persistent, facility);
  resetSimClock(5);
  control.request(quiet, facility);
  control.update();
  assert.equal(control.statusOf(persistent), CLEARED);

  // persistent keeps asking; that must not push it behind quiet, nor keep
  // re-granting it the corridor ahead of a longer-waiting vehicle.
  const grantedAt = persistent.clearance.grantedAt;
  resetSimClock(20);
  control.request(persistent, facility);
  control.update();
  assert.equal(persistent.clearance.requestedTick, 0, 'the original request tick must survive');
  assert.equal(persistent.clearance.grantedAt, grantedAt, 'and the lease clock must not restart');
});

test('holding fixes avoid water when the terrain probe refuses a candidate', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const v = makeVehicle(1);
  // Everything at positive x is under water; the nudge fan must find dry ground.
  const heightmap = { heightAt: (x) => (x > 0 ? -5 : 20), seaLevelY: 0 };
  const control = new FacilityControl({
    vehicles: { instances: [v] },
    structures: { instances: [facility] },
    heightmap,
  });
  control.request(v, facility);
  control.update();
  // Force it to hold at slot 0, whose unnudged angle points straight at +x.
  v.clearance.status = HOLDING;
  v.clearance.slot = 0;

  const fix = control.holdingFix(v, facility);
  assert.ok(
    heightmap.heightAt(fix.x) > heightmap.seaLevelY,
    'a holding fix must not be assigned in water when dry ground is reachable'
  );
});


test('a vehicle far from the facility is not under ground control at all', () => {
  // The regression this exists for: clearance used to be requested the moment a
  // harvester left its field, so the lease was timing an entire cross-map drive
  // instead of an approach. Nothing could finish that drive inside the lease,
  // so every grant was revoked in turn and the corridor rotated between four
  // equally-distant harvesters forever, delivering nothing. Bounding the
  // approach and bounding the journey are not the same statement.
  resetSimClock(0);
  const facility = makeFacility(1, { x: 0, z: 0 });
  const near = makeVehicle(1, { x: 40, z: 0 });
  const far = makeVehicle(2, { x: TERMINAL_RADIUS + 200, z: 0 });
  const control = makeControl([near, far], [facility]);

  assert.equal(control.inTerminalArea(near, facility), true);
  assert.equal(
    control.inTerminalArea(far, facility),
    false,
    'a vehicle still crossing the map has no contention to manage'
  );
});

test('the terminal area is comfortably outside the holding ring', () => {
  // If these crossed, a holding vehicle would sit outside the area its own
  // claim is valid in and oscillate across the boundary, dropping and
  // re-taking a slot every few ticks.
  resetSimClock(0);
  const facility = makeFacility();
  const fleet = [1, 2, 3, 4, 5, 6].map((id) => makeVehicle(id));
  const control = makeControl(fleet, [facility]);
  for (const v of fleet) control.request(v, facility);
  control.update();

  for (const v of fleet.filter((x) => control.statusOf(x) === HOLDING)) {
    const fix = control.holdingFix(v, facility);
    const d = Math.hypot(fix.x - facility.x, fix.z - facility.z);
    assert.ok(d > APPROACH_RADIUS, `holding fix at ${d.toFixed(1)} is inside the corridor`);
    assert.ok(d < TERMINAL_RADIUS, `holding fix at ${d.toFixed(1)} is outside the terminal area`);
  }
});

test('the corridor is granted on request when nothing holds it', () => {
  // Deferring the grant to the next _promote bounced every ordinary approach
  // through a holding state for a tick, issuing an order it immediately threw
  // away.
  resetSimClock(0);
  const facility = makeFacility();
  const v = makeVehicle(1);
  const control = makeControl([v], [facility]);
  assert.equal(control.request(v, facility), CLEARED);
});

test('two vehicles requesting on the same tick do not both get the corridor', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const a = makeVehicle(1);
  const b = makeVehicle(2);
  const control = makeControl([a, b], [facility]);
  const first = control.request(a, facility);
  const second = control.request(b, facility);
  assert.equal(first, CLEARED);
  assert.equal(second, HOLDING, 'the second must not also be told the corridor is free');
});

test('requeue keeps the revoke count that release+request would discard', () => {
  resetSimClock(0);
  const facility = makeFacility();
  const v = makeVehicle(1);
  const control = makeControl([v], [facility]);
  control.request(v, facility);
  v.clearance.revokes = 3;

  control.requeue(v);
  assert.equal(v.clearance.status, HOLDING);
  assert.equal(v.clearance.revokes, 4, 'evidence of being stuck must survive a requeue');
  assert.equal(control.isStuck(v), true);
});
