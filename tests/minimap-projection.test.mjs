/**
 * Minimap geometry and the fog gate.
 *
 * The projection is worth testing because two separate things depend on it
 * agreeing with itself: blips are drawn world→map, and a click is read back
 * map→world. If those two disagree the map looks right and clicking lands
 * somewhere else, which is exactly the kind of bug that survives a visual
 * check.
 *
 * The fog gate matters more. Without it the minimap draws every enemy on the
 * map regardless of what the player has explored — a fog-of-war hole that no
 * amount of correct 3D rendering would fix.
 *
 * Dependency-free: these are pure functions over numbers, so no canvas, no
 * WebGL, no DOM.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldToMap, mapToWorld, isRevealed, cssColor, REVEAL_THRESHOLD } from '../src/ui/minimap.js';

const SIZE = 1024; // heightmap.js's default

test('the world centre maps to the middle of the minimap', () => {
  const { u, v } = worldToMap(0, 0, SIZE);
  assert.equal(u, 0.5);
  assert.equal(v, 0.5);
});

test('the four world corners map to the four minimap corners', () => {
  const h = SIZE / 2;
  assert.deepEqual(worldToMap(-h, -h, SIZE), { u: 0, v: 0 });
  assert.deepEqual(worldToMap(h, -h, SIZE), { u: 1, v: 0 });
  assert.deepEqual(worldToMap(-h, h, SIZE), { u: 0, v: 1 });
  assert.deepEqual(worldToMap(h, h, SIZE), { u: 1, v: 1 });
});

test('a click round-trips to the world point it was drawn from', () => {
  // The property that makes click-to-navigate land where the player aimed.
  for (const [x, z] of [[0, 0], [100, -250], [-511, 400], [37.5, 37.5]]) {
    const { u, v } = worldToMap(x, z, SIZE);
    const back = mapToWorld(u, v, SIZE);
    assert.ok(Math.abs(back.x - x) < 1e-9, `x round-trips (${x} -> ${back.x})`);
    assert.ok(Math.abs(back.z - z) < 1e-9, `z round-trips (${z} -> ${back.z})`);
  }
});

test('out-of-bounds world points clamp to the edge rather than wrapping', () => {
  // A unit pushed past the map edge must pin to the rim. Wrapping would draw
  // it on the opposite side of the map, which reads as teleportation.
  const far = SIZE * 5;
  assert.deepEqual(worldToMap(far, far, SIZE), { u: 1, v: 1 });
  assert.deepEqual(worldToMap(-far, -far, SIZE), { u: 0, v: 0 });
});

test('a non-finite coordinate produces a drawable number, not NaN', () => {
  // A NaN blip position draws nothing and reports nothing — it would look
  // like a unit that simply vanished from the map.
  for (const bad of [NaN, Infinity, -Infinity, undefined]) {
    const { u, v } = worldToMap(bad, bad, SIZE);
    assert.ok(Number.isFinite(u) && Number.isFinite(v), `${bad} is handled`);
  }
});

test('mapToWorld clamps a click outside the canvas', () => {
  const h = SIZE / 2;
  assert.deepEqual(mapToWorld(-0.4, 1.9, SIZE), { x: -h, z: h });
});

/** Minimal stand-in for FogMask — `seenAt` is all the minimap uses. */
const fogWhere = (revealed) => ({ seenAt: () => (revealed ? 255 : 0) });

test('a blip in unexplored ground is hidden', () => {
  // The fog-of-war hole this gate exists to close.
  assert.equal(isRevealed(fogWhere(false), 100, 100), false);
});

test('a blip in explored ground is shown', () => {
  assert.equal(isRevealed(fogWhere(true), 100, 100), true);
});

test('the reveal threshold is a floor, not a strict cut', () => {
  // Exactly at the threshold counts as explored, matching fogOfWar.js's own
  // comparison — an off-by-one here would flicker the map edge.
  assert.equal(isRevealed({ seenAt: () => REVEAL_THRESHOLD }, 0, 0), true);
  assert.equal(isRevealed({ seenAt: () => REVEAL_THRESHOLD - 1 }, 0, 0), false);
});

test('with no fog mask at all, everything is visible', () => {
  // Sandbox with fog disabled must not render a blank map.
  assert.equal(isRevealed(null, 0, 0), true);
});

test('a packed numeric team colour becomes a usable CSS colour', () => {
  // Team.color is a NUMBER (three.js takes them directly). Assigning a number
  // to a canvas fillStyle is silently ignored — the previous style stays in
  // effect — so every blip drew in the wrong colour, or invisibly, with no
  // error anywhere. Found by sampling the canvas, not by any exception.
  assert.equal(cssColor(0x4fd1c5), '#4fd1c5');
  assert.equal(cssColor(0x000000), '#000000', 'black pads to six digits');
  assert.equal(cssColor(0xff0000), '#ff0000');
});

test('a CSS colour string passes through untouched', () => {
  assert.equal(cssColor('#abcdef'), '#abcdef');
  assert.equal(cssColor('red'), 'red');
});

test('a missing colour falls back to something drawable', () => {
  // An unknown teamId must still render a visible blip rather than throwing
  // or inheriting whatever style was last set.
  assert.equal(typeof cssColor(undefined), 'string');
  assert.equal(typeof cssColor(null), 'string');
});
