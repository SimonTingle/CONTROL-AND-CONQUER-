/**
 * Tracked vehicles: the rules that differ from a wheeled one.
 *
 * The interesting case is steering. `steeringWheelbase` returns Infinity for a
 * vehicle with no steered axle — correct, since the bicycle model genuinely
 * does not describe a track — but every consumer that divides by it then
 * concludes a tank can only drive in a straight line, which is the opposite of
 * true. These pin the replacements.
 *
 * Geometry-free: only the pure helpers are exercised, so this needs no WebGL.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTracked, roadWheelCount, trackThicknessOf, turningCircleOf, rigOf, steeringWheelbase,
} from '../src/vehicles/vehicleFactory.js';
import { blankDef, validateDef, syncId } from '../src/builder/vehicleDraft.js';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';

function tank(overrides = {}) {
  const def = blankDef('Tank');
  def.shape.tracked = true;
  def.steerRatios = [0, 0];
  Object.assign(def, overrides);
  // Ids are content-addressed, so anything that edits a def has to re-derive
  // it — the editor does this in onEdit for exactly the same reason.
  return syncId(def);
}

test('exactly the tracked-* vehicles are tracked, and nothing else changed underfoot', () => {
  for (const def of VEHICLE_CATALOG) {
    const expectTracked = def.id === 'tracked-harvester' || def.id === 'tracked-tank' || def.id === 'heavy-tracked-tank';
    assert.equal(isTracked(def), expectTracked, `${def.id} tracked flag`);
  }
});

test('a tracked def is valid and renders through the same validator', () => {
  assert.deepEqual(validateDef(tank()), []);
});

test('a track with no steered axle has an infinite wheelbase — and must not use it', () => {
  // The premise the turning-circle override exists for. If this ever stops
  // being Infinity the override is dead code and should go.
  const t = tank();
  assert.equal(steeringWheelbase(rigOf(t).offsets, [0, 0]), Infinity);
  // The vehicle pivots about its centre, so its circle is its own width.
  const circle = turningCircleOf(t);
  assert.ok(Number.isFinite(circle), 'a tank has a finite turning circle');
  assert.equal(circle, rigOf(t).track);
});

test('a wheeled vehicle keeps the bicycle-model turning circle exactly', () => {
  // The tracked branch must not have changed the wheeled answer.
  for (const def of VEHICLE_CATALOG) {
    if (isTracked(def)) continue;
    const expected = (rigOf(def).wheelbase / Math.tan(def.maxSteerAngle)) * 2;
    assert.equal(turningCircleOf(def), expected, `${def.id} unchanged`);
  }
});

test('every shipped tracked vehicle uses the pivot turning circle, not the bicycle one', () => {
  for (const def of VEHICLE_CATALOG) {
    if (!isTracked(def)) continue;
    assert.equal(turningCircleOf(def), rigOf(def).track, `${def.id} pivots on its own width`);
  }
});

test('road wheels default sensibly and never drop below two', () => {
  assert.equal(roadWheelCount(tank()), 5);
  assert.equal(roadWheelCount(tank({ dims: { ...tank().dims, roadWheels: 8 } })), 8);
  // One road wheel is a unicycle; the floor is enforced rather than trusted.
  assert.equal(roadWheelCount(tank({ dims: { ...tank().dims, roadWheels: 1 } })), 2);
  assert.equal(roadWheelCount(tank({ dims: { ...tank().dims, roadWheels: undefined } })), 5);
});

test('belt thickness must stay under the wheel radius or the loop has no hole', () => {
  // The belt is an outline with the same outline inset by the thickness cut
  // out of it. At or beyond the wheel radius that hole collapses and the
  // running gear becomes a solid slab.
  const bad = tank();
  bad.dims.trackThickness = bad.dims.wheelRadius;
  assert.ok(validateDef(bad).some((p) => p.includes('trackThickness')));

  const ok = tank();
  ok.dims.trackThickness = ok.dims.wheelRadius * 0.5;
  assert.deepEqual(validateDef(syncId(ok)), []);
});

test('a tracked vehicle with no pivot rate is rejected — it would never turn', () => {
  const t = tank();
  t.pivotRate = 0;
  assert.ok(validateDef(t).some((p) => p.includes('pivotRate')));
});

test('track defaults are derived from the wheel, so a bare tracked def still builds', () => {
  const t = tank();
  delete t.dims.trackThickness;
  assert.deepEqual(validateDef(syncId(t)), [], 'optional, like the axle fields');
  assert.ok(trackThicknessOf(t) > 0, 'still resolves to a real thickness');
  assert.ok(trackThicknessOf(t) < t.dims.wheelRadius, 'and one the belt can be cut from');
});

test('the track flag is what switches behaviour, not the presence of track dims', () => {
  // A wheeled def that happens to carry trackWidth (say, switched off in the
  // editor) must still steer like a wheeled vehicle.
  const wheeled = blankDef('Lorry');
  wheeled.dims.trackWidth = 1.2;
  wheeled.dims.roadWheels = 6;
  assert.equal(isTracked(wheeled), false);
  assert.ok(Number.isFinite(turningCircleOf(wheeled)));
  assert.notEqual(turningCircleOf(wheeled), rigOf(wheeled).track);
});
