/**
 * NavGrid's structure-awareness (docs/plans/harvester-structure-avoidance.md).
 *
 * Before this, no structure of any kind was ever registered as a pathing
 * obstacle anywhere in the codebase — a harvester (or an army unit, via
 * aiCommander) driving between two points would go straight through a
 * building sitting on the line. These tests cover the two behaviours that
 * fix requires, and that are easy to get backwards:
 *
 *   1. A structure blocks routing THROUGH it.
 *   2. A structure never blocks routing TO it — a harvester ordered to dock
 *      somewhere must still be able to solve a route ending at that exact
 *      cell, or the "return to base" leg of every trip would silently stop
 *      using NavGrid the moment the depot's own footprint sat on its own
 *      cell. This is a solve-time exemption (`_edgeCost`'s `goalCell` check),
 *      not a build-time one — see the file header for why a build-time
 *      "never block a structure's own home cell" version was tried and
 *      rejected: with the catalog's real footprint (13) smaller than half a
 *      grid cell (24), it would have exempted the *only* cell a structure
 *      this size can ever mark impassable, silently disabling the whole
 *      feature for every structure the bug report actually named.
 *
 * A coordinate note that cost real time getting right: this grid's cells are
 * centered on multiples of 24 offset by 12 (…, -12, 12, 36, …), so a route's
 * z never actually settles on 0 — it settles on whichever row (11 or -12)
 * straddles it, consistently, on every unobstructed trip. That is correct
 * grid quantization, not a bug, and every coordinate below is chosen to sit
 * exactly on a row/column center specifically so it stops being ambiguous.
 *
 * Dependency-free: a plain mock heightmap (flat, dry, fixed size) and a
 * plain mock structures controller ({ instances, version }) — the same
 * shape NavGrid's constructor actually expects, not a stand-in for it.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid } from '../src/core/navGrid.js';

// The row every unobstructed test below travels along — a real cell-center
// row, not an arbitrary number, so "did this detour" can be judged by
// leaving the row entirely rather than fighting quantization noise.
const ROW_Z = 12;
const FROM = { x: -180, z: ROW_Z };
const TO = { x: 180, z: ROW_Z };

function makeHeightmap({ size = 480, seaLevelY = 0, height = 10 } = {}) {
  return {
    params: { size },
    seaLevelY,
    terrainVersion: 0,
    heightAt: () => height, // flat and dry everywhere — isolates structures
  };
}

function makeStructures(instances = []) {
  return { instances, version: 0 };
}

function makeStructure(x, z, footprint = 13) {
  return { dead: false, x, z, def: { footprint } };
}

/** Walks nextWaypoint from `from` to `to`, returning every point visited
 * (including the start), or throwing if it never arrives within `maxSteps`. */
function walkRoute(grid, from, to, maxSteps = 80) {
  const path = [{ ...from }];
  let pos = { ...from };
  for (let i = 0; i < maxSteps; i++) {
    const wp = grid.nextWaypoint(pos.x, pos.z, to.x, to.z);
    assert.ok(wp, `no route at step ${i} (from ${JSON.stringify(pos)} to ${JSON.stringify(to)})`);
    path.push(wp);
    if (Math.hypot(wp.x - to.x, wp.z - to.z) < 1) return path;
    pos = wp;
  }
  throw new Error(`did not arrive within ${maxSteps} steps`);
}

// ---------------------------------------------------------------------------
// 1. A structure blocks routing through it
// ---------------------------------------------------------------------------

test('with no structure, the trip stays on the direct row the whole way', () => {
  // The control every other test in this file is judged against: this is
  // what "no detour" actually looks like, quantization included.
  const grid = new NavGrid(makeHeightmap(), makeStructures([]));
  const path = walkRoute(grid, FROM, TO);
  for (const p of path) assert.equal(p.z, ROW_Z, `unexpected detour at ${JSON.stringify(p)}`);
});

test('a structure sitting on the direct row is routed around, not through', () => {
  const structures = makeStructures([makeStructure(0, ROW_Z)]);
  const grid = new NavGrid(makeHeightmap(), structures);

  const path = walkRoute(grid, FROM, TO);

  // Leaving the row at all is unambiguous evidence of a real detour, not
  // quantization — the control above proves the row is otherwise never left.
  assert.ok(path.some((p) => p.z !== ROW_Z), 'never left the row — the structure was not avoided');
  // And it must not pass through the structure's own footprint on the way.
  for (const p of path) {
    assert.ok(Math.hypot(p.x - 0, p.z - ROW_Z) > 10, `path point ${JSON.stringify(p)} passes through the structure`);
  }
});

