import * as THREE from 'three';
import { World } from './core/world.js';
import { createCameraControls } from './core/controls.js';
import { ChaseCamera } from './core/chaseCamera.js';
import { pickTerrain, findEdgeSpawnPoint, findSpawnPointNear } from './core/pick.js';
import { Menu } from './ui/menu.js';
import { buildSchema } from './ui/controlSchema.js';
import { VehiclePicker } from './ui/vehiclePicker.js';
import { DifficultyScreen, DIFFICULTIES } from './ui/difficultyScreen.js';
import { Hud } from './ui/hud.js';
import { RadialMenu } from './ui/radialMenu.js';
import { VehicleController } from './vehicles/vehicleController.js';
import { VEHICLE_CATALOG } from './vehicles/catalog.js';
import { commandsFor } from './vehicles/commands.js';
import { HarvesterAI } from './vehicles/harvesterAI.js';
import { RepairController } from './vehicles/repairController.js';
import { Terraform } from './core/terraform.js';
import { StructureController } from './structures/structures.js';

const canvas = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 6000);

const world = new World(renderer);
const { heightmap } = world;

camera.position.set(240, heightmap.params.amplitude * 1.5, 320);
const controls = createCameraControls(camera, canvas, heightmap);
controls.target.set(0, heightmap.heightAt(0, 0), 0);
controls.update();

// Move-order marker: a floating red metallic ball dropped on the clicked point.
// It hovers and bobs so it reads against any terrain colour, and it disappears
// the moment the vehicle's order finishes.
const MARKER_HOVER = 4.5;
const marker = new THREE.Mesh(
  new THREE.SphereGeometry(1.6, 24, 16),
  new THREE.MeshStandardMaterial({
    color: 0xd91f2e,
    emissive: 0x3a0206,
    metalness: 1.0,
    roughness: 0.18,
  })
);
marker.castShadow = true;
marker.visible = false;
marker.userData.groundY = 0;
world.scene.add(marker);

function showMarker(point) {
  marker.userData.groundY = point.y;
  marker.position.set(point.x, point.y + MARKER_HOVER, point.z);
  marker.visible = true;
}

/** Bob and spin the marker, and retire it once the vehicle's order is done. */
function updateMarker(elapsed) {
  if (!marker.visible) return;

  if (vehicles.active && !vehicles.active.hasOrder) {
    marker.visible = false;
    return;
  }

  marker.position.y = marker.userData.groundY + MARKER_HOVER + Math.sin(elapsed * 2.4) * 0.6;
  marker.rotation.y = elapsed * 0.8;
}

// Harvest-target marker: the same idea in the crystals' own colour, so "go here"
// and "harvest this" read as different orders at a glance. A second mesh rather
// than a reuse of `marker` because that one retires on the *active* vehicle's
// order finishing — and the harvester being targeted is usually not the vehicle
// the player is driving, so a shared marker would vanish almost at once.
const harvestMarker = new THREE.Mesh(
  new THREE.SphereGeometry(1.6, 24, 16),
  new THREE.MeshStandardMaterial({
    color: 0x2ad9ff,
    emissive: 0x06323d,
    metalness: 1.0,
    roughness: 0.18,
  })
);
harvestMarker.castShadow = true;
harvestMarker.visible = false;
harvestMarker.userData.groundY = 0;
world.scene.add(harvestMarker);

/** Which harvester/field pair the harvest marker is currently vouching for. */
let harvestMarkerFor = null;

function showHarvestMarker(harvester, field) {
  const groundY = heightmap.heightAt(field.x, field.z);
  harvestMarker.userData.groundY = groundY;
  harvestMarker.position.set(field.x, groundY + MARKER_HOVER, field.z);
  harvestMarker.visible = true;
  harvestMarkerFor = { harvester, field };
}

function hideHarvestMarker() {
  harvestMarker.visible = false;
  harvestMarkerFor = null;
}

