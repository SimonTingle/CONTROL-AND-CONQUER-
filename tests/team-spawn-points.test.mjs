/**
 * findTeamSpawnPoints' degenerate fallback — when a team's exact bearing
 * never touches dry land, it must not jump to the map centre while there is
 * still dry ground somewhere in that team's own slice.
 *
 * Dependency-free: a synthetic heightmap is just the {params, seaLevelY,
 * heightAt} shape pick.js actually reads, no terrain generator involved.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findEdgeSpawnPointAtAngle, findTeamSpawnPoints } from '../src/core/pick.js';

const SIZE = 400;
const SEA_LEVEL = 0;
const LAND_HEIGHT = 5;

/**
 * Dry everywhere except a wedge of underwater angles centred on 0 radians —
 * exactly the "one bearing hits open water" scenario the degenerate fallback
 * exists for. `wedgeHalfWidth` in radians.
 */
function heightmapWithWetWedge(wedgeHalfWidth) {
  return {
    params: { size: SIZE },
    seaLevelY: SEA_LEVEL,
    heightAt(x, z) {
      if (x === 0 && z === 0) return SEA_LEVEL; // centre itself is underwater too
      const angle = Math.atan2(z, x);
      const inWedge = Math.abs(angle) <= wedgeHalfWidth;
      return inWedge ? SEA_LEVEL - 1 : LAND_HEIGHT;
    },
  };
}

test('a bearing with no dry land anywhere sweeps within its slice instead of jumping to the map centre', () => {
  // Wedge covers ±0.1 rad; the sweep is given a much wider ±0.5 rad slice
  // half-width to search, so it must find dry land well before giving up.
  const heightmap = heightmapWithWetWedge(0.1);
  const found = findEdgeSpawnPointAtAngle(heightmap, 0, undefined, 0.5);

  assert.ok(heightmap.heightAt(found.point.x, found.point.z) > SEA_LEVEL, 'landed on dry ground');
  assert.notEqual(found.point.x, 0, 'did not fall back to the map centre');
});

test('the fallback point sits inland of the coastline it found, not on the waterline', () => {
  const heightmap = heightmapWithWetWedge(0.1);
  const found = findEdgeSpawnPointAtAngle(heightmap, 0, undefined, 0.5);

  const distanceFromCentre = Math.hypot(found.point.x, found.point.z);
  const maxRadius = SIZE * 0.5 - 2;
  assert.ok(distanceFromCentre < maxRadius, 'stepped inland from the edge-to-centre march, not left at the coastline radius');
});

test('the sweep never reaches past sliceHalfWidth — a wedge wider than the slice still degenerates to the centre', () => {
  // Wedge is ±0.6 rad; slice half-width only allows searching ±0.3 rad, so
  // every angle the sweep is permitted to try is still underwater.
  const heightmap = heightmapWithWetWedge(0.6);
  const found = findEdgeSpawnPointAtAngle(heightmap, 0, undefined, 0.3);

  assert.equal(found.point.x, 0);
  assert.equal(found.point.z, 0);
});

test('with no sliceHalfWidth given (camera-based single-bearing callers), a fully wet bearing still falls straight to the centre', () => {
  const heightmap = heightmapWithWetWedge(0.1);
  const found = findEdgeSpawnPointAtAngle(heightmap, 0); // sliceHalfWidth defaults to 0

  assert.equal(found.point.x, 0);
  assert.equal(found.point.z, 0);
});

test('findTeamSpawnPoints keeps every team on dry land even when one nudge bearing is fully underwater', () => {
  // 4 teams -> slice = pi/2. Team 0's centre bearing is 0, wedge is narrower
  // than its own nudge range, so the degenerate case is real but recoverable
  // within that team's slice.
  const heightmap = heightmapWithWetWedge(0.15);
  const starts = findTeamSpawnPoints(heightmap, 4, { minSeparation: 10 });

  for (const start of starts) {
    assert.ok(
      heightmap.heightAt(start.point.x, start.point.z) > SEA_LEVEL,
      'every placed team starts on dry ground'
    );
  }
});
