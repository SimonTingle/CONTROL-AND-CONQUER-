/**
 * Permanent terrain damage: `Craters` (src/core/craters.js).
 *
 * The property that matters most here is the one `terraform.js`'s pads
 * already proved out: a runtime edit to the heightfield, saved as a small
 * record and replayed rather than stored as a megabyte of floats, must
 * reproduce byte-for-byte on top of freshly regenerated terrain. `dig` and
 * `restore` share the same `_apply`, so the negative control for that claim is
 * simple — call one instead of the other and the heights disagree.
 *
 * Dependency-free: a `World`-shaped stub over a real `Float32Array` heightfield,
 * no renderer, no THREE.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Craters, MIN_CRATER_DAMAGE } from '../src/core/craters.js';

const SIZE = 200;
const RES = 65; // small and power-of-two-plus-one, like the real heightmap

function makeWorld() {
  const params = { size: SIZE, resolution: RES, amplitude: 40, seaLevel: 0.18 };
  const data = new Float32Array(RES * RES).fill(0.5); // flat mid-height terrain
  const heightmap = {
    params,
    data,
    texture: { needsUpdate: false },
    terrainVersion: 0,
    heightAt(x, z) {
      // Nearest-sample read, matching how a real Heightmap answers this for
      // test purposes — exactness here isn't the point, only that dig/restore
      // agree with each other.
      const res = RES;
      const i = Math.max(0, Math.min(res - 1, Math.round((x / SIZE + 0.5) * (res - 1))));
      const j = Math.max(0, Math.min(res - 1, Math.round((z / SIZE + 0.5) * (res - 1))));
      return data[j * res + i] * params.amplitude;
    },
  };
  const patched = [];
  return {
    heightmap,
    fogTerrain: { patchTerrain: (x, z, r) => patched.push({ x, z, r }) },
    patched,
  };
}

// ---- shape ----

test('a shell lighter than the floor digs nothing', () => {
  assert.equal(Craters.shapeFor(MIN_CRATER_DAMAGE - 1), null);
});

test('a shell at the floor digs something', () => {
  assert.ok(Craters.shapeFor(MIN_CRATER_DAMAGE) !== null);
});

test('radius and depth grow with damage, but stay capped', () => {
  const small = Craters.shapeFor(20);
  const big = Craters.shapeFor(200);
  const huge = Craters.shapeFor(100000);
  assert.ok(big.radius > small.radius);
  assert.ok(big.depth > small.depth);
  assert.ok(huge.radius <= 9, 'radius never exceeds MAX_RADIUS');
  assert.ok(huge.depth <= 2.4, 'depth never exceeds MAX_DEPTH');
});

test('weapon tier widens the same-damage crater', () => {
  const untiered = Craters.shapeFor(50, 0);
  const tiered = Craters.shapeFor(50, 3);
  assert.ok(tiered.radius > untiered.radius);
});

// ---- digging lowers the ground, and only near the impact ----

test('dig lowers the centre and leaves distant ground untouched', () => {
  const w = makeWorld();
  const craters = new Craters(w);
  const before = w.heightmap.heightAt(0, 0);

  craters.dig(0, 0, 50);

  const after = w.heightmap.heightAt(0, 0);
  assert.ok(after < before, 'the impact point sank');

  const far = w.heightmap.heightAt(90, 90);
  assert.ok(Math.abs(far - before) < 1e-6, 'ground far from the impact is untouched');
});

test('a crater never digs below the sea-level margin', () => {
  const w = makeWorld();
  w.heightmap.data.fill(0.19); // just above sea level (0.18) everywhere
  const craters = new Craters(w);

  craters.dig(0, 0, 100000); // as deep a shell as exists
  const idx = Math.round((0.5) * (RES - 1)) * RES + Math.round(0.5 * (RES - 1));
  assert.ok(w.heightmap.data[idx] >= 0.18 + 0.02 - 1e-9, 'clamped at the sea margin');
});

test('too light a shell records nothing and touches no height', () => {
  const w = makeWorld();
  const craters = new Craters(w);
  const before = w.heightmap.data.slice();

  const record = craters.dig(0, 0, MIN_CRATER_DAMAGE - 1);

  assert.equal(record, null);
  assert.equal(craters.records.length, 0);
  assert.deepEqual(Array.from(w.heightmap.data), Array.from(before));
});

test('dig patches the fog cache and bumps terrainVersion', () => {
  const w = makeWorld();
  const craters = new Craters(w);
  craters.dig(5, 5, 50);
  assert.equal(w.patched.length, 1);
  assert.equal(w.heightmap.terrainVersion, 1);
});

// ---- the record-and-replay property ----

test('replaying a saved crater reproduces the same heightfield', () => {
  const original = makeWorld();
  const craters1 = new Craters(original);
  craters1.dig(3, -7, 60);
  craters1.dig(3, -7, 30); // overlapping — order matters, see the header
  const dugData = Array.from(original.heightmap.data);

  const fresh = makeWorld(); // pristine terrain, as if just regenerated
  const craters2 = new Craters(fresh);
  for (const record of craters1.records) craters2.restore(record);
  const restoredData = Array.from(fresh.heightmap.data);

  assert.deepEqual(restoredData, dugData, 'replay reproduces dig, texel for texel');
});

test('restore does not patch fog or bump terrainVersion', () => {
  // deserialize() regenerates the world wholesale; doing this per crater would
  // be thousands of redundant patches on a load with a long history.
  const w = makeWorld();
  const craters = new Craters(w);
  craters.restore({ x: 0, z: 0, radius: 4, depth: 1 });
  assert.equal(w.patched.length, 0);
  assert.equal(w.heightmap.terrainVersion, 0);
});

test('the record list preserves creation order, which replay depends on', () => {
  // Order is preserved by construction — records is append-only and restore()
  // walks it front to back — which is what the byte-identical replay test
  // above actually relies on: restore() reproduces the exact sequence of
  // _apply() calls dig() made, in the order dig() made them.
  const w = makeWorld();
  const craters = new Craters(w);
  craters.dig(0, 0, 40);
  craters.dig(5, 5, 30);
  craters.dig(-5, -5, 60);
  assert.deepEqual(
    craters.records.map((r) => [r.x, r.z]),
    [[0, 0], [5, 5], [-5, -5]]
  );
});

// ---- clear ----

test('clear empties the record list', () => {
  const w = makeWorld();
  const craters = new Craters(w);
  craters.dig(0, 0, 50);
  assert.equal(craters.records.length, 1);
  craters.clear();
  assert.equal(craters.records.length, 0);
});
