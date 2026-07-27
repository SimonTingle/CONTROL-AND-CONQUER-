import * as THREE from 'three';
import { World } from './core/world.js';
import { createCameraControls } from './core/controls.js';
import { pickTerrain, isBuildable, findEdgeSpawnPoint } from './core/pick.js';
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

// A marker showing where the ground was picked — the seed of unit selection and
// build placement. It sits on the CPU heightfield, which is the proof that the
// CPU field and the GPU displacement agree.
const marker = new THREE.Mesh(
  new THREE.ConeGeometry(3, 10, 6),
  new THREE.MeshStandardMaterial({ color: 0x4fd1c5, emissive: 0x113a36, roughness: 0.4 })
);
marker.castShadow = true;
marker.visible = false;
world.scene.add(marker);

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

  const underwater = point.y <= heightmap.seaLevelY + 0.001;
  const moved = !underwater && vehicles.commandActive(point.x, point.z, heightmap);

  marker.position.copy(point);
  marker.position.y += 5;
  marker.visible = true;
  marker.material.color.set(
    moved || isBuildable(heightmap, point.x, point.z) ? 0x4fd1c5 : 0xd9534f
  );
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
  regenerate(params) {
    world.regenerate(params);
    // The marker is anchored to terrain that no longer exists.
    marker.visible = false;
  },
};

const menu = new Menu(buildSchema(world, view));

const vehiclePicker = new VehiclePicker(VEHICLE_CATALOG, {
  onSelect(def) {
    vehiclePicker.setOpen(false);
    const { point, heading } = findEdgeSpawnPoint(heightmap, camera);
    point.y += 0.05; // avoid z-fighting with the ground on the spawn frame
    vehicles.spawn(def, point, heading);
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

  applyKeyboardPan(dt);
  controls.update();
  world.update(dt, camera);
  vehicles.update(dt, heightmap);
  vehiclePicker.update(dt);
  renderer.render(world.scene, camera);

  frames++;
  statsTimer += dt;
  if (statsTimer >= 0.5) {
    fps = Math.round(frames / statsTimer);
    frames = 0;
    statsTimer = 0;
    const info = renderer.info.render;
    menu.setStats(
      `${fps} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris\n` +
      `sun ${world.atmosphere.params.elevation.toFixed(0)}° · seed ${heightmap.params.seed}`
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

Object.assign(window, { world, camera, renderer, controls, THREE, vehicles, vehiclePicker });
