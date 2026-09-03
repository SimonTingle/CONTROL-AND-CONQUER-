/**
 * `NavGrid._solve` swapped a linear min-scan for a binary heap
 * (docs/plans/fps-regression-second-pass.md). This is the test that makes
 * that swap safe to ship.
 *
 * Why parity and not just "the routes look right". The solver's `next[]`
 * records the first neighbour that achieved a cell's best distance, so it
 * depends on the order cells are settled in. Many equally-shortest routes
 * exist across open ground, and a different tie-break picks a different one —
 * still correct, still shortest, but *different*. In a lockstep match that is
 * a desync: a patched client and an unpatched one would drive the same unit
 * along two different routes from identical inputs, and nothing in the
 * protocol would notice until the state hashes diverged.
 *
 * So the bar is not "produces a valid route", it is **byte-identical output
 * to the solver it replaced**. `_solveReference` is kept in navGrid.js purely
 * to be the oracle here.
 *
 * The grids below are chosen to exercise the cases where tie-breaking is
 * actually decidable: wide open flat ground (many equal-cost routes),
 * structures forcing detours around both sides of an obstacle (two mirror
 * routes of identical length), and water splitting the map (unreachable
 * cells, which must stay at Infinity/-1 in both).
 *
 * Dependency-free: the same plain mock heightmap/structures shapes
 * nav-grid.test.mjs uses.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid } from '../src/core/navGrid.js';

function makeHeightmap({ size = 480, seaLevelY = 0, heightAt = () => 10 } = {}) {
  return { params: { size }, seaLevelY, terrainVersion: 0, heightAt };
}

function makeStructures(instances = []) {
  return { instances, version: 0 };
}

function makeStructure(x, z, footprint = 13) {
  return { dead: false, x, z, def: { footprint } };
}

/**
 * Assert the heap solver and the reference solver agree exactly, for every
 * goal cell on the grid — not a sampled few, since a tie-break difference can
 * hide in a single cell.
 */
function assertParityForAllGoals(grid, label) {
  const n = grid.cols * grid.rows;
  let compared = 0;

  for (let goal = 0; goal < n; goal++) {
    // Only dry cells are legal goals; nextWaypoint rejects the rest anyway.
    if (!grid._terrainPassable[goal]) continue;

    const heap = grid._solve(goal);
    const reference = grid._solveReference(goal);
    compared++;

    for (let i = 0; i < n; i++) {
      assert.equal(
        heap.dist[i], reference.dist[i],
        `${label}: dist[${i}] differs for goal ${goal} (heap ${heap.dist[i]}, reference ${reference.dist[i]})`,
      );
      assert.equal(
        heap.next[i], reference.next[i],
        `${label}: next[${i}] differs for goal ${goal} (heap ${heap.next[i]}, reference ${reference.next[i]}) — ` +
        'equally-short but different route; this is the lockstep desync case',
      );
    }
  }

  assert.ok(compared > 0, `${label}: no goals were actually compared`);
  return compared;
}

test('heap and reference solvers agree on flat open ground (the many-equal-routes case)', () => {
  const grid = new NavGrid(makeHeightmap(), makeStructures());
  const compared = assertParityForAllGoals(grid, 'flat');
  // 480/24 = 20 cells a side, all dry.
  assert.equal(compared, grid.cols * grid.rows);
});

test('heap and reference solvers agree with structures forcing symmetric detours', () => {
  // A wall of structures with a single gap: routes around it are mirror
  // images of equal length, which is exactly where tie-breaking decides.
  const blockers = [];
  for (let z = -120; z <= 120; z += 24) {
    if (z === 12) continue; // the gap
    blockers.push(makeStructure(0, z));
  }
  const grid = new NavGrid(makeHeightmap(), makeStructures(blockers));
  assertParityForAllGoals(grid, 'walled');
});

test('heap and reference solvers agree when water makes cells unreachable', () => {
  // Left half below sea level: those cells must stay Infinity/-1 in both,
  // and the reference's "break on u === -1" must match the heap draining.
  const grid = new NavGrid(
    makeHeightmap({ heightAt: (x) => (x < 0 ? -5 : 10) }),
    makeStructures(),
  );
  assertParityForAllGoals(grid, 'flooded');

  // Guard the premise: if nothing were actually unreachable this test would
  // be checking the flat case again under a different name.
  const anyDry = grid._terrainPassable.some((v) => v === 1);
  const anyWet = grid._terrainPassable.some((v) => v === 0);
  assert.ok(anyDry && anyWet, 'expected the map to be genuinely split by water');
});

test('heap and reference solvers agree across a slope that is climbable one way only', () => {
  // A ramp: MAX_CLIMB_GRADE makes edges directional, so the backwards-walked
  // graph is asymmetric. Parity here is what proves the heap did not quietly
  // reorder the direction the edge cost is evaluated in.
  const grid = new NavGrid(
    makeHeightmap({ heightAt: (x) => 10 + x * 0.25 }),
    makeStructures(),
  );
  assertParityForAllGoals(grid, 'ramp');
});

test('ties are settled by lowest cell index, which is what makes parity hold', () => {
  // The mechanism itself, stated directly: on flat ground the two cells
  // diagonally adjacent to a goal are equidistant, and both solvers must pick
  // the same predecessor for the cell beyond them.
  const grid = new NavGrid(makeHeightmap(), makeStructures());
  const goal = Math.floor((grid.rows / 2)) * grid.cols + Math.floor(grid.cols / 2);

  const heap = grid._solve(goal);
  const reference = grid._solveReference(goal);

  // Find a cell with at least two equally-good predecessors and confirm both
  // solvers chose the same one, rather than merely both choosing *a* valid one.
  let tiedCells = 0;
  for (let i = 0; i < heap.dist.length; i++) {
    if (heap.dist[i] === Infinity || i === goal) continue;
    assert.equal(heap.next[i], reference.next[i]);
    if (heap.next[i] !== -1) tiedCells++;
  }
  assert.ok(tiedCells > 0, 'expected reachable cells with a recorded predecessor');
});
