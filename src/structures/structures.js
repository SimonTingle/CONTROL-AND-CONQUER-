import * as THREE from 'three';

/**
 * Buildings, and the controller that owns them.
 *
 * Kept in one file rather than mirroring the vehicles' catalog/factory/
 * controller split. That split earned itself — the vehicle factory has two
 * consumers and parameterises two genuinely different machines. Here there is
 * one structure and one consumer, so three files would only add import hops
 * between a reader and the answer. The seam is still in the signature
 * (`buildStructureMesh(def)`), so splitting later is a file move.
 */

export const STRUCTURE_CATALOG = [
  {
    id: 'harvester-facility',
    name: 'Harvester Facility',
    description: 'Refines crystal into credits. Ships one harvester on completion.',
    role: 'structure',
    maxHealth: 600,
    sightRadius: 34,
    buildTime: 6, // seconds to rise into place
    footprint: 13, // radius it claims when checking overlap with neighbours
    produces: 'crystal-harvester',
    /** The bootstrap: without this the first harvester could never be afforded. */
    freeUnitOnComplete: true,
    unloadRate: 80, // stock units/second it will accept from a docked harvester
    dockOffset: 12, // how far out from the building a harvester parks
    dims: {
      width: 18,
      depth: 14,
      height: 7,
      roofHeight: 2.2,
      doorWidth: 7,
    },
    colors: { shell: '#3a4048', trim: '#9aa6b2', accent: '#2ad9ff', dark: '#1c2026' },
    // Ten-step upgrade track, paid per instance. Each tier raises the unload
    // rate a facility offers a docked harvester — a faster facility is worth
    // less if the harvester it's unloading into can't keep up either, but that
    // ceiling is the harvester's own def, unaffected by this.
    upgradeTiers: [
      { cost: 500, unloadRateMultiplier: 1.15 },
      { cost: 900, unloadRateMultiplier: 1.3 },
      { cost: 1400, unloadRateMultiplier: 1.45 },
      { cost: 2000, unloadRateMultiplier: 1.6 },
      { cost: 2800, unloadRateMultiplier: 1.8 },
      { cost: 3800, unloadRateMultiplier: 2.0 },
      { cost: 5000, unloadRateMultiplier: 2.2 },
      { cost: 6500, unloadRateMultiplier: 2.4 },
      { cost: 8500, unloadRateMultiplier: 2.6 },
      { cost: 11000, unloadRateMultiplier: 2.85 },
    ],
  },
  {
    id: 'repair-bay',
    name: 'Repair Bay',
    description: 'Restores a damaged vehicle to full health. Vehicles queue outside.',
    role: 'structure',
    maxHealth: 500,
    sightRadius: 30,
    buildTime: 6,
    // `footprint` is the collision radius used by canPlaceAt/freeSlot, not a
    // visual size — it must track the bay's real physical extent (its pad is
    // dims.padRadius=10, gantry ring at padRadius*0.86, LED strip at
    // padRadius+0.4 — nothing reaches much past 10.5). An earlier value of 24
    // ("roughly double the harvester facility's, to read as bigger") drove
    // placement math instead of visuals: canPlaceAt's overlap rule rejects
    // anything within footprint*1.6 (≈38) of another building, which — given
    // the pad itself is only radius 40 — left no legal spot anywhere on the
    // pad at all once a harvester facility already occupied it.
    footprint: 11,
    cost: 2000, // credits to build, separate from the per-repair cost below
    dockOffset: 16,
    ledSegments: 12,
    // Tunable repair economy: a fully-depleted crystal-harvester (220 hp) costs
    // 220*4 = 880cr and takes 220*1.5 = 330s at tier 0 — ten times the original
    // pace, brought back down by the upgrade track below.
    repair: { creditsPerHealth: 4, secondsPerHealth: 1.5 },
    dims: {
      padRadius: 10,
      height: 9, // gantry height — reused by the generic rise-out-of-ground animation
      postRadius: 1.1,
    },
    colors: {
      shell: '#3a4048',
      trim: '#9aa6b2',
      accent: '#ffb020',
      dark: '#1c2026',
      led: '#39ff6a',
      ringWorking: '#ffcc33', // brighter gold than the idle accent — a vehicle is in the bay
      ringReady: '#39ff6a', // matches the LED color — "done" reads the same way twice
    },
    // Ten-step upgrade track, paid per instance. Each tier multiplies
    // secondsPerHealth down (never creditsPerHealth — only speed, not price).
    upgradeTiers: [
      { cost: 500, repairSpeedMultiplier: 0.9 },
      { cost: 900, repairSpeedMultiplier: 0.8 },
      { cost: 1400, repairSpeedMultiplier: 0.7 },
      { cost: 2000, repairSpeedMultiplier: 0.6 },
      { cost: 2800, repairSpeedMultiplier: 0.5 },
      { cost: 3800, repairSpeedMultiplier: 0.42 },
      { cost: 5000, repairSpeedMultiplier: 0.34 },
      { cost: 6500, repairSpeedMultiplier: 0.27 },
      { cost: 8500, repairSpeedMultiplier: 0.2 },
      { cost: 11000, repairSpeedMultiplier: 0.15 },
    ],
  },
  {
    id: 'power-spire',
    name: 'Power Spire',
    description: 'Marks a retired base site. Keeps its structures powered.',
    role: 'decoration', // no dock, no queue, no commands of its own
    maxHealth: 100000, // inert — nothing currently damages or repairs a structure
    sightRadius: 20,
    buildTime: 4,
    footprint: 6, // narrow — the "1x2" is tall, not wide
    dims: {
      baseRadius: 3.2,
      topRadius: 0.9,
      height: 34,
      segments: 7,
      beaconRadius: 1.6,
    },
    colors: { shell: '#2b2f38', accent: '#9aa6b2', dark: '#1c2026' },
    beacon: { color: '#ff3b3b', rate: 1.6, baseIntensity: 0.8, amplitude: 2.4 },
  },
];

