import * as THREE from 'three';

/**
 * Builds a vehicle from primitive geometry — box hull, cylinder wheels, a
 * turret + barrel — the same "no imported assets" philosophy as the terrain.
 * Every dimension and colour comes from `def`, so this one function serves
 * every catalog entry rather than being rewritten per vehicle.
 */
export function buildVehicleMesh(def) {
  const { dims, colors } = def;
  const group = new THREE.Group();
  group.name = def.id;

  const hullMat = new THREE.MeshStandardMaterial({ color: colors.hull, roughness: 0.55, metalness: 0.35 });
  const cabinMat = new THREE.MeshStandardMaterial({ color: colors.cabin, roughness: 0.35, metalness: 0.15 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: colors.wheel, roughness: 0.9, metalness: 0.05 });
  const trimMat = new THREE.MeshStandardMaterial({ color: colors.trim, roughness: 0.4, metalness: 0.6 });

  // Hull: a box with the front two top edges tapered by bevelling a wedge.
  const hull = new THREE.Mesh(new THREE.BoxGeometry(dims.hullLength, dims.hullHeight, dims.hullWidth), hullMat);
  hull.position.y = dims.wheelRadius + dims.hullHeight / 2;
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);

  // Rotations are baked into the geometry rather than set as Euler angles on
  // the mesh — combining two axis rotations on a mesh depends on Euler order
  // and skews the wedge instead of simply pointing it forward.
  const noseLength = dims.hullLength * 0.28;
  const noseGeo = new THREE.CylinderGeometry(0, dims.hullWidth * 0.62, noseLength, 4, 1);
  noseGeo.rotateY(Math.PI / 4); // square cross-section flat against the hull
  noseGeo.rotateZ(-Math.PI / 2); // apex points along +X (vehicle forward)
  noseGeo.scale(1, 1, dims.hullHeight / dims.hullWidth);

  const nose = new THREE.Mesh(noseGeo, hullMat);
  nose.position.set(dims.hullLength / 2 + noseLength * 0.5, hull.position.y, 0);
  nose.castShadow = true;
  group.add(nose);

  // Cabin, set back toward the rear third of the hull.
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(dims.hullLength * 0.42, dims.cabinHeight, dims.hullWidth * 0.86),
    cabinMat
  );
  cabin.position.set(
    -dims.hullLength * 0.08,
    hull.position.y + dims.hullHeight / 2 + dims.cabinHeight / 2,
    0
  );
  cabin.castShadow = true;
  group.add(cabin);

  // Wheels: four cylinders, axles along X so the cylinder's own axis (Y) has
  // to be rotated 90° onto Z to sit like a wheel.
  const wheelGeo = new THREE.CylinderGeometry(dims.wheelRadius, dims.wheelRadius, dims.wheelWidth, 16);
  const axleX = dims.hullLength / 2 - dims.wheelRadius * 1.1;
  const axleZ = dims.hullWidth / 2 + dims.wheelWidth * 0.15;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(sx * axleX, dims.wheelRadius, sz * axleZ);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      group.add(wheel);
    }
  }

  // Turret + barrel on top, forward-facing along +X.
  const turret = new THREE.Mesh(
    new THREE.CylinderGeometry(dims.turretRadius, dims.turretRadius * 1.1, dims.turretHeight, 10),
    trimMat
  );
  turret.position.set(dims.hullLength * 0.06, hull.position.y + dims.hullHeight / 2 + dims.turretHeight / 2, 0);
  turret.castShadow = true;
  group.add(turret);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(dims.barrelRadius, dims.barrelRadius, dims.barrelLength, 8),
    trimMat
  );
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(
    dims.hullLength * 0.06 + dims.barrelLength / 2 + dims.turretRadius * 0.5,
    turret.position.y,
    0
  );
  barrel.castShadow = true;
  group.add(barrel);

  // Vehicle "forward" is +X by construction; callers rotate the whole group.
  group.userData.groundClearance = dims.wheelRadius;
  return group;
}
