/**
 * AiCommander's own defense behaviour: when it queues a field-engineer, and
 * what that engineer does once it exists — walk out to the perimeter and
 * deploy, not plant a turret at the factory door.
 *
 * Dependency-free, same convention as base-defense.test.mjs: a plain mock
 * `ctx` shaped like main.js's commandContext, no renderer, no real
 * heightmap. findSpawnPointNear (core/pick.js) is exercised for real — its
 * first candidate is always accepted here since the mock heightmap reports
 * dry land everywhere, so no fallback machinery is needed.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiCommander } from '../src/vehicles/aiCommander.js';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';

const ENGINEER_DEF = VEHICLE_CATALOG.find((d) => d.id === 'field-engineer');

const DRY_HEIGHTMAP = { heightAt: () => 10, seaLevelY: 0 };

function makeCtx({ structures = [], vehicles = [] } = {}) {
  return {
    game: { difficulty: { id: 'normal' }, teams: [{}] },
    vehicles: { instances: vehicles, defOf: (id) => VEHICLE_CATALOG.find((d) => d.id === id) },
    structures: {
      instances: structures,
      placeAt(def, x, z, heightmap, { teamId } = {}) {
        const built = { teamId, def, x, z, dead: false };
        structures.push(built);
        return built;
      },
    },
    heightmap: DRY_HEIGHTMAP,
    entities: { queueDestroy: (inst) => { inst.dead = true; } },
  };
}

function makeCommander(ctx, overrides = {}) {
  const team = { id: 1, defeated: false, homePoint: { x: 0, z: 0 }, ...overrides };
  return new AiCommander({ team, buildDelaySeconds: 0, ctx, camera: null });
}

function makeEngineer({ x, z, teamId = 1 }) {
  const eng = {
    teamId,
    def: ENGINEER_DEF,
    mode: 'mobile',
    menuOpen: false,
    hasOrder: false,
    group: { position: { x, y: 0, z } },
    setTargetCalls: 0,
    setTarget() {
      eng.setTargetCalls++;
      eng.hasOrder = true;
      return true;
    },
    arrive() {
      eng.hasOrder = false;
    },
  };
  return eng;
}

// ---- _manageDefense: the build-gate arithmetic ----

test('_manageDefense builds a field-engineer while under the defense cap', () => {
  const ctx = makeCtx();
  const ai = makeCommander(ctx);
  ai.economy = { ...ai.economy, defenseCap: 2 };
  const calls = [];
  ai._tryBuildUnit = (tag, cap) => { calls.push({ tag, cap }); return true; };

  const built = ai._manageDefense();

  assert.equal(built, true);
  assert.deepEqual(calls, [{ tag: 'support', cap: 1 }], 'asks for one more engineer than it currently owns');
});

test('_manageDefense refuses once built defenses already meet the cap', () => {
  const teamId = 1;
  const ctx = makeCtx({
    structures: [
      { teamId, def: { tags: ['defense'] }, dead: false },
      { teamId, def: { tags: ['defense'] }, dead: false },
    ],
  });
  const ai = makeCommander(ctx);
  ai.economy = { ...ai.economy, defenseCap: 2 };
  ai._tryBuildUnit = () => { throw new Error('must not attempt a build past the cap'); };

  assert.equal(ai._manageDefense(), false);
});

test('_manageDefense counts an engineer already walking toward a deploy site against the cap', () => {
  // Otherwise a 15s buildInterval spent watching one engineer walk its ring
  // queues a second before the first has planted anything, and the team ends
  // up with more defenses than defenseCap ever allowed.
  const teamId = 1;
  const ctx = makeCtx({
    structures: [{ teamId, def: { tags: ['defense'] }, dead: false }],
    vehicles: [makeEngineer({ x: 80, z: 0, teamId })],
  });
  const ai = makeCommander(ctx);
  ai.economy = { ...ai.economy, defenseCap: 2 };
  ai._tryBuildUnit = () => { throw new Error('must not attempt a build: 1 built + 1 in flight already meets cap 2'); };

  assert.equal(ai._manageDefense(), false);
});

test('a dead teammate defense structure does not count against the cap', () => {
  const teamId = 1;
  const ctx = makeCtx({ structures: [{ teamId, def: { tags: ['defense'] }, dead: true }] });
  const ai = makeCommander(ctx);
  ai.economy = { ...ai.economy, defenseCap: 1 };
  const calls = [];
  ai._tryBuildUnit = (tag, cap) => { calls.push({ tag, cap }); return true; };

  assert.equal(ai._manageDefense(), true);
  assert.deepEqual(calls, [{ tag: 'support', cap: 1 }]);
});

// ---- _preferredDefenseCommand: vision first, then firepower ----

test('an engineer prefers the sensor tower when the team has none yet', () => {
  const ctx = makeCtx();
  const ai = makeCommander(ctx);
  const eng = makeEngineer({ x: 80, z: 0 });

  assert.equal(ai._preferredDefenseCommand(eng).id, 'deploy-sensor-tower');
});

test('an engineer prefers the gun turret once the team already has a sensor tower', () => {
  const teamId = 1;
  const ctx = makeCtx({ structures: [{ teamId, def: { id: 'sensor-tower', tags: ['defense'] }, dead: false }] });
  const ai = makeCommander(ctx);
  const eng = makeEngineer({ x: 80, z: 0, teamId });

  assert.equal(ai._preferredDefenseCommand(eng).id, 'deploy-gun-turret');
});

// ---- _driveOneEngineer: the walk-out-first behaviour end to end ----

test('a freshly built engineer standing near home is sent toward the perimeter, not deployed on the spot', () => {
  // A fresh engineer spawns on the base pad, well inside DEFENSE_MIN_RADIUS.
  // deployDefenseCommands' own enabled() only refuses water, so without an
  // AI-side distance floor this would plant a turret at the factory door.
  const ctx = makeCtx();
  const ai = makeCommander(ctx);
  const eng = makeEngineer({ x: 5, z: 0 }); // well under DEFENSE_MIN_RADIUS (55)

  ai._driveOneEngineer(eng, 0.1);

  assert.equal(ctx.structures.instances.length, 0, 'nothing was deployed');
  assert.equal(eng.dead, undefined, 'the engineer was not consumed');
  assert.equal(eng.setTargetCalls, 1, 'sent toward a deploy site instead');
});

test('an engineer that has walked clear of home deploys once it arrives', () => {
  const ctx = makeCtx();
  const ai = makeCommander(ctx);
  const eng = makeEngineer({ x: 90, z: 0 }); // past DEFENSE_MIN_RADIUS (55)

  ai._driveOneEngineer(eng, 0.1);

  assert.equal(ctx.structures.instances.length, 1, 'a defense was deployed');
  assert.equal(ctx.structures.instances[0].def.id, 'sensor-tower', 'sensor tower first, for the vision');
  assert.equal(eng.dead, true, 'the engineer is consumed by deploying');
  assert.equal(eng.setTargetCalls, 0, 'no detour needed — it deployed where it stood');
});

test('an engineer given an order keeps waiting rather than re-issuing it every tick', () => {
  const ctx = makeCtx();
  const ai = makeCommander(ctx);
  const eng = makeEngineer({ x: 5, z: 0 });

  ai._driveOneEngineer(eng, 0.1); // issues the first order; hasOrder becomes true
  assert.equal(eng.setTargetCalls, 1);

  ai._driveOneEngineer(eng, 0.1); // still walking — must not re-target every frame
  assert.equal(eng.setTargetCalls, 1);
});
