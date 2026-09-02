/**
 * `HeadlightPool`'s capped multi-vehicle rig — letting other players see a
 * real light cast from a vehicle someone else is driving, not just the
 * locally-piloted one.
 *
 * Reported directly, alongside a time-of-day sync report: headlights only
 * ever cast real light for whichever vehicle *you* are driving; every other
 * player's driven vehicle showed only its static emissive lamps to everyone
 * else. `HeadlightPool` used to track exactly one `attachedTo`; this
 * generalizes it to a small fixed set (`RIG_COUNT`), so up to that many
 * currently-driven, headlights-on vehicles across every team can cast real
 * light at once — candidate selection and the distance-sort/cap itself live
 * in main.js (not dependency-free testable without a live scene/camera), but
 * the pool's own job — attach up to RIG_COUNT rigs, ignore the rest, read
 * each rig's *own* attached instance's state rather than one shared flag —
 * is fully covered here.
 *
 * A real `THREE.Scene`/`THREE.Group` (cheap, no GPU/canvas needed for plain
 * object construction) and minimal fake vehicle instances (just the
 * `group.userData.lights` shape `vehicleFactory.js`'s `buildLights` actually
 * produces) keep this dependency-free per CLAUDE.md.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HeadlightPool } from '../src/vehicles/headlightPool.js';

function makeFakeInstance(id, { headlightsOn = false, braking = false, reversing = false } = {}) {
  const group = new THREE.Group();
  group.userData.lights = {
    mounts: { noseX: 2, tailX: -2, lampY: 0.5, lampZ: 0.6, reverseZ: 0.3, bar: false },
    config: {
      beamColor: 0xffffff, beamDistance: 40, beamAngle: 0.4, beamIntensity: 6,
      tailColor: 0xff2222, tailBeamDistance: 10, tailBeamAngle: 0.5, tailBeamIntensity: 2,
      reverseColor: 0xffffff, reverseBeamDistance: 10, reverseBeamAngle: 0.5, reverseBeamIntensity: 2,
    },
  };
  return { id, group, dead: false, headlightsOn, braking, reversing };
}

test('attaching fewer than RIG_COUNT candidates leaves the rest parked and dark', () => {
  const pool = new HeadlightPool(new THREE.Scene());
  const a = makeFakeInstance(1, { headlightsOn: true });
  const b = makeFakeInstance(2, { headlightsOn: true });

  pool.attach([a, b]);
  pool.update();

  // Attached rigs actually rode onto the vehicle's own group.
  assert.equal(pool.rigs[0].beams[0].spot.parent, a.group);
  assert.equal(pool.rigs[1].beams[0].spot.parent, b.group);
  // Every unattached rig is dark.
  for (let i = 2; i < pool.rigs.length; i++) {
    for (const { spot } of pool.rigs[i].all) assert.equal(spot.intensity, 0);
  }
});

test('more candidates than RIG_COUNT are silently capped, not an error', () => {
  const pool = new HeadlightPool(new THREE.Scene());
  const many = Array.from({ length: pool.rigs.length + 5 }, (_, i) =>
    makeFakeInstance(i, { headlightsOn: true })
  );

  assert.doesNotThrow(() => pool.attach(many));
  assert.equal(pool.attachedTo.length, pool.rigs.length);
  // Only the first RIG_COUNT candidates actually claimed a rig.
  for (let i = 0; i < pool.rigs.length; i++) assert.equal(pool.attachedTo[i], many[i]);
});

test('each rig reflects its OWN attached vehicle\'s state, not a shared flag', () => {
  const pool = new HeadlightPool(new THREE.Scene());
  const litAndBraking = makeFakeInstance(1, { headlightsOn: true, braking: true });
  const litNotBraking = makeFakeInstance(2, { headlightsOn: true, braking: false });

  pool.attach([litAndBraking, litNotBraking]);
  pool.update();

  const cfg = litAndBraking.group.userData.lights.config;
  assert.equal(pool.rigs[0].tail.spot.intensity, cfg.tailBeamIntensity * 1, 'braking vehicle: full tail glow');
  assert.equal(pool.rigs[1].tail.spot.intensity, cfg.tailBeamIntensity * 0.3, 'non-braking vehicle: dim tail glow');
});

test('a vehicle with headlights off shows no real beam even while attached', () => {
  const pool = new HeadlightPool(new THREE.Scene());
  const dark = makeFakeInstance(1, { headlightsOn: false });

  pool.attach([dark]);
  pool.update();

  for (const { spot } of pool.rigs[0].beams) assert.equal(spot.intensity, 0);
});

test('re-attaching the same instance to the same slot is a cheap no-op (no re-parent)', () => {
  const pool = new HeadlightPool(new THREE.Scene());
  const a = makeFakeInstance(1, { headlightsOn: true });

  pool.attach([a]);
  const beamBeforeParent = pool.rigs[0].beams[0].spot.parent;
  pool.attach([a]); // same instance again
  assert.equal(pool.rigs[0].beams[0].spot.parent, beamBeforeParent);
});
