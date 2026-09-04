/**
 * What the desync detector cannot see.
 *
 * Reported from a real online match: two players, same seed, the on-screen
 * debug line reporting agreement, both players' statistics correct in the
 * hamburger menu — and yet each explored and found "an enemy base" that was
 * not the other's, neither could see the other, and one destroyed a base with
 * no effect at all on his opponent.
 *
 * The reason nobody was warned is in `hashState`. Vehicles are hashed with
 * their position:
 *
 *     `v${v.id},${v.teamId},${q(p.x)},${q(p.z)},...`
 *
 * Structures were hashed without one:
 *
 *     `s${s.id},${s.teamId},${q(s.health)},${q(s.progress)},${s.mode}`
 *
 * A base station is a structure. So two clients could hold every building on
 * the map in a completely different place and this — the only cross-client
 * correctness check the game has — would report agreement. The statistics
 * screen could not help either: it is per-team scalar counters with no spatial
 * content, so it reads correct in a split-brain world.
 *
 * These tests are the reproduction. The first one builds two worlds that
 * differ *only* in where a base stands and asserts the hash tells them apart;
 * before the fix it did not. See docs/plans/split-brain-invisible-to-the-hash.md.
 *
 * Dependency-free: `hashState` takes plain objects, so the "world" here is
 * literally the shape it reads — no three.js, no browser, no server.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashState } from '../src/core/stateHash.js';

/** The minimum shape `hashState` reads for a structure. */
function structure(id, { teamId = 0, x = 0, z = 0, defId = 'base-station', health = 100, progress = 1, mode = 'deployed' } = {}) {
  return { id, teamId, x, z, def: { id: defId }, health, progress, mode, dead: false };
}

/** The minimum shape `hashState` reads for a vehicle. */
function vehicle(id, { teamId = 0, x = 0, z = 0, heading = 0, health = 100, mode = 'idle', kills = 0 } = {}) {
  return { id, teamId, group: { position: { x, z } }, heading, health, mode, kills, dead: false };
}

/** A world in the shape `hashState` destructures. */
function world({ vehicles = [], structures = [], teams = [] } = {}) {
  return {
    vehicles: { instances: vehicles },
    structures: { instances: structures },
    game: { teams },
    projectiles: null,
    bounties: null,
    blooms: null,
    harvesterAI: null,
  };
}

// ---------------------------------------------------------------------------
// The reported bug

test('two worlds whose bases stand in different places hash differently', () => {
  // This is the whole report, reduced: identical ids, identical teams,
  // identical health — the base is simply somewhere else. Before the fix these
  // two hashed equal, and two players spent a match walking to a building the
  // other one could not see.
  const here = world({ structures: [structure(1, { teamId: 1, x: 100, z: 100 })] });
  const there = world({ structures: [structure(1, { teamId: 1, x: -260, z: 40 })] });

  assert.notEqual(
    hashState(here, 0),
    hashState(there, 0),
    'a base in a different place must not hash as agreement — this is the reported bug',
  );
});

test('a structure that has not moved still hashes identically', () => {
  // The other half: the fix must not make the hash jittery, or every match
  // resyncs constantly for nothing.
  const a = world({ structures: [structure(1, { teamId: 1, x: 100, z: 100 })] });
  const b = world({ structures: [structure(1, { teamId: 1, x: 100, z: 100 })] });
  assert.equal(hashState(a, 0), hashState(b, 0));
});

test('sub-quantum drift in a structure position is tolerated', () => {
  // Quantisation exists so a 1e-16 trig difference does not trigger a pointless
  // resync every few seconds. Structure positions join the hash on the same
  // terms as vehicle positions, not stricter ones.
  const a = world({ structures: [structure(1, { x: 100, z: 100 })] });
  const b = world({ structures: [structure(1, { x: 100.000001, z: 100.000001 })] });
  assert.equal(hashState(a, 0), hashState(b, 0));
});

test('two clients that built a different structure in the same place disagree', () => {
  // `defId` was also absent, so a refinery on one client and a power spire on
  // the other — same id, same place, same health — hashed as agreement.
  const refinery = world({ structures: [structure(1, { defId: 'refinery' })] });
  const spire = world({ structures: [structure(1, { defId: 'power-spire' })] });
  assert.notEqual(hashState(refinery, 0), hashState(spire, 0));
});

// ---------------------------------------------------------------------------
// Guarding what already worked

test('vehicle positions were and remain covered', () => {
  // Never broken — asserted so a future edit to the same function cannot
  // quietly drop the coverage that did exist.
  const a = world({ vehicles: [vehicle(1, { x: 0, z: 0 })] });
  const b = world({ vehicles: [vehicle(1, { x: 50, z: 0 })] });
  assert.notEqual(hashState(a, 0), hashState(b, 0));
});

test('the hash is independent of array order, for structures as well as vehicles', () => {
  // `instances` order follows spawn/removal history, which is not part of the
  // state two clients must agree on. Adding fields must not reintroduce an
  // order dependency.
  const s1 = structure(1, { x: 10, z: 20 });
  const s2 = structure(2, { x: 30, z: 40 });
  assert.equal(
    hashState(world({ structures: [s1, s2] }), 0),
    hashState(world({ structures: [s2, s1] }), 0),
  );
});

test('a dead structure is excluded, so a destroyed base does not linger in the hash', () => {
  const alive = world({ structures: [structure(1), structure(2, { x: 80 })] });
  const dead = world({ structures: [structure(1), { ...structure(2, { x: 80 }), dead: true }] });
  assert.notEqual(hashState(alive, 0), hashState(dead, 0));

  const onlyFirst = world({ structures: [structure(1)] });
  assert.equal(hashState(dead, 0), hashState(onlyFirst, 0));
});

test('a missing structure position hashes to a constant rather than throwing', () => {
  // `q()` collapses NaN/undefined to 'x'. A structure mid-construction that has
  // not been placed yet must not crash the hash or make it non-deterministic.
  const undef = world({ structures: [{ ...structure(1), x: undefined, z: undefined }] });
  assert.equal(hashState(undef, 0), hashState(undef, 0));
  assert.doesNotThrow(() => hashState(undef, 0));
});
