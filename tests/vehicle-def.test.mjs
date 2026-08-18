/**
 * The vehicle-builder's def model.
 *
 * Two things here are worth more than the rest: the round-trip test, which is
 * what keeps `catalog.js` pure data (the day someone puts a function or a
 * THREE object in a def, every saved custom vehicle silently stops
 * round-tripping through the saves API), and the lights-block test, because a
 * def missing that block does not render badly — `buildLights` throws.
 *
 * Dependency-free: defs are plain objects, so none of this needs a browser,
 * a renderer, or a database.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';
import {
  blankDef, cloneDef, forkDef, validateDef, customIdFor, isCustomId, CUSTOM_ID_PREFIX,
} from '../src/builder/vehicleDraft.js';

test('a blank def is immediately valid — the editor never opens on a broken vehicle', () => {
  assert.deepEqual(validateDef(blankDef()), []);
});

test('a blank def carries the blocks buildVehicleMesh dereferences without a default', () => {
  // vehicleFactory.js reads def.lights unconditionally and buildLights reads
  // these fields with no fallback. Absent, the mesh builder throws rather than
  // degrading, so this is a hard requirement and not a nicety.
  const def = blankDef();
  assert.ok(def.lights, 'lights block present');
  for (const key of ['headlampInset', 'headlampDrop', 'beamColor', 'tailColor', 'reverseColor']) {
    assert.notEqual(def.lights[key], undefined, `lights.${key} present`);
  }
  assert.ok(def.dims && def.colors, 'dims and colors present');
});

test('a def with no lights block is rejected, not quietly accepted', () => {
  const def = blankDef();
  delete def.lights;
  const problems = validateDef(def);
  assert.ok(
    problems.some((p) => p.includes('lights')),
    `expected a lights problem, got: ${problems.join('; ')}`
  );
});

test('`axles` disagreeing with axleFractions is caught', () => {
  // axleOffsets() maps axleFractions directly and never reads `axles`, so a
  // mismatch means the number is a lie about the vehicle it describes.
  const def = blankDef();
  def.axles = 3; // but axleFractions still lists 2
  const problems = validateDef(def);
  assert.ok(
    problems.some((p) => p.includes('axleFractions lists 2')),
    `expected the count mismatch, got: ${problems.join('; ')}`
  );
});

test('steerRatios is checked against the real axle count, not the `axles` field', () => {
  const def = blankDef();
  def.axles = 3;
  def.axleFractions = [1.0, 0, -1.0]; // the true count is now 3
  // steerRatios still holds 2 — that is the genuine inconsistency here.
  const problems = validateDef(def);
  assert.ok(
    problems.some((p) => p.includes('steerRatios')),
    `expected a steerRatios problem, got: ${problems.join('; ')}`
  );
});

test('the axle fields are optional, exactly as vehicleFactory treats them', () => {
  // scout-buggy ships with no axles/axleFractions/steerRatios at all —
  // axleOffsets() defaults to two. A validator stricter than the engine would
  // reject vehicles the game already renders, so this pins the looser rule.
  const def = blankDef();
  delete def.axles;
  delete def.axleFractions;
  delete def.steerRatios;
  assert.deepEqual(validateDef(def), []);
});

test('a single axle is rejected — axleOffsets divides by (count - 1)', () => {
  // Not a style rule: for counts above two axleOffsets() spreads axles with
  // `2 * axleX * i / (count - 1)`, so count 1 produces NaN offsets and a
  // vehicle whose wheels are at no position at all.
  const def = blankDef();
  def.axles = 1;
  delete def.axleFractions;
  delete def.steerRatios;
  assert.ok(validateDef(def).some((p) => p.includes('2 or more')));
});

test('non-finite numbers are rejected wherever they appear', () => {
  const def = blankDef();
  def.dims.hullLength = NaN;
  def.speed = Infinity;
  def.axleFractions = [1.0, NaN];
  const problems = validateDef(def);
  assert.ok(problems.some((p) => p.includes('hullLength')));
  assert.ok(problems.some((p) => p.includes('speed')));
  assert.ok(problems.some((p) => p.includes('axle position')));
});

test('a custom id can never collide with a built-in vehicle', () => {
  for (const builtIn of VEHICLE_CATALOG) {
    assert.equal(isCustomId(builtIn.id), false, `${builtIn.id} is not custom-namespaced`);
    assert.notEqual(customIdFor(builtIn.name), builtIn.id, `${builtIn.name} slugs away from its built-in id`);
  }
});

test('an id already in the catalog is rejected', () => {
  const def = blankDef();
  // Force the collision the namespace normally prevents, to prove the check
  // itself works and not merely that the prefix keeps ids apart.
  def.id = VEHICLE_CATALOG[0].id;
  const problems = validateDef(def);
  assert.ok(problems.some((p) => p.includes('already taken') || p.includes(CUSTOM_ID_PREFIX)));
});

test('a name that slugs to nothing is rejected rather than saved as "custom:"', () => {
  const def = blankDef('!!!');
  assert.equal(def.id, CUSTOM_ID_PREFIX);
  assert.ok(validateDef(def).some((p) => p.includes('empty id')));
});

test('every built-in vehicle survives a JSON round trip', () => {
  // The save format is JSON. This is the check that catches a def gaining a
  // function, a THREE object, undefined, or NaN — none of which survive
  // JSON.stringify, and all of which would corrupt a saved custom vehicle
  // derived from that def without any other test noticing.
  for (const def of VEHICLE_CATALOG) {
    assert.deepEqual(cloneDef(def), def, `${def.id} round-trips unchanged`);
  }
});

test('forking a built-in produces an editable, valid, non-colliding copy', () => {
  const source = VEHICLE_CATALOG[0];
  const fork = forkDef(source, 'My Buggy');

  assert.deepEqual(validateDef(fork), [], 'a fork of a shipped vehicle is valid');
  assert.equal(fork.id, 'custom:my-buggy');
  assert.notEqual(fork.id, source.id);
  // A deep copy, not a shared reference — editing the fork must not reach back
  // into the catalog the whole game reads from.
  fork.dims.hullLength = 999;
  assert.notEqual(source.dims.hullLength, 999, 'the built-in is untouched');
});