/** Ring of slots inside the pad. The base station itself sits at the centre. */
const SLOT_RING = 26;
const SLOT_COUNT = 6;
const SLOT_PHASE = Math.PI / 6;

/**
 * A building, assembled from primitives — the same "no imported assets" rule
 * the terrain and the vehicles follow. Forward is +X, matching the vehicle
 * factory, so the same yaw convention places it.
 *
 * Dispatches on shape rather than being one function, now that a second and
 * third structure exist with genuinely different silhouettes — the seam this
 * file's header comment already called out.
 */
export function buildStructureMesh(def) {
  switch (def.id) {
    case 'repair-bay':
      return buildRepairBayMesh(def);
    case 'power-spire':
      return buildSpireMesh(def);
    default:
      return buildFacilityMesh(def);
  }
}

function buildFacilityMesh(def) {
  const { dims, colors } = def;
  const group = new THREE.Group();
  group.name = def.id;

  const shellMat = new THREE.MeshStandardMaterial({ color: colors.shell, roughness: 0.62, metalness: 0.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: colors.dark, roughness: 0.5, metalness: 0.2 });
  const trimMat = new THREE.MeshStandardMaterial({ color: colors.trim, roughness: 0.4, metalness: 0.55 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: '#12303a',
    emissive: new THREE.Color(colors.accent),
    emissiveIntensity: 1.1,
    roughness: 0.3,
  });

  const shell = new THREE.Mesh(new THREE.BoxGeometry(dims.depth, dims.height, dims.width), shellMat);
  shell.position.y = dims.height / 2;
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  // Inset roof, so the silhouette is not a plain cube.
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(dims.depth * 0.78, dims.roofHeight, dims.width * 0.84),
    darkMat
  );
  roof.position.y = dims.height + dims.roofHeight / 2;
  roof.castShadow = true;
  group.add(roof);

  // Door bay on the +X face — this is what tells the player which side a
  // harvester docks at, so it gets lit edges rather than being a dark hole.
  const doorH = dims.height * 0.62;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, doorH, dims.doorWidth), darkMat);
  door.position.set(dims.depth / 2, doorH / 2, 0);
  group.add(door);

  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.7, doorH, 0.4), accentMat);
    strip.position.set(dims.depth / 2 + 0.05, doorH / 2, (side * dims.doorWidth) / 2);
    group.add(strip);
  }

  // Intake mast: glows at night like the crystal it processes.
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.7, dims.height * 0.75, 8),
    trimMat
  );
  mast.position.set(-dims.depth * 0.3, dims.height + dims.height * 0.375, -dims.width * 0.3);
  mast.castShadow = true;
  group.add(mast);

  const cap = new THREE.Mesh(new THREE.OctahedronGeometry(1.3, 0), accentMat);
  cap.position.set(mast.position.x, dims.height + dims.height * 0.75 + 1, mast.position.z);
  group.add(cap);

  // Spins while under construction, hidden once complete.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(dims.width * 0.62, dims.width * 0.68, 32),
    new THREE.MeshBasicMaterial({
      color: colors.accent,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.15;
  group.add(ring);

  group.userData.buildRing = ring;
  group.userData.shadowCasters = [shell, roof, mast];
  return group;
}

/**
 * Open service pad under a gantry ring, rimmed with individually-lit LED
 * segments — visibly different from the enclosed facility box, and built so a
 * parked vehicle and the repair progress around its edge both stay in view.
 */
function buildRepairBayMesh(def) {
  const { dims, colors } = def;
  const group = new THREE.Group();
  group.name = def.id;

  const trimMat = new THREE.MeshStandardMaterial({ color: colors.trim, roughness: 0.4, metalness: 0.55 });
  const darkMat = new THREE.MeshStandardMaterial({ color: colors.dark, roughness: 0.5, metalness: 0.2 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: '#241a08',
    emissive: new THREE.Color(colors.accent),
    emissiveIntensity: 1.1,
    roughness: 0.3,
  });

  const pad = new THREE.Mesh(new THREE.CylinderGeometry(dims.padRadius, dims.padRadius, 0.6, 24), darkMat);
  pad.position.y = 0.3;
  pad.receiveShadow = true;
  group.add(pad);

  // Four gantry posts holding a service ring overhead — reads as a vehicle bay
  // rather than a warehouse at a glance.
  const posts = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(dims.postRadius, dims.postRadius, dims.height, 8),
      trimMat
    );
    post.position.set(Math.cos(angle) * dims.padRadius * 0.86, dims.height / 2, Math.sin(angle) * dims.padRadius * 0.86);
    post.castShadow = true;
    group.add(post);
    posts.push(post);
  }

  const gantryRing = new THREE.Mesh(new THREE.TorusGeometry(dims.padRadius * 0.86, 0.5, 8, 24), accentMat);
  gantryRing.rotation.x = Math.PI / 2;
  gantryRing.position.y = dims.height;
  gantryRing.castShadow = true;
  group.add(gantryRing);

  // The LED strip: one small emissive box per segment, arranged around the
  // pad's rim with the same angle convention used for queue/parking rings and
  // the radial menu (`angle = (i / N) * 2π`). Each gets its own material so the
  // repair controller can light them individually as repair progresses.
  const ledCells = [];
  for (let i = 0; i < def.ledSegments; i++) {
    const angle = (i / def.ledSegments) * Math.PI * 2;
    const mat = new THREE.MeshStandardMaterial({
      color: '#0a1f10',
      emissive: new THREE.Color(colors.led),
      emissiveIntensity: 0,
      roughness: 0.35,
    });
    const cell = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.6), mat);
    cell.position.set(
      Math.cos(angle) * (dims.padRadius + 0.4),
      0.7,
      Math.sin(angle) * (dims.padRadius + 0.4)
    );
    cell.rotation.y = -angle;
    group.add(cell);
    ledCells.push(mat);
  }

  // Spins while under construction, hidden once complete — same convention as
  // the facility's build ring.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(dims.padRadius * 0.7, dims.padRadius * 0.76, 32),
    new THREE.MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.75, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.62;
  group.add(ring);

  group.userData.buildRing = ring;
  group.userData.shadowCasters = [pad, ...posts, gantryRing];
  group.userData.ledCells = ledCells;
  // The repair controller recolors this by state (idle/working/ready) —
  // its own emissive color is the "idle" default and never touched directly.
  group.userData.ringMaterial = accentMat;
  return group;
}

