import * as THREE from 'three';

/**
 * Where the axles sit for a given hull. Shared so anything that needs the
 * wheelbase — the driving model, the UI's turning-circle figure — agrees with
 * the mesh that actually gets built, without having to build one.
 */
export function axleGeometry(dims) {
  return {
    axleX: dims.hullLength / 2 - dims.wheelRadius * 1.1,
    axleZ: dims.hullWidth / 2 + dims.wheelWidth * 0.15,
  };
}

/**
 * Longitudinal offset of every axle, front first (+X is forward).
 *
 * The outermost axles are always pinned to ±axleX, so a two-axle vehicle comes
 * out bit-for-bit identical to the original hard-coded pair and its turning
 * circle cannot drift. Extra axles fill in between, evenly by default or at
 * explicit fractions of the outer offset.
 */
export function axleOffsets(def) {
  const { axleX } = axleGeometry(def.dims);

  if (def.axleFractions) return def.axleFractions.map((f) => f * axleX);

  const count = def.axles ?? 2;
  if (count === 2) return [axleX, -axleX];

  const out = [];
  for (let i = 0; i < count; i++) out.push(axleX - (2 * axleX * i) / (count - 1));
  return out;
}

/** How much of full lock each axle takes, front first. 1 = full, 0 = fixed. */
export function axleSteerRatios(def) {
  const n = axleOffsets(def).length;
  if (def.steerRatios) return def.steerRatios.slice(0, n);
  const r = new Array(n).fill(0);
  r[0] = 1; // front axle only
  return r;
}

/**
 * Effective wheelbase for the bicycle-model steering.
 *
 * With more than two axles the no-slip condition is over-determined — which is
 * just the physical fact that a rigid multi-axle vehicle has to scrub its tyres
 * to turn. Solving it in the least-squares sense gives a single equivalent
 * wheelbase that already accounts for that resistance, so a long 8x8 corners
 * like a lorry without anyone hand-tuning a fudge factor.
 *
 * For a two-axle vehicle it returns the front-to-rear separation exactly.
 */
export function steeringWheelbase(offsets, ratios) {
  const n = offsets.length;
  let mean = 0;
  for (const x of offsets) mean += x;
  mean /= n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = offsets[i] - mean;
    num += d * (ratios[i] ?? 0);
    den += d * d;
  }
  // No steered axle at all: the vehicle can only drive straight.
  return num !== 0 ? den / num : Infinity;
}

/**
 * Everything about a def's running gear, derived without building a mesh, so
 * the UI's turning-circle figure and the vehicle that actually spawns can never
 * disagree.
 */
export function rigOf(def) {
  const offsets = axleOffsets(def);
  const ratios = axleSteerRatios(def);
  const { axleZ } = axleGeometry(def.dims);
  return {
    offsets,
    ratios,
    axleZ,
    wheelbase: steeringWheelbase(offsets, ratios),
    track: axleZ * 2,
  };
}

/** Kerb-to-kerb turning circle implied by a vehicle's steering geometry. */
export function turningCircleOf(def) {
  return (rigOf(def).wheelbase / Math.tan(def.maxSteerAngle)) * 2;
}

/**
 * Builds a vehicle from primitive geometry — box hull, cylinder wheels, a
 * turret + barrel — the same "no imported assets" philosophy as the terrain.
 * Every dimension and colour comes from `def`, so this one function serves
 * every catalog entry rather than being rewritten per vehicle.
 */
