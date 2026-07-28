import * as THREE from 'three';
import { World } from './core/world.js';
import { createCameraControls } from './core/controls.js';
import { ChaseCamera } from './core/chaseCamera.js';
import { pickTerrain, findEdgeSpawnPoint } from './core/pick.js';
import { Menu } from './ui/menu.js';
import { buildSchema } from './ui/controlSchema.js';
import { VehiclePicker } from './ui/vehiclePicker.js';
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

const hit = new THREE.Vector3();
let dragged = false;
canvas.addEventListener('pointerdown', () => (dragged = false));
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) dragged = true;
});
canvas.addEventListener('pointerup', (e) => {
  if (dragged || e.button !== 0) return;
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

// WASD camera panning, additive to MapControls' drag-pan/orbit/zoom.
const panKeys = { w: false, a: false, s: false, d: false };
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in panKeys && !isTextInputFocused()) panKeys[k] = true;
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in panKeys) panKeys[k] = false;
});

function isTextInputFocused() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

const chase = new ChaseCamera(camera, heightmap);

/** True when the camera is locked to a vehicle rather than free-flying. */
function isChasing() {
  return chase.enabled && vehicles.active;
}

const ORBIT_SPEED = 1.6; // radians / second
const DOLLY_SPEED = 40; // world units / second
const MIN_CHASE_DISTANCE = 8;
const MAX_CHASE_DISTANCE = 140;

/** While chasing, the pan keys swing and dolly the camera around the vehicle. */
function applyChaseKeys(dt) {
  if (panKeys.a) chase.azimuthOffset += ORBIT_SPEED * dt;
  if (panKeys.d) chase.azimuthOffset -= ORBIT_SPEED * dt;
  if (panKeys.w) chase.distance -= DOLLY_SPEED * dt;
  if (panKeys.s) chase.distance += DOLLY_SPEED * dt;
  chase.distance = THREE.MathUtils.clamp(chase.distance, MIN_CHASE_DISTANCE, MAX_CHASE_DISTANCE);
}

// MapControls owns the wheel when it is enabled, so this only has to cover the
// chase case — otherwise both would zoom at once.
canvas.addEventListener(
  'wheel',
  (e) => {
    if (!isChasing()) return;
    e.preventDefault();
    chase.distance = THREE.MathUtils.clamp(
      chase.distance + Math.sign(e.deltaY) * 3,
      MIN_CHASE_DISTANCE,
      MAX_CHASE_DISTANCE
    );
  },
  { passive: false }
);

const PAN_SPEED = 140; // world units / second
const _panForward = new THREE.Vector3();
const _panRight = new THREE.Vector3();
function applyKeyboardPan(dt) {
  if (!panKeys.w && !panKeys.a && !panKeys.s && !panKeys.d) return;

  camera.getWorldDirection(_panForward);
  _panForward.y = 0;
  _panForward.normalize();
  _panRight.crossVectors(_panForward, camera.up).normalize();

  const move = new THREE.Vector3();
  if (panKeys.w) move.add(_panForward);
  if (panKeys.s) move.addScaledVector(_panForward, -1);
  if (panKeys.d) move.add(_panRight);
  if (panKeys.a) move.addScaledVector(_panRight, -1);
  if (move.lengthSq() === 0) return;

  move.normalize().multiplyScalar(PAN_SPEED * dt);
  camera.position.add(move);
  controls.target.add(move);
}

// The UI needs a handle that can both regenerate terrain and reach the renderer.
const view = {
  renderer,
  chase,
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

const vehiclePicker = new VehiclePicker(VEHICLE_CATALOG, {
  onSelect(def) {
    vehiclePicker.setOpen(false);
    const { point, heading } = findEdgeSpawnPoint(heightmap, camera);
    point.y += 0.05; // avoid z-fighting with the ground on the spawn frame
    const instance = vehicles.spawn(def, point, heading);
    // Snap in behind the new vehicle rather than flying across the map to it.
    if (chase.enabled) chase.reset(instance);
  },
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
  world.update(dt, camera);
  vehicles.update(dt, heightmap);

  if (isChasing()) {
    // MapControls would fight the chase rig for the camera transform.
    controls.enabled = false;
    applyChaseKeys(dt);
    chase.update(dt, vehicles.active);
  } else {
    controls.enabled = true;
    applyKeyboardPan(dt);
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
    const info = renderer.info.render;
    let line3 = '';
    if (vehicles.active) {
      const v = vehicles.active;
      const gradePct = (v.grade * 100).toFixed(0);
      line3 = v.blocked
        ? `\nvehicle: blocked — ${gradePct}% grade too steep`
        : `\nvehicle: ${v.speed.toFixed(1)} u/s · ${gradePct}% grade`;
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

Object.assign(window, { world, camera, renderer, controls, chase, THREE, vehicles, vehiclePicker });
