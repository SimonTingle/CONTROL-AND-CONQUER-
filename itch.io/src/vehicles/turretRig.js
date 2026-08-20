/**
 * A turret that scans, tracks and comes to bear — shared by anything that
 * mounts one.
 *
 * Lifted verbatim out of VehicleInstance, which is where it was written and
 * where it worked, because a defensive emplacement needs exactly the same
 * behaviour and nothing about that behaviour was ever vehicle-specific. It
 * touches no movement, no suspension, no physics: only a mesh's local
 * rotation, a mode flag, a desired bearing, and the host's own heading.
 *
 * A "host" here is any object exposing:
 *   group.userData.turret   the mesh to rotate (barrel parented to it)
 *   heading                 the body's world bearing; constant for a building
 *   mode                    'armed' enables tracking and scanning
 *   turretAim               world bearing to track, or null to scan
 *   sweepPhase              scan state, owned by this module
 *   def.turret              { fireArc, rotationRate, sweepRate }
 *
 * Both VehicleInstance and the defensive structures delegate here rather than
 * keeping a copy, so a turret cannot start behaving differently depending on
 * what it is bolted to.
 */
import * as THREE from 'three';

/** Shortest signed representation of an angle, wrapped to [-π, π]. */
function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Advance one turret by `dt`.
 *
 * Three states, in priority order: tracking a bearing, idly scanning, or
 * stowing forward. The scan resumes from where the barrel physically is
 * rather than from wherever the sine happened to be when a target appeared,
 * so a turret that loses its target does not snap.
 */
export function updateTurretRig(host, dt) {
  const turret = host.group?.userData?.turret;
  if (!turret || !host.def?.turret) return;

  if (host.mode === 'armed' && host.turretAim != null) {
    // Shortest way round to the target bearing, expressed turret-locally,
    // then clamped into the arc so a gun can never point through its own
    // body to reach something behind it.
    const half = host.def.turret.fireArc / 2;
    const local = wrapAngle(host.turretAim - host.heading);
    const wanted = THREE.MathUtils.clamp(local, -half, half);
    const delta = wrapAngle(wanted - turret.rotation.y);
    const maxStep = host.def.turret.rotationRate * dt;
    turret.rotation.y += THREE.MathUtils.clamp(delta, -maxStep, maxStep);
    host.sweepPhase = Math.asin(THREE.MathUtils.clamp(turret.rotation.y / half, -1, 1));
  } else if (host.mode === 'armed') {
    host.sweepPhase = (host.sweepPhase ?? 0) + dt * host.def.turret.sweepRate;
    turret.rotation.y = Math.sin(host.sweepPhase) * (host.def.turret.fireArc / 2);
  } else if (turret.rotation.y !== 0) {
    // Stow forward when disarmed, rather than freezing mid-sweep.
    turret.rotation.y = THREE.MathUtils.damp(turret.rotation.y, 0, 6, dt);
    if (Math.abs(turret.rotation.y) < 1e-3) turret.rotation.y = 0;
    host.sweepPhase = 0;
  }
}

/** World-space bearing the barrel is actually pointing right now. */
export function turretBearingOf(host) {
  const turret = host.group?.userData?.turret;
  return host.heading + (turret ? turret.rotation.y : 0);
}

/**
 * Turret + barrel as one group, barrel parented to the turret so rotating the
 * turret carries the gun with it.
 *
 * Extracted from buildVehicleMesh so a structure can mount the same thing. The
 * caller positions the returned group; only its internal proportions are
 * decided here.
 *
 * @param {object} dims { turretRadius, turretHeight, barrelRadius, barrelLength }
 * @param {THREE.Material} material shared with the caller's own trim.
 */
export function buildTurretMesh(dims, material) {
  const turret = new THREE.Mesh(
    new THREE.CylinderGeometry(dims.turretRadius, dims.turretRadius * 1.1, dims.turretHeight, 10),
    material
  );
  turret.castShadow = true;

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(dims.barrelRadius, dims.barrelRadius, dims.barrelLength, 8),
    material
  );
  barrel.rotation.z = Math.PI / 2;
  // Turret-local: the cylinder's own axis is Y, so `turret.rotation.y`
  // traverses the whole assembly in place.
  barrel.position.set(dims.barrelLength / 2 + dims.turretRadius * 0.5, 0, 0);
  barrel.castShadow = true;
  turret.add(barrel);

  return turret;
}