export function buildVehicleMesh(def) {
  const { dims, colors } = def;
  // Defaults describe the scout, so an existing def needs no `shape` block.
  const shape = {
    nose: true,
    turret: true,
    tank: false,
    cabinLength: 0.42, // fraction of hull length
    cabinX: -0.08, // fraction of hull length, +X is forward
    ...def.shape,
  };
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
  if (shape.nose) {
    const noseLength = dims.hullLength * 0.28;
    const noseGeo = new THREE.CylinderGeometry(0, dims.hullWidth * 0.62, noseLength, 4, 1);
    noseGeo.rotateY(Math.PI / 4); // square cross-section flat against the hull
    noseGeo.rotateZ(-Math.PI / 2); // apex points along +X (vehicle forward)
    noseGeo.scale(1, 1, dims.hullHeight / dims.hullWidth);

    const nose = new THREE.Mesh(noseGeo, hullMat);
    nose.position.set(dims.hullLength / 2 + noseLength * 0.5, hull.position.y, 0);
    nose.castShadow = true;
    group.add(nose);
  }

  // Cabin. Sits toward the rear on the scout, right at the front on a tanker.
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(dims.hullLength * shape.cabinLength, dims.cabinHeight, dims.hullWidth * 0.86),
    cabinMat
  );
  cabin.position.set(
    dims.hullLength * shape.cabinX,
    hull.position.y + dims.hullHeight / 2 + dims.cabinHeight / 2,
    0
  );
  cabin.castShadow = true;
  group.add(cabin);

  // Tank barrel: the one shape that reads unmistakably as an oil tanker, laid
  // along the body behind the cab with a raised filler cap.
  if (shape.tank) {
    const tankRadius = dims.hullWidth * 0.46;
    const tankLength = dims.hullLength * (shape.tankLength ?? 0.62);
    const tankGeo = new THREE.CylinderGeometry(tankRadius, tankRadius, tankLength, 20, 1);
    tankGeo.rotateZ(Math.PI / 2); // axis along +X, the vehicle's length
    const tank = new THREE.Mesh(tankGeo, trimMat);
    tank.position.set(
      dims.hullLength * (shape.tankX ?? -0.14),
      hull.position.y + dims.hullHeight / 2 + tankRadius * 0.72,
      0
    );
    tank.castShadow = true;
    tank.receiveShadow = true;
    group.add(tank);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(tankRadius * 0.22, tankRadius * 0.26, tankRadius * 0.3, 12),
      cabinMat
    );
    cap.position.set(tank.position.x, tank.position.y + tankRadius, 0);
    cap.castShadow = true;
    group.add(cap);

    group.userData.tank = tank;

    // Cargo gauge along the top of the tank, for vehicles that carry something.
    if (def.loadIndicator) {
      const segs = def.loadIndicator.segments;
      const pitch = (tankLength * 0.82) / segs;
      const startX = tank.position.x - (tankLength * 0.82) / 2 + pitch / 2;
      const cells = [];

      for (let k = 0; k < segs; k++) {
        const material = new THREE.MeshStandardMaterial({
          color: '#1b2a30',
          emissive: new THREE.Color(def.loadIndicator.color),
          emissiveIntensity: 0, // driven by the load
          roughness: 0.3,
        });
        const cell = new THREE.Mesh(
          new THREE.BoxGeometry(pitch * 0.7, 0.16, tankRadius * 0.85),
          material
        );
        cell.position.set(startX + k * pitch, tank.position.y + tankRadius * 0.92, 0);
        group.add(cell);
        cells.push(material);
      }
      group.userData.loadCells = cells;
    }
  }

  // Wheels: four cylinders, axles along X so the cylinder's own axis (Y) has
  // to be rotated 90° onto Z to sit like a wheel.
  // The axle tilt is baked into the geometry, which leaves each wheel's own
  // rotation.y free for steering — setting both as Euler angles on the mesh
  // would make the steer angle depend on rotation order and skew the wheel.
  const wheelGeo = new THREE.CylinderGeometry(dims.wheelRadius, dims.wheelRadius, dims.wheelWidth, 16);
  wheelGeo.rotateX(Math.PI / 2);

  const rig = rigOf(def);
  const { axleZ } = rig;
  const contacts = [];
  const steeredWheels = [];
  for (let a = 0; a < rig.offsets.length; a++) {
    const ax = rig.offsets[a];
    const ratio = rig.ratios[a] ?? 0;
    for (const sz of [-1, 1]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      // Wheel centre sits one radius up, so the tyre bottoms out at local y = 0
      // — the group origin IS the ground contact plane.
      wheel.position.set(ax, dims.wheelRadius, sz * axleZ);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      // Kept per wheel rather than per array so a partially-steering axle needs
      // no change to how the controller iterates.
      wheel.userData.steerRatio = ratio;
      group.add(wheel);
      contacts.push({ x: ax, z: sz * axleZ, mesh: wheel, baseY: dims.wheelRadius });
      if (ratio !== 0) steeredWheels.push(wheel);
    }
  }

  // Turret + barrel on top, forward-facing along +X.
  if (shape.turret) {
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
    // Parented to the turret, not the group, so traversing the turret carries
    // the gun with it — the position is therefore turret-local. The cylinder's
    // own axis is Y, so `turret.rotation.y` traverses it in place.
    barrel.position.set(dims.barrelLength / 2 + dims.turretRadius * 0.5, 0, 0);
    barrel.castShadow = true;
    turret.add(barrel);

    // Kept addressable so the controller can aim it; the wheels and lights use
    // the same userData convention.
    group.userData.turret = turret;
  }

  group.userData.lights = buildLights(group, dims, def.lights, shape);

  // Vehicle "forward" is +X by construction; callers rotate the whole group.
  // The contact offsets let the controller sample terrain under each wheel and
  // sit the vehicle on the ground plane they define, rather than guessing from
  // a single point under the chassis.
  group.userData.wheelContacts = contacts;
  group.userData.steeredWheels = steeredWheels;
  group.userData.wheelbase = rig.wheelbase;
  group.userData.track = rig.track;
  // How far a wheel may move in its arch to reach ground the rigid body plane
  // can't touch — real ground is curved, a plane fit is not. The default scales
  // with the wheel, but plane-fit residual scales with the *span*, so a much
  // longer vehicle has to ask for more travel explicitly.
  group.userData.suspensionTravel = dims.suspensionTravel ?? dims.wheelRadius * 0.7;

  // Constants for the per-frame least-squares contact-plane fit, precomputed so
  // the fit costs the controller no more than a two-group average would.
  let cx = 0;
  let cz = 0;
  for (const c of contacts) {
    cx += c.x;
    cz += c.z;
  }
  cx /= contacts.length;
  cz /= contacts.length;
  let dxx = 0;
  let dzz = 0;
  for (const c of contacts) {
    dxx += (c.x - cx) ** 2;
    dzz += (c.z - cz) ** 2;
  }
  group.userData.contactFit = { cx, cz, dxx, dzz };

  // Priority-ordered for Phase 2's caster-set trimming (main.js's
  // applyShadowQuality): the hull is the primary silhouette, the turret (if
  // any) the next-most load-bearing shape. Everything else (wheels, cabin,
  // nose, tank, barrel) keeps castShadow=true at build time but drops out
  // first on mobile.
  group.userData.shadowCasters = [hull, group.userData.turret].filter(Boolean);

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
 *
 * Two lens styles. `lamps` gives the scout a discrete pair front and rear;
 * `bar` gives a heavy vehicle a single full-width light bar at each end plus a
 * round central reversing lamp. Only the *lenses* differ — beam placement and
 * behaviour are shared, so a bar-lit vehicle drives at night like any other.
 */