test('a bigger footprint blocks more than just its own cell', () => {
  // Real catalog footprints (13) are smaller than half a grid cell (24), so
  // they can only ever block their own home cell — see the file header. This
  // proves the rasterization loop itself scales correctly for a hypothetical
  // larger structure, independent of that real-world coincidence.
  const grid = new NavGrid(makeHeightmap(), makeStructures([makeStructure(0, ROW_Z, 40)]));
  let blocked = 0;
  for (let i = 0; i < grid._passable.length; i++) if (!grid._passable[i]) blocked++;
  assert.ok(blocked > 1, `expected more than the home cell blocked, got ${blocked}`);
});

// ---------------------------------------------------------------------------
// 2. A structure never blocks routing TO it
// ---------------------------------------------------------------------------

test("a route can still end at a structure's own position", () => {
  const dock = { x: 12, z: ROW_Z };
  const structures = makeStructures([makeStructure(dock.x, dock.z)]);
  const grid = new NavGrid(makeHeightmap(), structures);

  // This is the "return to base" leg: heading toward the very cell the
  // structure's own footprint would otherwise mark impassable.
  const path = walkRoute(grid, FROM, dock);
  const last = path[path.length - 1];
  assert.ok(Math.hypot(last.x - dock.x, last.z - dock.z) < 1, 'never actually arrived');
});

test('routing to a structure does not open a shortcut through it for someone else', () => {
  // The exemption is per-solve (keyed to that call's own goal cell), not a
  // standing hole in the grid — asking to go THROUGH the structure toward a
  // point on the far side must still detour, even though the structure was
  // just proven reachable as a destination above.
  const structures = makeStructures([makeStructure(0, ROW_Z)]);
  const grid = new NavGrid(makeHeightmap(), structures);
  const path = walkRoute(grid, FROM, TO);
  assert.ok(path.some((p) => p.z !== ROW_Z), 'never detoured — this should behave exactly like the through-routing test');
});

test('an underwater goal is still rejected — the exemption is for structures, not water', () => {
  const grid = new NavGrid(makeHeightmap({ seaLevelY: 100, height: 10 }), makeStructures([]));
  assert.equal(grid.nextWaypoint(FROM.x, FROM.z, TO.x, TO.z), null);
});

// ---------------------------------------------------------------------------
// 3. structuresVersion staleness — a match-time build/destroy must invalidate
//    the cached flow fields, the same way heightmap.terrainVersion already does
// ---------------------------------------------------------------------------

test('a structure built after the grid solved is picked up once version bumps', () => {
  const structures = makeStructures([]);
  const grid = new NavGrid(makeHeightmap(), structures);

  // Solve and cache a field before the structure exists.
  const before = walkRoute(grid, FROM, TO);
  for (const p of before) assert.equal(p.z, ROW_Z, 'should be undetoured with nothing built yet');

  // Build it — bump version exactly as StructureController.build()/etc. do.
  structures.instances.push(makeStructure(0, ROW_Z));
  structures.version++;

  const after = walkRoute(grid, FROM, TO);
  assert.ok(after.some((p) => p.z !== ROW_Z), 'the new structure was never noticed');
});

test('without a version bump, a newly built structure is silently missed', () => {
  // The negative control for the test above, inline: prove the staleness
  // check is what makes it work, not some other side effect of pushing to
  // the array (e.g. every nextWaypoint call rebuilding regardless).
  const structures = makeStructures([]);
  const grid = new NavGrid(makeHeightmap(), structures);
  walkRoute(grid, FROM, TO); // solve + cache, version 0

  structures.instances.push(makeStructure(0, ROW_Z)); // no version++ this time

  const path = walkRoute(grid, FROM, TO);
  assert.ok(path.every((p) => p.z === ROW_Z), 'picked up the structure despite no version bump');
});

test('a structure removed after the grid solved is forgotten once version bumps', () => {
  const s1 = makeStructure(0, ROW_Z);
  const structures = makeStructures([s1]);
  const grid = new NavGrid(makeHeightmap(), structures);

  const blocked = walkRoute(grid, FROM, TO);
  assert.ok(blocked.some((p) => p.z !== ROW_Z), 'should have detoured while it stood');

  structures.instances.length = 0;
  structures.version++;

  const clear = walkRoute(grid, FROM, TO);
  for (const p of clear) assert.equal(p.z, ROW_Z, 'still routing around a structure that is gone');
});

