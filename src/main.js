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
import { VehicleController } from './vehicles/vehicleController.js';
import { VEHICLE_CATALOG } from './vehicles/catalog.js';

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

const vehicles = new VehicleController(world.scene);

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

canvas.addEventListener('pointerdown', (e) => {
  dragged = false;
  dragButton = e.button;
  lastX = e.clientX;
  lastY = e.clientY;
});

canvas.addEventListener('pointermove', (e) => {
  if (e.buttons === 0) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  if (dx !== 0 || dy !== 0) dragged = true;

  // MapControls handles the drag itself whenever the camera is free.
  if (!isChasing()) return;
  if (dragButton === 2) chase.pan(dx, dy);
  else chase.orbit(dx, dy);
});

canvas.addEventListener('pointerup', (e) => {
  dragButton = -1;
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
    // The marker is anchored to terrain that no longer exists.
    marker.visible = false;
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
};

const hud = new Hud();

const vehiclePicker = new VehiclePicker(VEHICLE_CATALOG, {
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
          const reference = vehicles.active ?? vehicles.instances[0];
          const { point, heading } = reference
            ? findSpawnPointNear(heightmap, reference.group.position, {
                minRadius: (reference.def.dims.hullLength + def.dims.hullLength) / 2 + 4,
                // Comfortably inside the reference vehicle's sight radius, so
                // the spot lands on ground its fog reveal has already covered.
                maxRadius: reference.def.sightRadius * 0.8,
                camera,
              })
            : findEdgeSpawnPoint(heightmap, camera);
          point.y += 0.05; // avoid z-fighting with the ground on the spawn frame
          return vehicles.spawn(def, point, heading);
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

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  // Vehicles move first so the camera frames where they actually ended up.
  applyDriveInput();
  world.update(dt, camera);
  vehicles.update(dt, heightmap, headlightsWanted());

  // Reveal after the vehicles have moved — world.update() runs before them, so
  // committing there would upload a frame stale.
  for (const v of vehicles.instances) {
    world.fog.reveal(v.group.position.x, v.group.position.z, v.def.sightRadius, v);
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

  updateMarker(clock.elapsedTime);
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
    hud.update(vehicles.active, explored, game.difficulty, game.unlocked);

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

animate();

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
  game, hud,
});