function buildLights(group, dims, cfg, shape = {}) {
  const bar = cfg.style === 'bar';
  const bodyY = dims.wheelRadius + dims.hullHeight;
  const lampY = bodyY - dims.hullHeight * cfg.headlampDrop;
  const lampZ = dims.hullWidth * cfg.headlampInset;
  // Without a nose wedge to sit on, the lamps belong just proud of the hull
  // face rather than a tenth of a much longer body out in front of it.
  const noseX = dims.hullLength / 2 + (shape.nose === false ? dims.wheelRadius * 0.2 : dims.hullLength * 0.1);
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

  const reverseZ = lampZ * 0.42; // inboard of the tail lights
  const spots = [];
  const reverseSpots = [];
  const tailSpots = [];

  // Brake glow. One lamp on the centreline whatever the lens style: this is a
  // soft, short pool rather than a beam, so a second light would double the
  // per-frame lighting cost for something nobody could see.
  {
    const tailSpot = new THREE.SpotLight(
      new THREE.Color(cfg.tailColor),
      0, // switched by the controller
      cfg.tailBeamDistance,
      cfg.tailBeamAngle,
      0.9, // very soft edge — a wash, not a cone
      1.4 // falls off fast so it stays a pool right behind the vehicle
    );
    tailSpot.castShadow = false;
    tailSpot.position.set(tailX, lampY, 0);

    // Aimed back and steeply down, so the red lands on the ground close behind
    // rather than reaching out like a driving beam.
    const tailAim = new THREE.Object3D();
    tailAim.position.set(tailX - cfg.tailBeamDistance * 0.35, lampY - cfg.tailBeamDistance * 0.5, 0);
    group.add(tailAim);
    tailSpot.target = tailAim;

    group.add(tailSpot);
    tailSpots.push(tailSpot);
  }

  // Reversing lamps: one round lamp on the centreline for a bar rig, a pair
  // inboard of the tail lights otherwise.
  const reversePositions = bar ? [0] : [-reverseZ, reverseZ];
  for (const rz of reversePositions) {
    const reverseSpot = new THREE.SpotLight(
      new THREE.Color(cfg.reverseColor),
      0,
      cfg.reverseBeamDistance,
      cfg.reverseBeamAngle,
      0.6,
      1.1
    );
    reverseSpot.castShadow = false;
    reverseSpot.position.set(tailX, lampY, rz);

    // Reversing beam: aimed backwards (-X) and down, mirroring the headlights.
    const reverseAim = new THREE.Object3D();
    reverseAim.position.set(
      tailX - cfg.reverseBeamDistance * 0.5,
      lampY - cfg.reverseBeamDistance * 0.22,
      rz
    );
    group.add(reverseAim);
    reverseSpot.target = reverseAim;

    group.add(reverseSpot);
    reverseSpots.push(reverseSpot);
  }

  if (bar) {
    // Lens sizes are proportional to the hull here, unlike the scout's fixed
    // boxes — a bar has to span the vehicle it is bolted to.
    const barWidth = dims.hullWidth * 0.82;
    const barHeight = dims.hullHeight * 0.2;
    const barGeo = new THREE.BoxGeometry(0.22, barHeight, barWidth);

    const frontBar = new THREE.Mesh(barGeo, headlampMaterial);
    frontBar.position.set(noseX, lampY, 0);
    group.add(frontBar);

    const rearBar = new THREE.Mesh(barGeo, tailMaterial);
    rearBar.position.set(tailX, lampY, 0);
    group.add(rearBar);

    // Round reversing lamp on the centreline, axis along the body so the disc
    // faces backwards.
    const discGeo = new THREE.CylinderGeometry(barHeight * 0.62, barHeight * 0.62, 0.18, 16);
    discGeo.rotateZ(Math.PI / 2);
    const reverseLens = new THREE.Mesh(discGeo, reverseMaterial);
    reverseLens.position.set(tailX - 0.06, lampY - barHeight * 1.1, 0);
    group.add(reverseLens);
  } else {
    const lensGeo = new THREE.BoxGeometry(0.18, 0.34, 0.5);
    const reverseLensGeo = new THREE.BoxGeometry(0.16, 0.24, 0.32);

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
    }
  }

  // Driving beams: a pair either way, so night driving behaves the same
  // whatever the lenses look like.
  for (const side of [-1, 1]) {
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

  return { headlampMaterial, tailMaterial, reverseMaterial, spots, reverseSpots, tailSpots, config: cfg };
}