/** Retire the marker once the order it stands for is no longer outstanding. */
function updateHarvestMarker(elapsed) {
  if (!harvestMarkerFor) return;

  // The driver clears targetField the moment it acts on it, so this covers
  // "picked up", "superseded by a newer pick" and "wiped by a regenerate" alike.
  if (harvestMarkerFor.harvester.targetField !== harvestMarkerFor.field) {
    hideHarvestMarker();
    return;
  }

  harvestMarker.position.y =
    harvestMarker.userData.groundY + MARKER_HOVER + Math.sin(elapsed * 2.4) * 0.6;
  harvestMarker.rotation.y = elapsed * 0.8;
}

// Building placement preview: a flat disc that follows the cursor while
// commandContext.buildPlacementMode is active, sized to the pending building's
// own footprint and colour-coded so an illegal drop reads before it's clicked.
const PLACEMENT_VALID_COLOR = new THREE.Color(0x39ff6a);
const PLACEMENT_INVALID_COLOR = new THREE.Color(0xff3b3b);
const placementPreview = new THREE.Mesh(
  new THREE.CircleGeometry(1, 32),
  new THREE.MeshBasicMaterial({ color: 0x39ff6a, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
);
placementPreview.rotation.x = -Math.PI / 2;
placementPreview.visible = false;
world.scene.add(placementPreview);

function cancelPlacementMode() {
  commandContext.buildPlacementMode = null;
  placementPreview.visible = false;
}

/** Re-picks every frame rather than caching from a stale hover — same idiom
 * as harvest-select's own click-time pick, just run continuously here since
 * the preview has to track the cursor, not just react to a click. */
function updatePlacementPreview(clientX, clientY) {
  const mode = commandContext.buildPlacementMode;
  if (!mode) {
    placementPreview.visible = false;
    return;
  }

  const point = pickTerrain(clientX, clientY, canvas, camera, heightmap, hit);
  if (!point) {
    placementPreview.visible = false;
    return;
  }

  if (placementPreview.userData.footprint !== mode.def.footprint) {
    placementPreview.geometry.dispose();
    placementPreview.geometry = new THREE.CircleGeometry(mode.def.footprint, 32);
    placementPreview.userData.footprint = mode.def.footprint;
  }

  placementPreview.position.set(point.x, point.y + 0.3, point.z);
  placementPreview.visible = true;

  const valid = structures.canPlaceAt(mode.pad, mode.def, point.x, point.z);
  placementPreview.material.color.copy(valid ? PLACEMENT_VALID_COLOR : PLACEMENT_INVALID_COLOR);
}

const vehicles = new VehicleController(world.scene);

const terraform = new Terraform(world);
const structures = new StructureController(world.scene);

const chase = new ChaseCamera(camera, heightmap);

/** True when the camera is locked to a vehicle rather than free-flying. */
function isChasing() {
  return chase.enabled && vehicles.active;
}

// Tap-to-move is a touch affordance: on desktop the vehicle is driven, so a
// stray click should not send it somewhere. Mutable so it can be forced on for
// testing the mobile path from a desktop browser.
const input = {
  tapToMove: matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0,
};

// ---- mouse: move / pan / zoom the camera ----

const hit = new THREE.Vector3();
let dragged = false;
let dragButton = -1;
let lastX = 0;
let lastY = 0;

// touch-action: none on the canvas (needed so a finger-drag orbits the camera
// instead of the browser trying to scroll/pinch-zoom the page) has a side
// effect: on touch devices the double-tap-to-zoom gesture that most browsers'
// synthetic `dblclick` rides on is disabled along with it, so no `dblclick`
// event ever reaches the listener below. A manual detector fills the gap for
// touch only — a real mouse's dblclick is unaffected by touch-action and
// keeps working through the native listener.
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;
let lastTap = null; // { x, y, time } of the most recent unconsumed touch tap
let suppressNextTapMove = false; // set when pointerdown recognises a double-tap or long-press

// A press-and-hold on a vehicle or building also opens its menu — the mouse
// equivalent of a long-press, and the touch one too, sharing one timer and one
// threshold (`dragged`) rather than a second movement tolerance.
const LONG_PRESS_MS = 500;
let longPressTimer = null;

function clearLongPress() {
  if (longPressTimer === null) return;
  clearTimeout(longPressTimer);
  longPressTimer = null;
}

function startLongPress() {
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    if (dragged) return; // moved since the press started — a drag, not a hold
    // Picks at the *live* pointer position, not where the press started half a
    // second ago. An autonomous harvester can drive clear of the original ray
    // inside the hold window, and a pick against stale coordinates then misses
    // a vehicle the cursor is still sitting on.
    if (!pickSelectable(lastX, lastY)) return;
    suppressNextTapMove = true;
    openMenuAt(lastX, lastY);
  }, LONG_PRESS_MS);
}