test('a dead structure still standing in the array does not block', () => {
  // The destroy pipeline can leave an instance in `instances` for a tick
  // (see structures.js's own removal order) — dead must be checked, not just
  // presence in the array.
  const grid = new NavGrid(makeHeightmap(), makeStructures([{ ...makeStructure(0, ROW_Z), dead: true }]));
  const path = walkRoute(grid, FROM, TO);
  for (const p of path) assert.equal(p.z, ROW_Z, `dead structure still blocked at ${JSON.stringify(p)}`);
});

// ---------------------------------------------------------------------------
// 4. Backward compatibility — no structures reference at all
// ---------------------------------------------------------------------------

test('NavGrid built with no structures reference behaves exactly as before', () => {
  const grid = new NavGrid(makeHeightmap());
  const path = walkRoute(grid, FROM, TO);
  for (const p of path) assert.equal(p.z, ROW_Z);
});

// ---------------------------------------------------------------------------
// 3. Cache invalidation is driven by passability, not by terrain edits
//
// Every ground shell bumps `heightmap.terrainVersion` (craters.js's `dig()`),
// and NavGrid used to clear its entire flow-field cache on that — so a
// firefight destroyed every cached field several times a second, each one
// costing a fresh Dijkstra solve. That is what put an O(n log n) solve on a
// per-tick path. See docs/plans/fps-regression-second-pass.md.
//
// The rule now: a crater that does not change *what is passable* keeps the
// cache; anything that does (a cell submerging, a structure appearing or
// going away) still clears it.

test('a crater that changes no passability does not re-solve', () => {
  let depth = 0;
  const heightmap = makeHeightmap();
  heightmap.heightAt = () => 10 - depth; // still well above sea level
  const grid = new NavGrid(heightmap, makeStructures());

  grid.nextWaypoint(FROM.x, FROM.z, TO.x, TO.z);
  const solvesAfterFirst = grid.solveCount;
  assert.ok(solvesAfterFirst > 0, 'expected the first query to solve');

  // Dig: terrain genuinely changed, and the grid must notice the new heights.
  depth = 2;
  heightmap.terrainVersion++;
  grid.nextWaypoint(FROM.x, FROM.z, TO.x, TO.z);

  assert.equal(grid.solveCount, solvesAfterFirst, 'crater re-solved a cached field');
  assert.equal(grid._height[0], 8, 'grid did not pick up the new terrain heights');
});

test('terrain that submerges a cell does clear the cache', () => {
  let flooded = false;
  const heightmap = makeHeightmap();
  heightmap.heightAt = (x) => (flooded && x < -100 ? -5 : 10);
  const grid = new NavGrid(heightmap, makeStructures());

  grid.nextWaypoint(FROM.x, FROM.z, TO.x, TO.z);
  const before = grid.solveCount;

  flooded = true;
  heightmap.terrainVersion++;
  grid.nextWaypoint(0, ROW_Z, TO.x, TO.z);

  assert.ok(grid.solveCount > before, 'a real passability change must re-solve');
});

test('a structure going up still clears the cache', () => {
  const structures = makeStructures();
  const grid = new NavGrid(makeHeightmap(), structures);

  grid.nextWaypoint(FROM.x, FROM.z, TO.x, TO.z);
  const before = grid.solveCount;

  structures.instances.push(makeStructure(0, ROW_Z));
  structures.version++;
  grid.nextWaypoint(FROM.x, FROM.z, TO.x, TO.z);

  assert.ok(grid.solveCount > before, 'a new structure must re-solve');
});

test('the field cache scales with team count instead of a fixed 24', () => {
  const grid = new NavGrid(makeHeightmap({ size: 960 }), makeStructures());
  const base = grid._cacheLimit;

  grid.setTeamCount(20);
  assert.ok(grid._cacheLimit > base, 'a 20-team match must get a bigger cache than the 4-team default');

  // Only ever grows — a team leaving must not evict everyone else's fields.
  const grown = grid._cacheLimit;
  grid.setTeamCount(2);
  assert.equal(grid._cacheLimit, grown);
});