/**
 * Tall twisted marker left behind after a base relocates. Built as a stack of
 * cylinder segments, each rotated a little further than the last — the
 * codebase's primitive-only toolkit has no spiral geometry, so the twist is
 * composed rather than modelled directly.
 */
function buildSpireMesh(def) {
  const { dims, colors, beacon } = def;
  const group = new THREE.Group();
  group.name = def.id;

  const shellMat = new THREE.MeshStandardMaterial({ color: colors.shell, roughness: 0.5, metalness: 0.5 });
  const accentMat = new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.4, metalness: 0.6 });

  const segCount = dims.segments;
  const segHeight = dims.height / segCount;
  const shellSegments = [];
  for (let i = 0; i < segCount; i++) {
    const t = i / (segCount - 1);
    const radius = THREE.MathUtils.lerp(dims.baseRadius, dims.topRadius, t);
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.97, radius, segHeight * 1.04, 6),
      i % 2 === 0 ? shellMat : accentMat
    );
    seg.position.y = segHeight * (i + 0.5);
    seg.rotation.y = i * 0.5; // the twist — each segment turned a bit further
    seg.castShadow = true;
    group.add(seg);
    shellSegments.push(seg);
  }

  // Beacon cap: the pulsing light StructureInstance.update() animates.
  const beaconMat = new THREE.MeshStandardMaterial({
    color: '#1a0505',
    emissive: new THREE.Color(beacon.color),
    emissiveIntensity: beacon.baseIntensity,
    roughness: 0.25,
  });
  const beaconMesh = new THREE.Mesh(new THREE.OctahedronGeometry(dims.beaconRadius, 0), beaconMat);
  beaconMesh.position.y = dims.height + dims.beaconRadius;
  group.add(beaconMesh);

  const beaconLight = new THREE.PointLight(beacon.color, beacon.baseIntensity, 60, 2);
  beaconLight.position.y = dims.height + dims.beaconRadius;
  group.add(beaconLight);

  // Small base ring, spinning while it rises — same "under construction" tell
  // as the other two structures, so the convention stays consistent.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(dims.baseRadius * 1.4, dims.baseRadius * 1.6, 24),
    new THREE.MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.75, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.15;
  group.add(ring);

  group.userData.buildRing = ring;
  group.userData.shadowCasters = shellSegments;
  group.userData.beaconMaterial = beaconMat;
  group.userData.beaconLight = beaconLight;
  return group;
}

