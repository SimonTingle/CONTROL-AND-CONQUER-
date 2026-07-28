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
  const contacts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.x = Math.PI / 2;
      // Wheel centre sits one radius up, so the tyre bottoms out at local y = 0
      // — the group origin IS the ground contact plane.
      wheel.position.set(sx * axleX, dims.wheelRadius, sz * axleZ);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      group.add(wheel);
      contacts.push({ x: sx * axleX, z: sz * axleZ, mesh: wheel, baseY: dims.wheelRadius });
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

  group.userData.lights = buildLights(group, dims, def.lights);

  // Vehicle "forward" is +X by construction; callers rotate the whole group.
  // The contact offsets let the controller sample terrain under each wheel and
  // sit the vehicle on the ground plane they define, rather than guessing from
  // a single point under the chassis.
  group.userData.wheelContacts = contacts;
  group.userData.wheelbase = axleX * 2;
  group.userData.track = axleZ * 2;
  // How far a wheel may move in its arch to reach ground the rigid body plane
  // can't touch — real ground is curved, a four-point plane fit is not.
  group.userData.suspensionTravel = dims.wheelRadius * 0.7;
  return group;
}

/**
 * Headlamps, tail lights and reversing lamps.
 *
 * The spotlights and their targets are both parented to the vehicle group, so
 * the beams swing with the vehicle for free — no per-frame target bookkeeping.
 * Shadows are deliberately off: beam shadow maps are the expensive part of a
 * spotlight and buy almost nothing on open terrain.
 *
 * Everything is returned rather than hidden, so the controller can switch the
 * lamps without knowing how the rig was assembled.
 */
function buildLights(group, dims, cfg) {
  const bodyY = dims.wheelRadius + dims.hullHeight;
  const lampY = bodyY - dims.hullHeight * cfg.headlampDrop;
  const lampZ = dims.hullWidth * cfg.headlampInset;
  const noseX = dims.hullLength / 2 + dims.hullLength * 0.1;
  const tailX = -dims.hullLength / 2;

  const headlampMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    emissive: new THREE.Color(cfg.beamColor),
    emissiveIntensity: 0,
    roughness: 0.2,
  });
  const tailMaterial = new THREE.MeshStandardMaterial({
    color: '#4a0d08',
    emissive: new THREE.Color(cfg.tailColor),
    emissiveIntensity: 0,
    roughness: 0.35,
  });
  const reverseMaterial = new THREE.MeshStandardMaterial({
    color: '#20242b',
    emissive: new THREE.Color(cfg.reverseColor),
    emissiveIntensity: 0,
    roughness: 0.25,
  });

  const lensGeo = new THREE.BoxGeometry(0.18, 0.34, 0.5);
  const reverseLensGeo = new THREE.BoxGeometry(0.16, 0.24, 0.32);
  const reverseZ = lampZ * 0.42; // inboard of the tail lights
  const spots = [];
  const reverseSpots = [];

  for (const side of [-1, 1]) {
    const lens = new THREE.Mesh(lensGeo, headlampMaterial);
    lens.position.set(noseX, lampY, side * lampZ);
    group.add(lens);

    const tail = new THREE.Mesh(lensGeo, tailMaterial);
    tail.position.set(tailX, lampY, side * lampZ);
    group.add(tail);

    const reverseLens = new THREE.Mesh(reverseLensGeo, reverseMaterial);
    reverseLens.position.set(tailX, lampY, side * reverseZ);
    group.add(reverseLens);

    // Reversing beam: aimed backwards (-X) and down, mirroring the headlights.
    const reverseSpot = new THREE.SpotLight(
      new THREE.Color(cfg.reverseColor),
      0,
      cfg.reverseBeamDistance,
      cfg.reverseBeamAngle,
      0.6,
      1.1
    );
    reverseSpot.castShadow = false;
    reverseSpot.position.set(tailX, lampY, side * reverseZ);

    const reverseAim = new THREE.Object3D();
    reverseAim.position.set(
      tailX - cfg.reverseBeamDistance * 0.5,
      lampY - cfg.reverseBeamDistance * 0.22,
      side * reverseZ
    );
    group.add(reverseAim);
    reverseSpot.target = reverseAim;

    group.add(reverseSpot);
    reverseSpots.push(reverseSpot);

    const spot = new THREE.SpotLight(
      new THREE.Color(cfg.beamColor),
      0, // switched on by the controller
      cfg.beamDistance,
      cfg.beamAngle,
      0.55, // penumbra — soft-edged pool rather than a hard disc
      1.1 // gentle falloff so the beam still reaches down-range
    );
    spot.castShadow = false;
    spot.position.set(noseX, lampY, side * lampZ);

    // Aim well ahead and slightly down, so the pool lands on the terrain
    // rather than shooting off over the horizon.
    const aim = new THREE.Object3D();
    aim.position.set(noseX + cfg.beamDistance * 0.55, lampY - cfg.beamDistance * 0.16, side * lampZ);
    group.add(aim);
    spot.target = aim;

    group.add(spot);
    spots.push(spot);
  }

  return { headlampMaterial, tailMaterial, reverseMaterial, spots, reverseSpots, config: cfg };
}
