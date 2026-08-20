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

test('an online match never sees this machine\'s own custom vehicles', () => {
  // Still the core rule. Online, the vehicle set comes from the match — a
  // vehicle only this client has is exactly the id no peer can resolve.
  const catalog = catalogFor('multiplayer-online', [custom('My Tank')]);
  assert.deepEqual(catalog, VEHICLE_CATALOG, 'the built-in catalog, untouched');
});

test('an online match uses the vehicle set the match supplied', () => {
  // Pinned from the host's loadout at lobby creation and relayed to every peer
  // in `welcome`, so all of them resolve a given defId to the same bytes.
  const fromHost = custom('Host Tank');
  const catalog = catalogFor('multiplayer-online', [], [fromHost]);
  assert.equal(catalog.length, VEHICLE_CATALOG.length + 1);
  assert.ok(catalog.some((d) => d.id === fromHost.id));
});

test('online, match-supplied vehicles are used and local ones ignored — never merged', () => {
  // The load-bearing case. Mixing the two would put a vehicle in one peer's
  // catalog that no other peer has, which is the whole failure this file
  // exists to prevent — and it would do it while *looking* like the feature
  // was working, because the authoring client would see its own vehicle fine.
  const mine = custom('Mine');
  const theirs = custom('Theirs');
  const catalog = catalogFor('multiplayer-online', [mine], [theirs]);
  assert.equal(catalog.length, VEHICLE_CATALOG.length + 1, 'exactly one extra');
  assert.ok(catalog.some((d) => d.id === theirs.id), 'the match set is present');
  assert.ok(!catalog.some((d) => d === mine), 'the local def is absent');
});

test('match-supplied vehicles reach only the mode that is allowed them', () => {
  // matchDefs must not leak into an offline mode either: the allowlist runs in
  // both directions, so an offline mode reads local vehicles and nothing else.
  const theirs = custom('Theirs');
  for (const mode of ['sandbox', 'multiplayer-ai']) {
    assert.deepEqual(catalogFor(mode, [], [theirs]), VEHICLE_CATALOG, mode);
  }
  for (const mode of ['some-future-mode', undefined, null, '']) {
    assert.deepEqual(catalogFor(mode, [], [theirs]), VEHICLE_CATALOG, String(mode));
  }
});

test('a draft never reaches a match, even supplied by the host', () => {
  const draft = { ...blankDef('Half Done'), draft: true };
  assert.deepEqual(catalogFor('multiplayer-online', [], [draft]), VEHICLE_CATALOG);
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
