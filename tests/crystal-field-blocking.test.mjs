/**
 * Blocking a crystal field for one team's harvesters.
 *
 * Two things are exercised: the intent layer (`net/intents.js`'s
 * `blockField` and the block-awareness added to `harvest`), and
 * `harvesterAI._idle`'s three reject tiers, which must treat a field blocked
 * for a harvester's own team the same way they treat one that's dead or
 * banned — never selected, at any tier.
 *
 * The mock `nearestTo` here mirrors blooms.js's real algorithm exactly (see
 * harvester-field-selection.test.mjs, which this borrows its scaffolding
 * from): distance plus a `reject` callback, nothing else. That is what makes
 * a bug in harvesterAI's own reject clauses — as opposed to a bug in
 * `nearestTo` — the only way these tests can fail.
 *
 * Dependency-free: real `HarvesterAI` and `applyIntent`, plain mock instances.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HarvesterAI } from '../src/vehicles/harvesterAI.js';
import { Intent, applyIntent } from '../src/net/intents.js';

const DRY_HEIGHTMAP = { heightAt: () => 10, seaLevelY: 0 };

/** Mirrors Blooms.nearestTo's real algorithm (terrain/blooms.js). */
function makeBlooms(fields) {
  return {
    fields,
    nearestTo(x, z, { minStock = 1, reject = null } = {}) {
      let best = null;
      let bestD = Infinity;
      for (const f of fields) {
        if (f.dead || f.stock < minStock) continue;
        if (reject?.(f)) continue;
        const d = Math.hypot(f.x - x, f.z - z);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      return best;
    },
  };
}

function makeField(id, x, z, { stock = 900, capacity = 900, blockedByTeam } = {}) {
  return { id, x, z, stock, capacity, dead: false, blockedByTeam };
}

function makeHarvester(id, teamId = 0, { x = 0, z = 0 } = {}) {
  return {
    id,
    kind: 'vehicle',
    teamId,
    def: { capacity: 320 },
    dead: false,
    group: { position: { x, y: 0, z } },
    setTarget() {
      return true;
    },
  };
}

function makeAI(fields, harvesters) {
  return new HarvesterAI({
    vehicles: { instances: harvesters },
    world: { blooms: makeBlooms(fields) },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [] },
    game: {},
    facilityControl: null,
  });
}

// ---- applyIntent: blockField ----

test('blockField sets and clears a block for the acting team', () => {
  const field = makeField(1, 0, 0);
  const ctx = { world: { blooms: { fields: [field] } } };

  assert.equal(applyIntent(Intent.blockField(1, 0, true), ctx, 0), true);
  assert.ok(field.blockedByTeam.has(0));

  assert.equal(applyIntent(Intent.blockField(1, 0, false), ctx, 0), true);
  assert.equal(field.blockedByTeam.has(0), false);
});

test('blockField refuses to set another team\'s block', () => {
  const field = makeField(1, 0, 0);
  const ctx = { world: { blooms: { fields: [field] } } };

  // teamId (from the roster) is 0; the intent claims to be team 1.
  assert.equal(applyIntent(Intent.blockField(1, 1, true), ctx, 0), false);
  assert.equal(field.blockedByTeam, undefined, 'nothing was touched');
});

test('blockField on an unknown field is a no-op, not a throw', () => {
  const ctx = { world: { blooms: { fields: [] } } };
  assert.equal(applyIntent(Intent.blockField(99, 0, true), ctx, 0), false);
});

test('two teams can independently block the same field', () => {
  const field = makeField(1, 0, 0);
  const ctx = { world: { blooms: { fields: [field] } } };

  applyIntent(Intent.blockField(1, 0, true), ctx, 0);
  applyIntent(Intent.blockField(1, 1, true), ctx, 1);
  assert.ok(field.blockedByTeam.has(0));
  assert.ok(field.blockedByTeam.has(1));

  applyIntent(Intent.blockField(1, 0, false), ctx, 0);
  assert.equal(field.blockedByTeam.has(0), false, 'team 0 cleared its own block');
  assert.ok(field.blockedByTeam.has(1), 'and did not touch team 1\'s');
});

// ---- applyIntent: harvest respects a block ----