canvas.addEventListener('pointerdown', (e) => {
  dragged = false;
  dragButton = e.button;
  lastX = e.clientX;
  lastY = e.clientY;
  // Any press on the world dismisses an open command menu. The menu's own
  // buttons live outside the canvas, so their clicks never reach here.
  radialMenu.close();
  clearLongPress();

  if (e.pointerType === 'touch') {
    const prev = lastTap;
    const now = performance.now();
    const isDoubleTap =
      prev &&
      now - prev.time <= DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_TAP_PX;

    if (isDoubleTap) {
      // Recognised before pointerup runs, so the second tap's move order can
      // be skipped outright rather than issued and then cancelled after the
      // fact. No long-press timer either — this press is already spoken for.
      suppressNextTapMove = true;
      lastTap = null;
      openMenuAt(e.clientX, e.clientY);
      return;
    }
    lastTap = { x: e.clientX, y: e.clientY, time: now };
  }

  // Primary button/touch only — a held right-drag pans the chase camera and
  // must not also pop the menu.
  if (e.button !== 0) return;
  startLongPress();
});

canvas.addEventListener('pointermove', (e) => {
  if (e.buttons === 0) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  if (dx !== 0 || dy !== 0) {
    dragged = true;
    // A drag can never be half of a double-tap, nor a long-press hold.
    lastTap = null;
    clearLongPress();
  }

  // MapControls handles the drag itself whenever the camera is free.
  if (!isChasing()) return;
  if (dragButton === 2) chase.pan(dx, dy);
  else chase.orbit(dx, dy);
});

// A gesture the OS took over (e.g. a system back-swipe) fires this instead of
// pointerup — without clearing state here a stale long-press timer could
// still fire, or a genuine tap get misread as the first half of a double-tap.
canvas.addEventListener('pointercancel', () => {
  dragButton = -1;
  dragged = false;
  lastTap = null;
  suppressNextTapMove = false;
  clearLongPress();
});