/** One placed building. */
class StructureInstance {
  constructor(def, { x, z, hN, angle, pad, slot, buildTimeOverride }) {
    this.def = def;
    this.group = buildStructureMesh(def);
    this.x = x;
    this.z = z;
    this.hN = hN; // normalised, so the live amplitude slider cannot strand it
    this.angle = angle;
    this.pad = pad;
    this.slot = slot;
    // Per-instance override of the def's own buildTime — the shared def stays
    // untouched (other instances of the same building still use its normal
    // pace), only this one instance rises slower (or faster).
    this.buildTimeOverride = buildTimeOverride;

    this.health = def.maxHealth;
    this.mode = 'building'; // 'building' | 'idle'
    this.progress = 0;
    // 0 = base, unupgraded. 1-10 index into def.upgradeTiers. Per-instance —
    // upgrading one repair bay never affects another.
    this.upgradeLevel = 0;

    // Doors face outward from the pad centre, so a harvester never has to drive
    // across the parked base station to dock.
    this.group.rotation.y = -angle;

    // Where a vehicle parks to be serviced. Not every structure has one — the
    // power spire is purely decorative and never claims a dock.
    this.dock =
      def.dockOffset != null
        ? { x: x + Math.cos(angle) * def.dockOffset, z: z + Math.sin(angle) * def.dockOffset }
        : null;

    // Track which harvester is currently docking
    this.dockedHarvester = null;
    // Same idea, generic name — the repair bay's single-slot queue reads/writes
    // this instead, so it doesn't fight over a harvester-specific field.
    this.dockedVehicle = null;

    // Buried until it rises, so nothing casts a shadow from under the pad.
    for (const m of this.group.userData.shadowCasters) m.castShadow = false;
  }

