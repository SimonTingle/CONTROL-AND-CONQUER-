/**
 * Which units a structure can build — including author-built ones.
 *
 * `producedBy` was inert before this: every catalog def carried it, nothing
 * read it, and the live link was the *structure's* `produces` array. That is
 * fine for built-ins and impossible for custom vehicles, since a player cannot
 * edit structures.js. `producedUnitIds` is what made the field mean something,
 * so these pin both halves: custom vehicles get in, and the built-in game does
 * not move when there are none.
 *
 * Dependency-free — plain objects standing in for the structure def and the
 * vehicle controller.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { producedUnitIds, commandsFor } from '../src/vehicles/commands.js';
import { STRUCTURE_CATALOG } from '../src/structures/structures.js';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';
import { blankDef } from '../src/builder/vehicleDraft.js';

const structure = (id) => STRUCTURE_CATALOG.find((d) => d.id === id);
/** The only part of the real controller this reads. */
const ctxWith = (...extraDefs) => ({ vehicles: { extraDefs } });

/** Enough of a ctx for commandsFor's own enabled()/hint()/label() calls, not just producedUnitIds. */
function fullCtxWith(...extraDefs) {
  return {
    vehicles: { extraDefs, defOf: (id) => VEHICLE_CATALOG.find((d) => d.id === id) ?? extraDefs.find((d) => d.id === id) },
    game: { teamOf: () => ({ credits: 999999, weaponTier: 0 }) },
  };
}

function customFor(name, producedBy) {
  const def = blankDef(name);
  def.producedBy = producedBy;
  return def;
}

test('with no custom vehicles, every structure produces exactly what it always did', () => {
  // The regression guard. If this fails, the built-in game changed.
  for (const def of STRUCTURE_CATALOG) {
    assert.deepEqual(
      producedUnitIds(def, ctxWith()),
      def.produces ?? [],
      `${def.id} unchanged`
    );
  }
});

test('a custom vehicle naming a factory is offered by it, after the built-ins', () => {
  const factory = structure('armed-factory');
  const mine = customFor('My Tank', 'armed-factory');
  const ids = producedUnitIds(factory, ctxWith(mine));

  // Order matters: aiCommander takes the first produced unit matching its
  // wanted tag that is under its cap, so appending means a custom vehicle
  // supplements the AI's build order rather than displacing its first pick.
  assert.deepEqual(ids.slice(0, factory.produces.length), factory.produces, 'built-ins keep their order and position');
  assert.deepEqual(ids.slice(factory.produces.length), [mine.id], 'the custom one is appended');
});

test('the radial menu button shows the custom vehicle\'s name, not its id', () => {
  // buildCommandFor's label used to be computed once from VEHICLE_CATALOG —
  // the built-ins-only array — so a custom unitId never matched and the
  // command fell back to `Build ${unitId}`, i.e. the literal content-hash id
  // ("Build custom:834c51a4f58a34db") in the button a player actually reads.
  const factory = structure('armed-factory');
  const mine = customFor('My Tank', 'armed-factory');
  const instance = { def: factory, mode: 'idle', teamId: 0 };
  const ctx = fullCtxWith(mine);

  const built = commandsFor(instance, ctx).find((c) => c.id === `build-${mine.id}`);
  assert.ok(built, 'the custom vehicle has a build command');
  assert.equal(built.label, 'Build My Tank');
});

test('a built-in factory label is unchanged by resolving label lazily', () => {
  // The fix widens buildCommandFor's label to a function for every unit, not
  // just custom ones — confirm a shipped vehicle's button still reads exactly
  // as it always has.
  const factory = structure('armed-factory');
  const instance = { def: factory, mode: 'idle', teamId: 0 };
  const ctx = fullCtxWith();

  const builtIn = factory.produces[0];
  const expectedName = VEHICLE_CATALOG.find((d) => d.id === builtIn)?.name;
  const cmd = commandsFor(instance, ctx).find((c) => c.id === `build-${builtIn}`);
  assert.equal(cmd.label, `Build ${expectedName}`);
});

test('a custom vehicle is offered only by the factory it names', () => {
  const mine = customFor('My Harvester', 'harvester-facility');
  const ctx = ctxWith(mine);

  assert.ok(producedUnitIds(structure('harvester-facility'), ctx).includes(mine.id));
  assert.ok(!producedUnitIds(structure('armed-factory'), ctx).includes(mine.id));
  // The repair bay produces nothing at all and must not start now.
  assert.deepEqual(producedUnitIds(structure('repair-bay'), ctx), []);
});

test('producedBy null means buildable nowhere', () => {
  const shelfware = customFor('Ornament', null);
  const ctx = ctxWith(shelfware);
  for (const def of STRUCTURE_CATALOG) {
    assert.ok(
      !producedUnitIds(def, ctx).includes(shelfware.id),
      `${def.id} does not offer an unbuildable vehicle`
    );
  }
});

test('a custom vehicle cannot duplicate a built-in entry', () => {
  // Contrived — custom ids are namespaced — but the dedupe is what stops two
  // identical "Build X" commands appearing if that namespacing ever changes.
  const factory = structure('armed-factory');
  const clash = customFor('Clash', 'armed-factory');
  clash.id = factory.produces[0];
  const ids = producedUnitIds(factory, ctxWith(clash));
  assert.deepEqual(ids, factory.produces);
});

test('several custom vehicles on one factory all appear, in order', () => {
  const factory = structure('armed-factory');
  const a = customFor('Alpha', 'armed-factory');
  const b = customFor('Bravo', 'armed-factory');
  const ids = producedUnitIds(factory, ctxWith(a, b));
  assert.deepEqual(ids.slice(factory.produces.length), [a.id, b.id]);
});

test('a missing controller or extraDefs is treated as "no custom vehicles"', () => {
  // producedUnitIds runs from the radial menu and from aiCommander, both of
  // which can be reached before applyCustomCatalog has ever run.
  const factory = structure('armed-factory');
  for (const ctx of [undefined, {}, { vehicles: {} }, ctxWith()]) {
    assert.deepEqual(producedUnitIds(factory, ctx), factory.produces);
  }
});

test('an online match offers no custom vehicles, because extraDefs is empty there', () => {
  // Not a separate check in producedUnitIds — applyCustomCatalog() leaves
  // extraDefs empty online via the fail-closed allowlist in customCatalog.js.
  // This pins the consequence so the two cannot drift apart silently.
  const factory = structure('armed-factory');
  assert.deepEqual(producedUnitIds(factory, ctxWith()), factory.produces);
});
