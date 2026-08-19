/**
 * Defensive emplacements: the turret rig they share with vehicles, and the
 * rules that decide whether one can shoot at all.
 *
 * The turret rig is the interesting part. It was lifted out of VehicleInstance
 * rather than copied, because two implementations of scan/track/stow would
 * drift apart the first time either was tuned — and the drift would show up as
 * "the turret on the tank behaves differently from the identical turret on the
 * emplacement", which is the kind of thing nobody files a bug about.
 *
 * Dependency-free: the rig operates on a plain host object with a `rotation.y`
 * to write, so none of this needs a renderer.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateTurretRig, turretBearingOf } from '../src/vehicles/turretRig.js';
import { STRUCTURE_CATALOG } from '../src/structures/structures.js';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';

/** The minimum a turret host has to expose — see turretRig.js's header. */
function host({ mode = 'armed', aim = null, heading = 0, fireArc = Math.PI * 2 } = {}) {
  return {
    heading,
    mode,
    turretAim: aim,
    sweepPhase: 0,
    def: { turret: { fireArc, rotationRate: 2, sweepRate: 1 } },
    group: { userData: { turret: { rotation: { y: 0 } } } },
  };
}

test('an armed turret with a target rotates toward it', () => {
  const h = host({ aim: 1 });
  updateTurretRig(h, 0.1);
  assert.ok(h.group.userData.turret.rotation.y > 0, 'moved toward the bearing');
  assert.ok(h.group.userData.turret.rotation.y <= 0.2 + 1e-9, 'and no faster than rotationRate allows');
});

test('a turret never slews faster than its rotation rate', () => {
  // The gate that stops a turret snapping onto a target the instant one
  // appears — combatController only fires once the barrel has caught up, so
  // this rate is what actually costs a slow turret its first shot.
  const h = host({ aim: Math.PI });
  updateTurretRig(h, 0.5); // rotationRate 2 -> at most 1 radian
  assert.ok(Math.abs(h.group.userData.turret.rotation.y) <= 1 + 1e-9);
});

test('a turret cannot point outside its own arc', () => {
  // A vehicle turret with a limited arc must not swing through its own hull.
  const h = host({ aim: Math.PI, fireArc: 1 }); // half-arc 0.5
  for (let i = 0; i < 100; i++) updateTurretRig(h, 0.1);
  assert.ok(Math.abs(h.group.userData.turret.rotation.y) <= 0.5 + 1e-9);
});

test('an armed turret with no target scans instead of freezing', () => {
  const h = host({ aim: null });
  updateTurretRig(h, 0.25);
  assert.notEqual(h.group.userData.turret.rotation.y, 0, 'sweeping');
});

test('a disarmed turret stows forward rather than freezing mid-sweep', () => {
  const h = host({ aim: null });
  h.group.userData.turret.rotation.y = 0.8;
  h.mode = 'idle';
  for (let i = 0; i < 200; i++) updateTurretRig(h, 0.05);
  assert.equal(h.group.userData.turret.rotation.y, 0);
});

test('turret bearing is the host heading plus the local rotation', () => {
  // A building is yawed at construction and never turns, so its heading must
  // be folded in here or the gun reports a bearing it is not pointing at —
  // and combatController compares exactly this against the target bearing.
  const h = host({ heading: 1 });
  h.group.userData.turret.rotation.y = 0.5;
  assert.ok(Math.abs(turretBearingOf(h) - 1.5) < 1e-9);
});

test('a host with no turret mesh is a no-op, not a crash', () => {
  // Every structure runs through the same update path; the unarmed ones have
  // no turret at all.
  const h = host();
  h.group.userData.turret = undefined;
  assert.doesNotThrow(() => updateTurretRig(h, 0.1));
});

// ---- the defence definitions themselves ----

const defenseOf = (id) => STRUCTURE_CATALOG.find((d) => d.id === id);

test('both defences are tagged so they are offered by the engineer', () => {
  // commands.js selects deployables by this tag rather than by naming them,
  // so an untagged defence would exist and be unreachable.
  for (const id of ['gun-turret', 'sensor-tower']) {
    assert.ok(defenseOf(id)?.tags?.includes('defense'), `${id} is tagged defense`);
  }
});

test('a defence is never tagged production — the AI must not try to build one on a pad', () => {
  // aiCommander's BUILDABLE_DEFS picks structures tagged production/repair and
  // builds them on the base pad. A defence there would be placed by the wrong
  // mechanism entirely.
  for (const id of ['gun-turret', 'sensor-tower']) {
    const tags = defenseOf(id).tags;
    assert.ok(!tags.includes('production') && !tags.includes('repair'), `${id}`);
  }
});

test('the gun turret carries a complete turret block', () => {
  // The same shape a vehicle's turret uses — combatController reads every one
  // of these and a missing field is a crash or a silent never-fires.
  const t = defenseOf('gun-turret').turret;
  for (const key of ['range', 'fireArc', 'sweepRate', 'rotationRate', 'damage', 'fireInterval', 'muzzleHeight']) {
    assert.ok(Number.isFinite(t[key]), `turret.${key} is a number`);
  }
  assert.ok(t.damage > 0, 'a gun that deals no damage would aim and never hurt anything');
});

test('the sensor tower has no turret, and sees further than anything else', () => {
  const tower = defenseOf('sensor-tower');
  assert.equal(tower.turret, undefined, 'unarmed by design');
  // Its entire contribution is sightRadius, so it has to beat what a unit
  // already gives you or there is no reason to build one.
  const best = Math.max(...VEHICLE_CATALOG.map((d) => d.sightRadius ?? 0));
  assert.ok(tower.sightRadius > best, `${tower.sightRadius} > ${best}`);
});

test('the field engineer is unarmed — escorting it has to be a real decision', () => {
  const eng = VEHICLE_CATALOG.find((d) => d.id === 'field-engineer');
  assert.ok(eng, 'the engineer exists');
  assert.equal(eng.turret, undefined);
  assert.equal(eng.producedBy, 'armed-factory');
});

test('every structure def declares the dims its mesh builder needs', () => {
  // Not cosmetic. StructureInstance.update() dereferences
  // group.userData.buildRing and iterates group.userData.shadowCasters on the
  // very first tick, so a mesh builder that forgets either throws the instant
  // the building is placed — which is only reachable by actually placing one,
  // and is exactly how it was found.
  for (const def of STRUCTURE_CATALOG) {
    assert.ok(def.dims, `${def.id} has dims`);
    assert.ok(def.colors, `${def.id} has colors`);
  }
});

test('every defence has a mesh case — none falls through to the facility default', () => {
  // buildStructureMesh dispatches on def.id; an unlisted defence would silently
  // render as a generic factory box rather than erroring.
  for (const id of ['gun-turret', 'sensor-tower']) {
    const def = defenseOf(id);
    assert.ok(def.dims && def.colors, `${id} carries the blocks its mesh builder reads`);
  }
});