  /** Screen-space anchor for the radial menu. */
  get menuAnchorHeight() {
    return this.def.dims.height + (this.def.dims.roofHeight ?? 0) + 2;
  }

  /** Structures never move; the menu reads this to decide whether to follow. */
  get speed() {
    return 0;
  }

  update(dt, heightmap) {
    const groundY = this.hN * heightmap.params.amplitude;
    const g = this.group;

    if (this.mode === 'building') {
      this.progress = Math.min(1, this.progress + dt / (this.buildTimeOverride ?? this.def.buildTime));
      const eased = this.progress * this.progress * (3 - 2 * this.progress);
      // Rises from fully below the pad through it. The terrain is opaque and
      // genuinely triangulated, so the buried part is correctly occluded — no
      // clipping planes, which would need global renderer state for one effect.
      g.position.set(this.x, groundY - this.def.dims.height + eased * this.def.dims.height, this.z);
      g.userData.buildRing.rotation.z += dt * 1.2;

      if (this.progress >= 1) {
        this.mode = 'idle';
        g.userData.buildRing.visible = false;
        for (const m of g.userData.shadowCasters) m.castShadow = true;
      }
    } else {
      g.position.set(this.x, groundY, this.z);
    }

    // Beacon pulse — only the power spire's def carries a `beacon` block, and
    // only once it has finished rising, so it doesn't strobe while still buried.
    if (this.def.beacon && this.mode === 'idle') {
      this._beaconPhase = (this._beaconPhase ?? 0) + dt;
      const { rate, baseIntensity, amplitude } = this.def.beacon;
      const pulse = baseIntensity + amplitude * Math.abs(Math.sin(this._beaconPhase * rate));
      g.userData.beaconMaterial.emissiveIntensity = pulse;
      g.userData.beaconLight.intensity = pulse;
    }
  }
}

export class StructureController {
  constructor(scene, vehicles) {
    this.scene = scene;
    // Optional — only needed for canPlaceAt's base-vehicle exclusion below.
    this.vehicles = vehicles;
    this.instances = [];
    /** Called with (instance) when a building finishes. */
    this.onComplete = null;
  }

  defOf(id) {
    return STRUCTURE_CATALOG.find((d) => d.id === id) ?? null;
  }

  instanceOf(id) {
    return this.instances.find((i) => i.def.id === id) ?? null;
  }

  /**
   * The next unclaimed ring slot on a pad, or null.
   *
   * Buildings no longer place themselves here — the player drops them via
   * `canPlaceAt`/`place` instead — but this is kept as the "is there any room
   * left at all" coarse check a command's `enabled()` runs before entering
   * placement mode, so a doomed placement attempt is refused up front.
   */
  freeSlot(pad, footprint) {
    for (let k = 0; k < SLOT_COUNT; k++) {
      const angle = (k / SLOT_COUNT) * Math.PI * 2 + SLOT_PHASE;
      const x = pad.x + Math.cos(angle) * SLOT_RING;
      const z = pad.z + Math.sin(angle) * SLOT_RING;
      const taken = pad.buildings.some((b) => Math.hypot(b.x - x, b.z - z) < footprint * 1.6);
      if (!taken) return { index: k, x, z, angle };
    }
    return null;
  }

