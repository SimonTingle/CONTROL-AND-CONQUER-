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
  syncId, canonicalJson,
} from '../src/builder/vehicleDraft.js';
import { deriveBounds, setPath } from '../src/builder/builderSchema.js';

/**
 * Mutate a def the way the editor does — every widget funnels through
 * `onEdit`, which re-derives the id, so a test that changes a stat and then
 * validates has to do the same or it is checking a stale id rather than the
 * thing it means to check.
 */
const edited = (def, mutate) => {
  mutate(def);
  return syncId(def);
};

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
  const def = edited(blankDef(), (d) => {
    delete d.axles;
    delete d.axleFractions;
    delete d.steerRatios;
  });
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
    assert.notEqual(customIdFor(builtIn), builtIn.id, `${builtIn.name} hashes away from its built-in id`);
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

test('the id is content-addressed: naming does not affect it, stats do', () => {
  // The whole point of the scheme. Ids used to be name slugs, so two accounts
  // with entirely different vehicles both called "My Tank" produced the *same*
  // id for different defs — and nothing caught it, because only defId strings
  // cross the wire and snapshot.js skips ids it cannot resolve without
  // erroring. One id has to mean one vehicle, everywhere.
  const a = blankDef('Destroyer');
  const b = blankDef('Peacekeeper');
  assert.equal(a.id, b.id, 'two identical vehicles share an id regardless of name');

  const faster = edited(blankDef('Destroyer'), (d) => { d.speed += 0.5; });
  assert.notEqual(faster.id, a.id, 'a changed stat changes the id');
});

test('a name that would slug to nothing is now simply a valid name', () => {
  // Previously "!!!" produced the bare id "custom:" and had to be rejected.
  // With the id derived from contents, the name is free text and carries no
  // structural meaning at all.
  const def = blankDef('!!!');
  assert.notEqual(def.id, CUSTOM_ID_PREFIX);
  assert.deepEqual(validateDef(def), []);
});

test('key order does not change the id', () => {
  // JSON.stringify preserves insertion order, so without the canonical sort a
  // def rebuilt with its keys assigned in a different sequence — which is
  // exactly what a round trip through a different JSON writer can do — would
  // hash differently and read as a different vehicle.
  const def = blankDef();
  const reordered = {};
  for (const key of Object.keys(def).reverse()) reordered[key] = def[key];
  assert.equal(customIdFor(reordered), customIdFor(def));
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

test('a def whose id does not match its contents is rejected', () => {
  // A hand-edited payload, or one written by the older slug-based build. The
  // id is a claim about the contents; an unchecked claim is worth nothing.
  const def = blankDef();
  def.speed += 0.5; // deliberately *not* re-synced
  assert.ok(
    validateDef(def).some((p) => p.includes('does not match')),
    'a stale id is caught'
  );
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
  assert.ok(isCustomId(fork.id), 'a fork is custom-namespaced');
  assert.notEqual(fork.id, source.id);
  // A deep copy, not a shared reference — editing the fork must not reach back
  // into the catalog the whole game reads from.
  fork.dims.hullLength = 999;
  assert.notEqual(source.dims.hullLength, 999, 'the built-in is untouched');
});

test('producedBy must name a structure that actually produces units', () => {
  const def = blankDef();
  def.producedBy = 'repair-bay'; // real structure, but it produces nothing
  assert.ok(validateDef(def).some((p) => p.includes('producedBy')));

  def.producedBy = 'not-a-structure';
  assert.ok(validateDef(def).some((p) => p.includes('producedBy')));
});

test('the two real factories, and "not buildable", are all accepted', () => {
  for (const producedBy of ['armed-factory', 'harvester-facility', null]) {
    const def = edited(blankDef(), (d) => { d.producedBy = producedBy; });
    assert.deepEqual(validateDef(def), [], `${producedBy} is valid`);
  }
});

test('unlock accepts only the value the picker actually understands', () => {
  // An unrecognised string is not ignored — vehiclePicker leaves the vehicle
  // permanently locked behind a generic "Locked" label, which looks like a bug
  // rather than a typo.
  const def = edited(blankDef(), (d) => { d.unlock = 'exploration'; });
  assert.deepEqual(validateDef(def), []);

  assert.ok(validateDef(edited(def, (d) => { d.unlock = 'someday'; })).some((p) => p.includes('unlock')));
});

test('a negative price is rejected', () => {
  const def = edited(blankDef(), (d) => { d.cost = -50; });
  assert.ok(validateDef(def).some((p) => p.includes('cost')));
  assert.deepEqual(validateDef(edited(def, (d) => { d.cost = 0; })), []); // free is odd but legitimate
});

test('forking every built-in stays valid, including the turretless ones', () => {
  // Not redundant with the scout-buggy fork above. `base-station` and
  // `crystal-harvester` ship with zeroed turret dimensions — far below the
  // editor's minimums — because they have no turret to size. Bounds-checking
  // those paths unconditionally rejected both, which is a validator stricter
  // than the engine that renders them happily.
  for (const builtIn of VEHICLE_CATALOG) {
    // A price, because base-station and crystal-harvester ship without one —
    // they are not bought at a factory. That is a pre-existing rule of its own
    // and not what this test is about.
    const fork = edited(forkDef(builtIn, `Fork of ${builtIn.name}`), (d) => { d.cost ??= 400; });
    assert.deepEqual(
      validateDef(fork), [],
      `a fork of ${builtIn.id} is valid`
    );
  }
});

test('a stat beyond its slider maximum is rejected', () => {
  // The ranges in builderSchema were UI attributes only — validateDef had no
  // upper bound on anything, so these all passed before. Harmless while a def
  // never left the machine that authored it; not harmless once one can arrive
  // from another player.
  const cases = [
    ['speed', 1e6], ['turret.damage', 1e9], ['maxHealth', 999999], ['sightRadius', 5000],
  ];
  for (const [path, value] of cases) {
    const def = edited(blankDef(), (d) => setPath(d, path, value));
    assert.ok(
      validateDef(def).some((p) => p.startsWith(path)),
      `${path} = ${value} is rejected`
    );
  }
});

test('a stat exactly at each slider bound is accepted', () => {
  // The complement of the test above, and the one that would catch an
  // off-by-one turning a legitimate extreme into a rejection.
  for (const [path, { min, max }] of Object.entries(deriveBounds())) {
    for (const edge of [min, max]) {
      const def = edited(blankDef(), (d) => {
        d.shape.turret = true;
        d.shape.tracked = true;
        setPath(d, path, edge);
      });
      // Only bounds-shaped complaints: some fields also carry a cross-field
      // rule that a value at its own extreme can still break (max
      // trackThickness exceeds the default wheelRadius, and must — the belt
      // would swallow the wheel). Those rules are tested on their own.
      const problems = validateDef(def).filter((p) => p.includes('must be between'));
      assert.deepEqual(problems, [], `${path} = ${edge} (its own bound) is accepted`);
    }
  }
});

test('an economy vehicle without harvesting stats is refused', () => {
  // The Production panel offers "Harvester Facility" and the "Economy" role,
  // but blankDef sets no capacity/fillRate/unloadRate and the editor cannot
  // author them. aiCommander buys economy units by tag, so this combination
  // produced a vehicle the AI spends credits on and which can never harvest.
  const def = edited(blankDef(), (d) => {
    d.producedBy = 'harvester-facility';
    d.tags = ['economy'];
  });
  assert.ok(
    validateDef(def).some((p) => p.includes('harvesting stats')),
    'the unbuildable-economy combination is caught'
  );
});
