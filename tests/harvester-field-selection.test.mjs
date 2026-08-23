/**
 * _idle's field selection, specifically the case that starves an AI's
 * economy: two harvesters converging on the same crystal field.
 *
 * Found by driving a real match — see docs/plans/ai-commander-overhaul.md.
 * A field's stock drains at up to fillRate per harvester (48/s) against a
 * regen ceiling of REGEN_RATE (6/s, blooms.js), so two harvesters filling
 * the same field at once crash its stock in single-digit seconds and it
 * takes tens of seconds to climb back out of the low-stock band. The AI's
 * harvesterCap is a flat 2 (aiCommander.js), so this isn't a rare
 * coincidence for it — it's the routine outcome of both harvesters
 * independently picking "nearest", which the crowd cap (2) does nothing to
 * prevent until a field already has two on it.
 *
 * Dependency-free: a real `HarvesterAI` instance, driven directly through
 * `_idle`, against a mock `world.blooms.nearestTo` that reimplements
 * blooms.js's real selection semantics (distance + reject callback) over a
 * small in-memory field list — no real Blooms/heightmap needed, since
 * nearestTo is pure geometry plus whatever the caller's `reject` decides.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HarvesterAI } from '../src/vehicles/harvesterAI.js';

const DRY_HEIGHTMAP = { heightAt: () => 10, seaLevelY: 0 };

/** Mirrors Blooms.nearestTo's real algorithm (terrain/blooms.js). */
function makeBlooms(fields) {
  return {
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

function makeField(id, x, z, { stock = 900, capacity = 900 } = {}) {
  return { id, x, z, stock, capacity, dead: false };
}

function makeHarvester(id, { x = 0, z = 0 } = {}) {
  return {
    id,
    def: { capacity: 320 },
    dead: false,
    group: { position: { x, y: 0, z } },
    setTarget() {
      return true;
    },
  };
}

function makeAI(fields, harvesters) {
  const ai = new HarvesterAI({
    vehicles: { instances: harvesters },
    world: { blooms: makeBlooms(fields) },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [] },
    game: {},
    facilityControl: null,
  });
  return ai;
}

test('two harvesters with two reachable fields end up on different fields', () => {
  const fieldA = makeField('A', 10, 0);
  const fieldB = makeField('B', 20, 0); // slightly farther, so "nearest" alone would pick A for both
  const harvesterX = makeHarvester('X', { x: 0, z: 0 });
  const harvesterY = makeHarvester('Y', { x: 0, z: 0 });
  const ai = makeAI([fieldA, fieldB], [harvesterX, harvesterY]);

  ai._idle(harvesterX, ai._stateFor(harvesterX));
  ai._idle(harvesterY, ai._stateFor(harvesterY));

  const fieldOf = (inst) => ai.stateOf(inst).field.id;
  assert.notEqual(fieldOf(harvesterX), fieldOf(harvesterY), 'each drew a different field');
  assert.deepEqual([fieldOf(harvesterX), fieldOf(harvesterY)].sort(), ['A', 'B']);
});

test('two harvesters with only one reachable field still both use it', () => {
  const fieldA = makeField('A', 10, 0);
  const harvesterX = makeHarvester('X');
  const harvesterY = makeHarvester('Y');
  const ai = makeAI([fieldA], [harvesterX, harvesterY]);

  ai._idle(harvesterX, ai._stateFor(harvesterX));
  ai._idle(harvesterY, ai._stateFor(harvesterY));

  assert.equal(ai.stateOf(harvesterX).field.id, 'A');
  assert.equal(ai.stateOf(harvesterY).field.id, 'A', 'no alternative exists — sharing is still correct');
});

test('a field already at the crowd cap is skipped even with no untouched field available', () => {
  // Both fields already have 2 harvesters actively filling — the existing
  // crowd cap, unchanged by this fix — so a third harvester falls through to
  // the last-resort tier (share the least-bad option) exactly as before.
  const fieldA = makeField('A', 10, 0);
  const fieldB = makeField('B', 20, 0);
  const already = [
    makeHarvester('P1'), makeHarvester('P2'), // on A
    makeHarvester('P3'), makeHarvester('P4'), // on B
  ];
  const harvesterZ = makeHarvester('Z');
  const ai = makeAI([fieldA, fieldB], [...already, harvesterZ]);
  for (const h of already.slice(0, 2)) {
    const s = ai._stateFor(h);
    s.field = fieldA;
    s.state = 'to-field';
  }
  for (const h of already.slice(2)) {
    const s = ai._stateFor(h);
    s.field = fieldB;
    s.state = 'to-field';
  }

  ai._idle(harvesterZ, ai._stateFor(harvesterZ));

  assert.equal(ai.stateOf(harvesterZ).field.id, 'A', 'falls through to the nearest, even though crowded');
});

test('negative control: without the untouched-field preference, both harvesters pick the same nearest field', () => {
  // Reverts the fix inline (skips straight to the old two-tier chain) to
  // confirm the first test fails for the actual collapse condition, not a
  // stand-in for it.
  const fieldA = makeField('A', 10, 0);
  const fieldB = makeField('B', 20, 0);
  const harvesterX = makeHarvester('X');
  const harvesterY = makeHarvester('Y');
  const ai = makeAI([fieldA, fieldB], [harvesterX, harvesterY]);

  const oldIdle = (inst, s) => {
    const field = ai.world.blooms.nearestTo(inst.group.position.x, inst.group.position.z, {
      minStock: 1,
      reject: (f) => ai._isFieldCrowdedOrLow(f, inst),
    });
    s.field = field;
    s.state = 'to-field';
  };

  oldIdle(harvesterX, ai._stateFor(harvesterX));
  oldIdle(harvesterY, ai._stateFor(harvesterY));

  assert.equal(
    ai.stateOf(harvesterX).field.id,
    ai.stateOf(harvesterY).field.id,
    'both converge on the nearest field — the collapse this fix prevents'
  );
});
