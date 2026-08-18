/**
 * The boundary that keeps author-built vehicles out of a lockstep match.
 *
 * Only `defId` strings cross the wire — snapshot.js serialises `defId` and the
 * far end resolves it against *its own* catalog, skipping ids it doesn't know.
 * So a vehicle one peer built and the other has never seen doesn't produce an
 * error, it produces a unit that exists on one screen and not the other: the
 * exact silent divergence three rounds of multiplayer fixes were spent
 * removing. `catalogFor()` is the single place that can let one in.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';
import { catalogFor } from '../src/builder/customCatalog.js';
import { blankDef } from '../src/builder/vehicleDraft.js';

const custom = (name) => ({ ...blankDef(name), draft: false });

test('custom vehicles are available offline', () => {
  const mine = custom('My Tank');
  for (const mode of ['sandbox', 'multiplayer-ai']) {
    const catalog = catalogFor(mode, [mine]);
    assert.equal(catalog.length, VEHICLE_CATALOG.length + 1, `${mode} includes it`);
    assert.ok(catalog.some((d) => d.id === mine.id));
  }
});

test('an online match never sees a custom vehicle', () => {
  const catalog = catalogFor('multiplayer-online', [custom('My Tank')]);
  assert.deepEqual(catalog, VEHICLE_CATALOG, 'the built-in catalog, untouched');
});

test('an unknown mode is treated as unsafe, not assumed offline', () => {
  // The fail-closed rule. Every desync this project has had came from a path
  // that let through anything it did not specifically recognise; a mode added
  // later must opt in to custom vehicles rather than inherit permission.
  for (const mode of ['some-future-mode', undefined, null, '']) {
    assert.deepEqual(
      catalogFor(mode, [custom('My Tank')]),
      VEHICLE_CATALOG,
      `mode ${String(mode)} must not get custom vehicles by default`
    );
  }
});

test('drafts stay in the editor even offline', () => {
  const draft = { ...blankDef('Half Done'), draft: true };
  assert.deepEqual(catalogFor('sandbox', [draft]), VEHICLE_CATALOG);
});

test('the built-in catalog is never mutated by merging', () => {
  const before = VEHICLE_CATALOG.length;
  catalogFor('sandbox', [custom('A'), custom('B')]);
  assert.equal(VEHICLE_CATALOG.length, before, 'merging returns a new array, it does not push');
});
