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
    footprint: 13, // radius of the pad slot it claims
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
 */
export function buildStructureMesh(def) {
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

/** One placed building. */
class StructureInstance {
  constructor(def, { x, z, hN, angle, pad, slot }) {
    this.def = def;
    this.group = buildStructureMesh(def);
    this.x = x;
    this.z = z;
    this.hN = hN; // normalised, so the live amplitude slider cannot strand it
    this.angle = angle;
    this.pad = pad;
    this.slot = slot;

    this.health = def.maxHealth;
    this.mode = 'building'; // 'building' | 'idle'
    this.progress = 0;

    // Doors face outward from the pad centre, so a harvester never has to drive
    // across the parked base station to dock.
    this.group.rotation.y = -angle;

    // Where a harvester parks to unload.
    this.dock = {
      x: x + Math.cos(angle) * def.dockOffset,
      z: z + Math.sin(angle) * def.dockOffset,
    };

    // Buried until it rises, so nothing casts a shadow from under the pad.
    for (const m of this.group.userData.shadowCasters) m.castShadow = false;
  }

  /** Screen-space anchor for the radial menu. */
  get menuAnchorHeight() {
    return this.def.dims.height + this.def.dims.roofHeight + 2;
  }

  /** Structures never move; the menu reads this to decide whether to follow. */
  get speed() {
    return 0;
  }

  update(dt, heightmap) {
    const groundY = this.hN * heightmap.params.amplitude;
    const g = this.group;

    if (this.mode === 'building') {
      this.progress = Math.min(1, this.progress + dt / this.def.buildTime);
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
  }
}

export class StructureController {
  constructor(scene) {
    this.scene = scene;
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
   * The next unclaimed slot on a pad, or null.
   *
   * Ascending order, so the first building always lands in the same place —
   * which makes it an assertion rather than a screenshot squint.
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

  /** Place a building on a pad. Returns the instance, or null if there is no room. */
  place(def, pad) {
    const slot = this.freeSlot(pad, def.footprint);
    if (!slot) return null;

    const instance = new StructureInstance(def, {
      x: slot.x,
      z: slot.z,
      hN: pad.targetN,
      angle: slot.angle,
      pad,
      slot: slot.index,
    });

    instance.group.userData.selectable = instance;
    this.instances.push(instance);
    this.scene.add(instance.group);
    pad.buildings.push({ id: def.id, x: slot.x, z: slot.z, slot: slot.index, instance });
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
