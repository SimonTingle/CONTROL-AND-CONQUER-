/**
 * The server's stat-bounds check on author-built vehicles.
 *
 * This is the one check a client cannot be trusted to do for itself. A def is
 * authored on one machine and played on everyone else's, and the machine that
 * authored it is exactly the one with a motive to skip the check. Structural
 * validation (does the mesh builder survive this def) stays on the client,
 * where the renderer is; balance stays here.
 *
 * Dependency-free: boundsProblems is pure and imports only the generated
 * bounds table, so this needs no database and no running server.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundsProblems, isWithinBounds } from '../server/src/vehicles/validateDef.js';
import { blankDef, syncId } from '../src/builder/vehicleDraft.js';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';

test('a vehicle straight out of the editor is within bounds', () => {
  assert.deepEqual(boundsProblems(blankDef('Fine')), []);
});

test('an out-of-bounds stat is rejected server-side', () => {
  // Every one of these passed validation before bounds were made binding —
  // the ranges existed only as HTML attributes on a slider.
  for (const [key, value] of [['speed', 1e6], ['maxHealth', 1e9], ['sightRadius', 4000]]) {
    const def = syncId(Object.assign(blankDef('Cheaty'), { [key]: value }));
    assert.ok(
      boundsProblems(def).some((p) => p.startsWith(key)),
      `${key} = ${value} is refused`
    );
    assert.equal(isWithinBounds(def), false);
  }
});

test('a nested turret stat is bounded too', () => {
  const def = blankDef('Sniper');
  def.turret.damage = 1e9;
  assert.ok(boundsProblems(syncId(def)).some((p) => p.startsWith('turret.damage')));
});

test('dormant paths are not bounds-checked — the shipped turretless vehicles prove why', () => {
  // base-station and crystal-harvester carry dims.turretRadius: 0, far below
  // the editor's minimum, because they have no turret to size. A validator
  // stricter than the engine would reject vehicles the game renders happily.
  for (const builtIn of VEHICLE_CATALOG.filter((d) => !d.shape?.turret)) {
    const asCustom = { ...builtIn, id: `custom:${builtIn.id}` };
    const problems = boundsProblems(asCustom).filter((p) => p.startsWith('dims.turret') || p.startsWith('dims.barrel'));
    assert.deepEqual(problems, [], `${builtIn.id} has no turret to bounds-check`);
  }
});

test('junk is rejected rather than thrown on', () => {
  for (const junk of [null, undefined, 'a string', 42]) {
    assert.ok(boundsProblems(junk).length > 0, `${String(junk)} is refused`);
  }
});

test('a def with no custom: id is refused', () => {
  // The server pins these into a match by id; a built-in id would shadow a
  // shipped vehicle on every peer that received it.
  const def = { ...blankDef('Impostor'), id: 'light-tank' }; // set after, or syncId would re-derive it
  assert.ok(boundsProblems(def).some((p) => p.includes('custom:')));
});