function makeHarvestCtx(field, harvester) {
  return {
    vehicles: { instances: [harvester] },
    world: { blooms: { fields: [field] } },
  };
}

test('a harvest order to a blocked field is refused', () => {
  const field = makeField(1, 50, 0, { blockedByTeam: new Set([0]) });
  const harvester = makeHarvester(1, 0);
  const ctx = makeHarvestCtx(field, harvester);

  assert.equal(applyIntent(Intent.harvest(1, 1), ctx, 0), false);
  assert.equal(harvester.targetField, undefined);
});

test('a harvest order to a field blocked for a different team still succeeds', () => {
  const field = makeField(1, 50, 0, { blockedByTeam: new Set([1]) }); // blocked for team 1, not 0
  const harvester = makeHarvester(1, 0);
  const ctx = makeHarvestCtx(field, harvester);

  assert.equal(applyIntent(Intent.harvest(1, 1), ctx, 0), true);
  assert.equal(harvester.targetField, field);
});

test('unblocking restores manual harvest orders', () => {
  const field = makeField(1, 50, 0, { blockedByTeam: new Set([0]) });
  const harvester = makeHarvester(1, 0);
  const ctx = makeHarvestCtx(field, harvester);

  assert.equal(applyIntent(Intent.harvest(1, 1), ctx, 0), false);
  field.blockedByTeam.delete(0);
  assert.equal(applyIntent(Intent.harvest(1, 1), ctx, 0), true);
});

// ---- harvesterAI._idle: all three tiers respect a block ----

test('an idle harvester never targets a field blocked for its own team, even when it is the only one reachable', () => {
  const blocked = makeField('A', 10, 0, { blockedByTeam: new Set([0]) });
  const harvester = makeHarvester('X', 0);
  const ai = makeAI([blocked], [harvester]);

  ai._idle(harvester, ai._stateFor(harvester));

  // Every tier came up empty, same as if the field didn't exist at all: the
  // harvester has nothing to do rather than being sent to blocked ground.
  assert.equal(ai.stateOf(harvester).field, null);
});

test('an idle harvester skips a blocked field in favour of an open one, however much nearer the blocked one is', () => {
  const blocked = makeField('near', 1, 0, { blockedByTeam: new Set([0]) });
  const open = makeField('far', 40, 0);
  const harvester = makeHarvester('X', 0);
  const ai = makeAI([blocked, open], [harvester]);

  ai._idle(harvester, ai._stateFor(harvester));

  assert.equal(ai.stateOf(harvester).field.id, 'far');
});

test('a field blocked for another team is not blocked for this one', () => {
  const field = makeField('A', 10, 0, { blockedByTeam: new Set([1]) }); // team 1's block, not team 0's
  const harvester = makeHarvester('X', 0);
  const ai = makeAI([field], [harvester]);

  ai._idle(harvester, ai._stateFor(harvester));

  assert.equal(ai.stateOf(harvester).field.id, 'A', 'team 0 is unaffected by team 1\'s block');
});

test('two harvesters of different teams route differently around the same block', () => {
  const blocked = makeField('near', 1, 0, { blockedByTeam: new Set([0]) }); // blocked for team 0 only
  const open = makeField('far', 40, 0);
  const teamZero = makeHarvester('X', 0);
  const teamOne = makeHarvester('Y', 1);
  const ai = makeAI([blocked, open], [teamZero, teamOne]);

  ai._idle(teamZero, ai._stateFor(teamZero));
  ai._idle(teamOne, ai._stateFor(teamOne));

  assert.equal(ai.stateOf(teamZero).field.id, 'far', 'team 0 detours around its own block');
  assert.equal(ai.stateOf(teamOne).field.id, 'near', 'team 1 was never told to avoid it');
});

test('unblocking a field makes it selectable again', () => {
  const field = makeField('A', 10, 0, { blockedByTeam: new Set([0]) });
  const harvester = makeHarvester('X', 0);
  const ai = makeAI([field], [harvester]);

  ai._idle(harvester, ai._stateFor(harvester));
  assert.equal(ai.stateOf(harvester).field, null, 'blocked, so nothing was picked');

  field.blockedByTeam.delete(0);
  ai._idle(harvester, ai._stateFor(harvester));
  assert.equal(ai.stateOf(harvester).field.id, 'A', 'and now it is');
});