  /**
   * Is (x, z) a legal drop point for this building on this pad?
   *
   * Shared by the live placement preview (so an invalid hover reads red before
   * the player commits) and by `place()` itself, as a final guard against a
   * stale click landing after the pad or its neighbours changed underneath it.
   */
  canPlaceAt(pad, def, x, z) {
    if (Math.hypot(x - pad.x, z - pad.z) + def.footprint > pad.radius) return false;
    // Same overlap rule freeSlot used to enforce on its fixed ring positions,
    // now evaluated at an arbitrary point instead of one of six angles.
    if (pad.buildings.some((b) => Math.hypot(b.x - x, b.z - z) < def.footprint * 1.6)) return false;

    // A deployed base station sitting on this pad is an obstacle too, even
    // though it's a vehicle, not a `pad.buildings` entry — pads have no
    // ownership link back to it (see terraform.js), so this is a proximity
    // check against whichever base is actually parked here right now, not a
    // stored reference. Deliberately just the vehicle's own hull plus a small
    // fixed clearance, not scaled by the new building's footprint the way the
    // building-overlap check above is — a footprint-sized buffer swallowed
    // most or all of a pad this size when footprint values were inflated for
    // visual reasons (see the repair bay's own footprint comment).
    const base = this.vehicles?.instances.find(
      (v) => v.def.id === 'base-station' && v.mode === 'deployed' && Math.hypot(v.group.position.x - pad.x, v.group.position.z - pad.z) <= pad.radius
    );
    if (base && Math.hypot(base.group.position.x - x, base.group.position.z - z) < base.def.dims.hullLength / 2 + 3) {
      return false;
    }

    return true;
  }

  /** Place a building at an explicit point on a pad. Returns the instance, or null if invalid. */
  place(def, pad, pos) {
    if (!this.canPlaceAt(pad, def, pos.x, pos.z)) return null;

    const instance = new StructureInstance(def, {
      x: pos.x,
      z: pos.z,
      hN: pad.targetN,
      // Faces outward from the pad centre — the same convention the old fixed
      // ring slots used, just derived from wherever the player actually clicked.
      angle: Math.atan2(pos.z - pad.z, pos.x - pad.x),
      pad,
    });

    instance.group.userData.selectable = instance;
    this.instances.push(instance);
    this.scene.add(instance.group);
    pad.buildings.push({ id: def.id, x: pos.x, z: pos.z, instance });
    return instance;
  }

  /**
   * Place a freestanding structure with no pad and no build slot — currently
   * only the power spire left behind by a relocated base. Height comes straight
   * from the heightmap rather than a pad's flattened target, since nothing
   * flattens the ground here.
   */
  placeAt(def, x, z, heightmap, { buildTimeOverride } = {}) {
    const instance = new StructureInstance(def, {
      x,
      z,
      hN: heightmap.sampleNormalized(x, z),
      angle: 0,
      buildTimeOverride,
    });

    instance.group.userData.selectable = instance;
    this.instances.push(instance);
    this.scene.add(instance.group);
    return instance;
  }

  update(dt, heightmap) {
    for (const instance of this.instances) {
      const wasBuilding = instance.mode === 'building';
      instance.update(dt, heightmap);
      if (wasBuilding && instance.mode === 'idle') this.onComplete?.(instance);
    }
  }

  /** Terrain regenerated: these stand on a heightfield that no longer exists. */
  clear() {
    for (const instance of this.instances) this.scene.remove(instance.group);
    this.instances.length = 0;
  }
}