canvas.addEventListener('pointerup', (e) => {
  dragButton = -1;
  clearLongPress();
  if (suppressNextTapMove) {
    // This tap was already spent opening the radial menu in pointerdown.
    suppressNextTapMove = false;
    return;
  }

  // Handle building placement mode
  if (commandContext.buildPlacementMode) {
    const { def, pad } = commandContext.buildPlacementMode;
    const point = pickTerrain(e.clientX, e.clientY, canvas, camera, heightmap, hit);
    if (point && structures.canPlaceAt(pad, def, point.x, point.z)) {
      structures.place(def, pad, { x: point.x, z: point.z });
      cancelPlacementMode();
    }
    // An invalid click is not a cancel — mirrors "click far from any bloom has
    // no effect" from harvest targeting. Stays in placement mode either way.
    return;
  }

  // Handle harvest selection mode
  if (commandContext.harvestSelectMode) {
    const point = pickTerrain(e.clientX, e.clientY, canvas, camera, heightmap, hit);
    if (point) {
      // requireOnField so a click on bare ground finds nothing, rather than
      // quietly sending the harvester to whichever field is nearest the miss.
      const field = world.blooms.nearestTo(point.x, point.z, {
        minStock: 0,
        requireOnField: true,
      });
      if (field) {
        const { harvester } = commandContext.harvestSelectMode;
        harvester.targetField = field;
        // Anchored to the field's centre, not the click: it has to be obvious
        // *which* field was taken, even when the click landed out at the edge.
        showHarvestMarker(harvester, field);
      }
    }
    commandContext.harvestSelectMode = null;
    return;
  }

  if (!input.tapToMove || dragged || e.button !== 0) return;

  const point = pickTerrain(e.clientX, e.clientY, canvas, camera, heightmap, hit);
  if (!point) {
    marker.visible = false;
    return;
  }
  // The ball marks an accepted move order, so a refused one (water, or no
  // vehicle spawned yet) leaves nothing behind to chase.
  if (vehicles.commandActive(point.x, point.z, heightmap)) showMarker(point);
  else marker.visible = false;
});

// Right-drag pans, so the browser menu has to stay out of the way.
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- double-click a vehicle: open its command menu ----

const _pickRay = new THREE.Raycaster();
const _pickNdc = new THREE.Vector2();

/**
 * Which vehicle is under this screen point, if any.
 *
 * A real raycast against the meshes rather than a radius test around the
 * origin: the base station is 15.6 x 3.4, nowhere near round enough for a
 * sphere to feel honest. The fleet is a handful of vehicles, so the cost is
 * irrelevant.
 */
function pickSelectable(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  _pickNdc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  _pickRay.setFromCamera(_pickNdc, camera);

  const hits = _pickRay.intersectObjects(
    [...vehicles.instances, ...structures.instances].map((i) => i.group),
    true
  );
  if (!hits.length) return null;

  let node = hits[0].object;
  while (node && !node.userData.selectable) node = node.parent;
  return node?.userData.selectable ?? null;
}

/**
 * Open the radial menu for whatever's at this screen point, if anything.
 * Shared by the native `dblclick` listener (real mouse/trackpad, or the rare
 * touch browser that does still synthesise dblclick) and the manual touch
 * double-tap detector in `pointerdown` above.
 */
function openMenuAt(clientX, clientY) {
  const instance = pickSelectable(clientX, clientY);
  if (!instance) return;

  // On touch, the first tap of a double-tap can already have issued a move
  // order through pointerup before this ever runs (the native dblclick path
  // only, since the manual detector suppresses it up front). Double-tapping a
  // vehicle means "command this one", not "drive it to the ground behind it"
  // — so take that order back. A building has no order to cancel.
  if (input.tapToMove) {
    instance.arrive?.('cancelled');
    marker.visible = false;
  }

  radialMenu.openFor(instance, commandsFor(instance, commandContext));
}

// Kept for real mice/trackpads, and as a fallback on any touch browser that
// still does synthesise it despite touch-action: none — harmless if it fires
// a second time, since openMenuAt is idempotent per tap.
canvas.addEventListener('dblclick', (e) => {
  // A double-click that ended a drag is really an orbit; the flag is set by the
  // first pixel of movement, so this is a strict test.
  if (dragged) return;
  openMenuAt(e.clientX, e.clientY);
});

// MapControls owns the wheel when it is enabled, so this only has to cover the
// chase case — otherwise both would zoom at once.
canvas.addEventListener(
  'wheel',
  (e) => {
    if (!isChasing()) return;
    e.preventDefault();
    chase.zoom(Math.sign(e.deltaY) * 3);
  },
  { passive: false }
);

// ---- keyboard: drive the vehicle ----

