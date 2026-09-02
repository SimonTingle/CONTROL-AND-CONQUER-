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

/** Uniformly dry, out to `radius` — no coastline for the sweep to react to. */
function heightmapAllDry(radius) {
  return {
    params: { size: radius * 2 },
    seaLevelY: SEA_LEVEL,
    heightAt: () => LAND_HEIGHT,
  };
}

test('findTeamSpawnPoints gives 20 players equally spaced spawn angles, not clustered', () => {
  // A generous, obstacle-free map: every nudge candidate clears
  // minSeparation on the very first try (nudge 0, dead centre of its slice),
  // so every team lands exactly on its slice's own bearing with nothing to
  // pull it off-centre — the plain "equal separation" case this exists for.
  const RADIUS = 2000;
  const heightmap = heightmapAllDry(RADIUS);
  const count = 20;
  const starts = findTeamSpawnPoints(heightmap, count, { minSeparation: 260 });

  assert.equal(starts.length, count);

  const expectedSlice = (Math.PI * 2) / count;
  const angles = starts.map((s) => Math.atan2(s.point.z, s.point.x));
  for (let i = 0; i < count; i++) {
    const expected = i * expectedSlice;
    // Angles wrap at +-pi; normalise the difference into (-pi, pi] before
    // comparing so team 0 (angle ~0) and a team near +-pi don't look far
    // apart when they are not.
    let diff = angles[i] - expected;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    assert.ok(Math.abs(diff) < 1e-6, `team ${i} at angle ${angles[i]}, expected ${expected}`);
  }

  // Equal angles at a shared radius means equal chord distance between every
  // pair of angularly-adjacent teams — the actual "equal separation" a
  // player sees on the ground, not just equal angles on paper.
  const chordFor = (a, b) => Math.hypot(a.point.x - b.point.x, a.point.z - b.point.z);
  const adjacentChords = starts.map((s, i) => chordFor(s, starts[(i + 1) % count]));
  const [min, max] = [Math.min(...adjacentChords), Math.max(...adjacentChords)];
  assert.ok(max - min < 1, `adjacent spacing should be uniform, got range [${min}, ${max}]`);
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