const driveKeys = { w: false, a: false, s: false, d: false };
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  // Keys are bound to the window, so the difficulty overlay has to swallow them
  // explicitly or the player drives a vehicle that does not exist yet.
  if (k in driveKeys && !isTextInputFocused() && !game.difficultyScreen?.open) driveKeys[k] = true;
  if (e.key === 'Escape' && commandContext.buildPlacementMode) cancelPlacementMode();
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in driveKeys) driveKeys[k] = false;
});
// Keys held while the window loses focus would otherwise stick down.
addEventListener('blur', () => {
  for (const k in driveKeys) driveKeys[k] = false;
});

function isTextInputFocused() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

function applyDriveInput() {
  const throttle = (driveKeys.w ? 1 : 0) - (driveKeys.s ? 1 : 0);
  const steer = (driveKeys.d ? 1 : 0) - (driveKeys.a ? 1 : 0);
  vehicles.driveActive(throttle, steer);
}

/**
 * Lamps follow the sun, so dusk, night and dawn all light up without the
 * player touching anything. The manual override is for inspecting the beam.
 */
const lighting = { forceHeadlights: false };
function headlightsWanted() {
  if (lighting.forceHeadlights) return true;
  const dusk = vehicles.active?.def.lights?.duskElevation ?? 8;
  return world.atmosphere.params.elevation <= dusk;
}

// The UI needs a handle that can both regenerate terrain and reach the renderer.
const view = {
  renderer,
  chase,
  input,
  lighting,
  regenerate(params) {
    world.regenerate(params);
    // The markers are anchored to terrain that no longer exists.
    marker.visible = false;
    hideHarvestMarker();
    // A pending placement targets a pad that's about to be orphaned too.
    cancelPlacementMode();
    // So are any pads: regenerate swaps in a fresh heightfield array, which
    // orphans the flattening the old one was carrying.
    terraform.clear();
    // Buildings stand on the old heightfield, and harvesters hold references to
    // fields that no longer exist.
    structures.clear();
    harvesterAI.reset();
    repairController.reset();
    radialMenu.close();
  },
  setChase(enabled) {
    chase.enabled = enabled;
    if (enabled) {
      if (vehicles.active) chase.reset(vehicles.active);
    } else if (vehicles.active) {
      // Hand the camera back to MapControls looking at the vehicle, or it
      // snaps somewhere unexpected the first time the player drags.
      controls.target.copy(vehicles.active.group.position);
      controls.update();
    }
  },
};

const menu = new Menu(buildSchema(world, view));

/**
 * Progression state. The unlock is *latched*: raising the sea level shrinks the
 * island and can push the explored percentage back down, so a threshold
 * crossing is not monotone and must not be able to take the vehicle away again.
 */
const game = {
  difficulty: DIFFICULTIES[1],
  unlocked: false,
  difficultyScreen: null,
  credits: 0,
  // Latched the same way `unlocked` is: relocating spends nothing, so without
  // a latch a base built just past 50k could spend back below it and lose the
  // option it already earned.
  reachedRelocateThreshold: false,
  earn(n) {
    this.credits += n;
    if (this.credits >= 50000) this.reachedRelocateThreshold = true;
    return this.credits;
  },
  /** @returns {boolean} false when short, so the caller can explain why. */
  spend(n) {
    if (this.credits < n) return false;
    this.credits -= n;
    return true;
  },
};

const hud = new Hud();

const radialMenu = new RadialMenu(camera, {
  onCommand(cmd, instance) {
    cmd.execute?.(instance, commandContext);
  },
});

/**
 * Check if a route from facility to spawn point is drivable (climb grade acceptable).
 * Samples 5 points along the path to validate.
 */
function isSpawnLocationViable(facilityX, facilityZ, spawnX, spawnZ, maxClimbGrade) {
  if (heightmap.heightAt(spawnX, spawnZ) <= heightmap.seaLevelY + 1) return false;

  const samples = 5;
  let worst = 0;
  let prev = heightmap.heightAt(facilityX, facilityZ);
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const px = facilityX + (spawnX - facilityX) * t;
    const pz = facilityZ + (spawnZ - facilityZ) * t;
    const h = heightmap.heightAt(px, pz);
    const run = Math.hypot(spawnX - facilityX, spawnZ - facilityZ) / samples;
    worst = Math.max(worst, Math.abs(h - prev) / Math.max(run, 1e-3));
    prev = h;
  }
  return worst < maxClimbGrade * 0.8;
}

/**
 * Roll a unit out of a factory, parked at its dock facing away from the
 * building. On mountains, searches for a drivable exit angle to avoid spawning
 * the vehicle in terrain it cannot escape from.
 */
function produceUnit(def, facility) {
  const angles = [0, 0.9, -0.9, 1.6, -1.6, 2.4];
  const maxClimbGrade = def.maxClimbGrade ?? 0.62;
  let dockOffset = facility.def.dockOffset;
  let attempt = 0;
  const maxAttempts = 5;

  while (attempt < maxAttempts) {
    for (const angleOffset of angles) {
      const angle = facility.angle + angleOffset;
      const dock = {
        x: facility.x + Math.cos(angle) * dockOffset,
        z: facility.z + Math.sin(angle) * dockOffset,
      };

      if (isSpawnLocationViable(facility.x, facility.z, dock.x, dock.z, maxClimbGrade)) {
        const point = new THREE.Vector3(dock.x, heightmap.heightAt(dock.x, dock.z) + 0.05, dock.z);
        return vehicles.spawn(def, point, facility.angle, { activate: false });
      }
    }

    // No viable angle at this distance; try farther out
    dockOffset += 8;
    attempt++;
  }

  // Fallback: spawn at original dock position even if not ideal
  const dock = facility.dock;
  const point = new THREE.Vector3(dock.x, heightmap.heightAt(dock.x, dock.z) + 0.05, dock.z);
  return vehicles.spawn(def, point, facility.angle, { activate: false });
}

// A facility ships one harvester the moment it finishes. Without that bootstrap
// the first harvester could never be afforded — nothing earns credits until one
// exists.
structures.onComplete = (instance) => {
  if (!instance.def.freeUnitOnComplete) return;
  produceUnit(vehicles.defOf(instance.def.produces), instance);
};

const harvesterAI = new HarvesterAI({ vehicles, world, heightmap, structures, game });
const repairController = new RepairController({ vehicles, heightmap, game });

/** Everything a command might need, so commands.js imports no game systems. */
const commandContext = { vehicles, world, heightmap, terraform, structures, game, produceUnit };

const vehiclePicker = new VehiclePicker(VEHICLE_CATALOG, {
  vehicles,
  onSelect(def) {
    vehiclePicker.setOpen(false);
    // Selecting a vehicle that is already out there takes the keys back rather
    // than spawning a second one — both stay alive, so the scout can carry on
    // exploring once the base station has arrived.
    const existing = vehicles.instanceOf(def);
    const instance = existing
      ? vehicles.setActive(existing)
      : (() => {
          // The very first vehicle has nothing to spawn near, so it still
          // picks a point along the camera's facing at the map edge. Every
          // vehicle after that arrives beside whichever one is already out
          // there, which — since maxRadius sits well inside a sight radius —
          // also means it lands on ground the fog of war already knows about.
          // For base station, prefer spawning at scout's original location
          let spawnOrigin = vehicles.active ?? vehicles.instances[0];
          if (def.id === 'base-station' && game.scoutSpawnPoint) {
            spawnOrigin = { group: { position: { x: game.scoutSpawnPoint.x, z: game.scoutSpawnPoint.z } }, def: { sightRadius: 80 } };
          }
          const { point, heading } = spawnOrigin
            ? findSpawnPointNear(heightmap, spawnOrigin.group.position, {
                minRadius: (spawnOrigin.def.dims?.hullLength ?? 5.2 + def.dims.hullLength) / 2 + 4,
                // Comfortably inside the reference vehicle's sight radius, so
                // the spot lands on ground its fog reveal has already covered.
                maxRadius: spawnOrigin.def.sightRadius * 0.8,
                camera,
              })
            : findEdgeSpawnPoint(heightmap, camera);
          point.y += 0.05; // avoid z-fighting with the ground on the spawn frame
          const instance = vehicles.spawn(def, point, heading);
          // Store scout's spawn point for base station to reuse later
          if (def.id === 'scout-buggy' && !game.scoutSpawnPoint) {
            game.scoutSpawnPoint = { x: point.x, z: point.z };
          }
          return instance;
        })();
    // Snap in behind the new vehicle rather than flying across the map to it.
    if (chase.enabled) chase.reset(instance);
  },
});

vehiclePicker.lockText = (def) =>
  def.unlock === 'exploration'
    ? `Locked — chart ${Math.round(game.difficulty.unlockAt * 100)}% of the island`
    : 'Locked';

/** Latch the unlock once the island is charted enough. */
function updateProgression(explored) {
  if (game.unlocked || explored < game.difficulty.unlockAt) return;
  game.unlocked = true;
  for (const def of VEHICLE_CATALOG) {
    if (def.unlock === 'exploration') vehiclePicker.setUnlocked(def.id, true);
  }
}

game.difficultyScreen = new DifficultyScreen((difficulty) => {
  game.difficulty = difficulty;
  // Re-render the lock hint now that the target percentage is known.
  for (const def of VEHICLE_CATALOG) vehiclePicker.applyLockState(def.id);
  // Nothing is spawned yet, so open the drawer on the one vehicle available.
  vehiclePicker.setOpen(true);
});

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let statsTimer = 0;
let frames = 0;
let fps = 0;

/**
 * One simulation step.
 *
 * Split out of `animate` so the world can be advanced deterministically without
 * a real frame — see `window.__step`. A full harvest cycle is tens of seconds
 * and the browser throttles requestAnimationFrame whenever the page is not
 * being looked at, which makes wall-clock testing of anything slow unreliable.
 *
 * @param {number} dt seconds to advance
 * @param {object} [opts]
 * @param {boolean} [opts.render] false to skip drawing and the stats readout
 */
function tick(dt, { render = true } = {}) {
  // Vehicles move first so the camera frames where they actually ended up.
  applyDriveInput();
  world.update(dt, camera);
  // Between the input and the fleet: the AI must see this frame's keys before
  // deciding (so it never issues an order the player just cancelled) and set
  // its targets before the fleet consumes them.
  harvesterAI.update(dt);
  // After harvesterAI: a repairing harvester is already paused by the check
  // above, so this is the only thing setting its target this frame.
  repairController.update(dt);
  vehicles.update(dt, heightmap, headlightsWanted(), camera);
  structures.update(dt, heightmap);

  // Reveal after the vehicles have moved — world.update() runs before them, so
  // committing there would upload a frame stale.
  for (const v of vehicles.instances) {
    world.fog.reveal(v.group.position.x, v.group.position.z, v.def.sightRadius, v);
  }
  for (const s of structures.instances) {
    world.fog.reveal(s.x, s.z, s.def.sightRadius, s);
  }
  world.fog.commit();

  if (isChasing()) {
    // MapControls would fight the chase rig for the camera transform.
    controls.enabled = false;
    chase.update(dt, vehicles.active);
  } else {
    controls.enabled = true;
    controls.update();
  }

  // After the camera has settled, so the menu projects against this frame's
  // view rather than lagging it by one.
  terraform.update(dt);
  radialMenu.update();

  if (!render) return;

  updateMarker(clock.elapsedTime);
  updateHarvestMarker(clock.elapsedTime);
  updatePlacementPreview(lastX, lastY);
  canvas.classList.toggle(
    'crosshair-mode',
    !!commandContext.harvestSelectMode || !!commandContext.buildPlacementMode
  );
  vehiclePicker.update(dt);
  renderer.render(world.scene, camera);

  frames++;
  statsTimer += dt;
  if (statsTimer >= 0.5) {
    fps = Math.round(frames / statsTimer);
    frames = 0;
    statsTimer = 0;

    // Exploration is polled here rather than per frame: it re-derives the land
    // mask whenever the sea-level slider has moved, and twice a second is
    // plenty for a percentage a player reads.
    const explored = world.fog.exploredFraction;
    updateProgression(explored);
    hud.update({
      vehicle: vehicles.active,
      explored,
      difficulty: game.difficulty,
      unlocked: game.unlocked,
      credits: game.credits,
      // Nothing to report before there is an economy — a permanent "0 cr"
      // during the scouting game is just noise.
      economyActive: game.credits > 0 || structures.instances.length > 0,
      load: harvesterAI.stateOf(vehicles.active)?.load ?? 0,
    });

    const info = renderer.info.render;
    let line3 = '';
    if (vehicles.active) {
      const v = vehicles.active;
      const gradePct = (v.grade * 100).toFixed(0);
      const badges =
        (v.braking ? ' · BRAKE' : '') +
        (v.reversing ? ' · REV' : '') +
        (v.headlightsOn ? ' · lights' : '');
      line3 = v.blocked
        ? `\nvehicle: blocked — ${gradePct}% grade too steep${badges}`
        : `\nvehicle: ${v.forwardSpeed.toFixed(1)} u/s · ${gradePct}% grade${badges}`;
    }
    menu.setStats(
      `${fps} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris\n` +
      `sun ${world.atmosphere.params.elevation.toFixed(0)}° · seed ${heightmap.params.seed}` +
      line3
    );
  }
}

function animate() {
  requestAnimationFrame(animate);
  tick(Math.min(clock.getDelta(), 0.1));
}

animate();

/**
 * Dev helper: advance the simulation by `seconds` at a fixed step, without
 * rendering. Lets a slow system (a harvest run, a regrowth cycle) be exercised
 * and asserted from the console in a fraction of the wall-clock time.
 */
window.__step = (seconds, dt = 1 / 60) => {
  const steps = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < steps; i++) tick(dt, { render: false });
  return { steps, simulated: +(steps * dt).toFixed(2) };
};

// Wait for the first frame before revealing, so the terrain never flashes in.
requestAnimationFrame(() => {
  requestAnimationFrame(() => document.getElementById('loading').classList.add('hidden'));
});

/**
 * Dev probe: drops spheres on random points and reports how far each ended up
 * from the CPU heightfield. Any non-zero drift means the GPU and CPU disagree
 * about where the ground is, which would break every future gameplay system.
 * Run `__probe()` in the console.
 */
window.__probe = (count = 100) => {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(2.5, 12, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffcc44, roughness: 0.5 });
  const half = heightmap.params.size * 0.45;
  let worst = 0;

  for (let i = 0; i < count; i++) {
    const x = (Math.random() * 2 - 1) * half;
    const z = (Math.random() * 2 - 1) * half;
    const y = heightmap.heightAt(x, z);
    const s = new THREE.Mesh(geo, mat);
    s.position.set(x, y + 2.5, z);
    s.castShadow = true;
    group.add(s);
    worst = Math.max(worst, Math.abs(heightmap.sampleNormalized(x, z) * heightmap.params.amplitude - y));
  }

  world.scene.add(group);
  console.log(`[probe] ${count} spheres placed, max CPU sampling drift ${worst.toExponential(2)}`);
  console.log('[probe] visually confirm every sphere rests on the surface, none floating or buried');
  return group;
};

Object.assign(window, {
  world, camera, renderer, controls, chase, THREE, vehicles, vehiclePicker, input, lighting, driveKeys,
  game, hud, terraform, radialMenu, commandsFor, commandContext,
  structures, harvesterAI, repairController, produceUnit,
});
