import * as THREE from 'three';
import { World } from './core/world.js';
import { createCameraControls } from './core/controls.js';
import { ChaseCamera } from './core/chaseCamera.js';
import {
  pickTerrain,
  findEdgeSpawnPoint,
  findSpawnPointNear,
  findTeamSpawnPoints,
} from './core/pick.js';
import { Menu } from './ui/menu.js';
import { buildSchema } from './ui/controlSchema.js';
import { VehiclePicker } from './ui/vehiclePicker.js';
import { DifficultyScreen, DIFFICULTIES } from './ui/difficultyScreen.js';
import { PortalScreen } from './ui/portalScreen.js';
import { AiDifficultyScreen } from './ui/aiDifficultyScreen.js';
import { createTeams, PLAYER_TEAM_ID } from './core/team.js';
import { FogMask } from './core/fogOfWar.js';
import { Hud } from './ui/hud.js';
import { RadialMenu } from './ui/radialMenu.js';
import { VehicleController } from './vehicles/vehicleController.js';
import { VEHICLE_CATALOG } from './vehicles/catalog.js';
import { commandsFor } from './vehicles/commands.js';
import { HarvesterAI } from './vehicles/harvesterAI.js';
import { RepairController } from './vehicles/repairController.js';
import { TrafficController } from './vehicles/trafficController.js';
import { AiCommander } from './vehicles/aiCommander.js';
import { CombatController } from './vehicles/combatController.js';
import { Terraform } from './core/terraform.js';
import { StructureController } from './structures/structures.js';
import { Entities } from './core/entities.js';

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

  // No active vehicle (it just died, or nothing has spawned) leaves nothing
  // for the marker to stand for — `active && !active.hasOrder` alone would
  // never trip on a null active, and the ball would bob forever.
  if (!vehicles.active || !vehicles.active.hasOrder) {
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
  // "picked up", "superseded by a newer pick" and "wiped by a regenerate"
  // alike. `.dead` covers the one thing that doesn't touch targetField at
  // all — the harvester being destroyed outright, which would otherwise
  // leave this bobbing over an empty field forever.
  if (harvestMarkerFor.harvester.dead || harvestMarkerFor.harvester.targetField !== harvestMarkerFor.field) {
    hideHarvestMarker();
    return;
  }

  harvestMarker.position.y =
    harvestMarker.userData.groundY + MARKER_HOVER + Math.sin(elapsed * 2.4) * 0.6;
  harvestMarker.rotation.y = elapsed * 0.8;
}

// Building placement preview: a neon square outline, sized to the pending
// building's own real footprint (not a generic circle), that snaps to a fixed
// grid while commandContext.buildPlacementMode is active. Cyan reads as a
// legal drop, red as illegal — the same signal a click will actually get.
const GRID_CELL_SIZE = 4; // world units per snap step
const PLACEMENT_VALID_COLOR = new THREE.Color(0x22e5ff);
const PLACEMENT_INVALID_COLOR = new THREE.Color(0xff3b3b);
const OUTLINE_THICKNESS = 0.6;
const OUTLINE_HEIGHT = 0.7;

/** Snap a world point to the nearest grid intersection. */
function snapToGrid(x, z) {
  return {
    x: Math.round(x / GRID_CELL_SIZE) * GRID_CELL_SIZE,
    z: Math.round(z / GRID_CELL_SIZE) * GRID_CELL_SIZE,
  };
}

/**
 * The building's real footprint, in world units — its actual plan dimensions,
 * not `def.footprint` (which is a clearance radius for overlap checking, and
 * on its own reads far too big or small as an outline: a repair bay's
 * footprint value alone would draw larger than the whole area it can legally
 * stand in).
 */
function footprintSize(def) {
  if (def.dims.width != null && def.dims.depth != null) return { w: def.dims.width, d: def.dims.depth };
  if (def.dims.padRadius != null) return { w: def.dims.padRadius * 2, d: def.dims.padRadius * 2 };
  return { w: def.footprint * 2, d: def.footprint * 2 };
}

/** A four-bar picture-frame outline — cheap, and every bar shares one
 * material so a single colour swap recolors the whole frame at once. */
function buildFootprintOutline() {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: PLACEMENT_VALID_COLOR });
  const bars = [
    new THREE.Mesh(new THREE.BoxGeometry(1, OUTLINE_HEIGHT, OUTLINE_THICKNESS), material),
    new THREE.Mesh(new THREE.BoxGeometry(1, OUTLINE_HEIGHT, OUTLINE_THICKNESS), material),
    new THREE.Mesh(new THREE.BoxGeometry(OUTLINE_THICKNESS, OUTLINE_HEIGHT, 1), material),
    new THREE.Mesh(new THREE.BoxGeometry(OUTLINE_THICKNESS, OUTLINE_HEIGHT, 1), material),
  ];
  for (const bar of bars) group.add(bar);
  group.userData.bars = bars;
  group.userData.material = material;
  group.visible = false;
  world.scene.add(group);
  return group;
}

const placementPreview = buildFootprintOutline();

/** Resize the four bars to frame a `w` x `d` rectangle, in place. */
function resizeFootprintOutline(group, w, d) {
  const [top, bottom, left, right] = group.userData.bars;
  const halfW = w / 2;
  const halfD = d / 2;

  top.geometry.dispose();
  top.geometry = new THREE.BoxGeometry(w + OUTLINE_THICKNESS, OUTLINE_HEIGHT, OUTLINE_THICKNESS);
  top.position.set(0, 0, -halfD);

  bottom.geometry.dispose();
  bottom.geometry = new THREE.BoxGeometry(w + OUTLINE_THICKNESS, OUTLINE_HEIGHT, OUTLINE_THICKNESS);
  bottom.position.set(0, 0, halfD);

  left.geometry.dispose();
  left.geometry = new THREE.BoxGeometry(OUTLINE_THICKNESS, OUTLINE_HEIGHT, d + OUTLINE_THICKNESS);
  left.position.set(-halfW, 0, 0);

  right.geometry.dispose();
  right.geometry = new THREE.BoxGeometry(OUTLINE_THICKNESS, OUTLINE_HEIGHT, d + OUTLINE_THICKNESS);
  right.position.set(halfW, 0, 0);
}

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

  const snapped = snapToGrid(point.x, point.z);
  const groundY = heightmap.heightAt(snapped.x, snapped.z);

  if (placementPreview.userData.defId !== mode.def.id) {
    const size = footprintSize(mode.def);
    resizeFootprintOutline(placementPreview, size.w, size.d);
    placementPreview.userData.defId = mode.def.id;
  }

  placementPreview.position.set(snapped.x, groundY + OUTLINE_HEIGHT / 2 + 0.1, snapped.z);
  placementPreview.visible = true;

  const valid = structures.canPlaceAt(mode.pad, mode.def, snapped.x, snapped.z);
  placementPreview.userData.material.color.copy(valid ? PLACEMENT_VALID_COLOR : PLACEMENT_INVALID_COLOR);
}

// Spanner queue icon: a small transparent neon wrench hovering over any
// vehicle currently waiting its turn at a repair bay (`state === 'queued'`
// specifically — not while still driving over, only once it's actually
// stuck in line). One per queued vehicle, created and torn down as the
// queue's membership changes.
function buildSpannerIcon() {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color: 0x22e5ff,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const handle = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.18), material);
  handle.position.x = 0.1;
  const head = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.09, 8, 16), material);
  head.position.x = -0.75;
  group.add(handle, head);
  return group;
}

const queueIcons = new Map(); // vehicle instance -> icon group

function syncQueueIcons() {
  const queued = new Set();
  for (const inst of vehicles.instances) {
    if (inst.repair?.state !== 'queued') continue;
    queued.add(inst);
    if (!queueIcons.has(inst)) {
      const icon = buildSpannerIcon();
      world.scene.add(icon);
      queueIcons.set(inst, icon);
    }
  }

  for (const [inst, icon] of queueIcons) {
    if (queued.has(inst)) continue;
    world.scene.remove(icon);
    queueIcons.delete(inst);
  }

  for (const [inst, icon] of queueIcons) {
    const pos = inst.group.position;
    icon.position.set(pos.x, pos.y + inst.menuAnchorHeight + 1.4, pos.z);
    // Billboarded so it reads the same from any camera angle, the same idea
    // as every other "float above a vehicle" marker in the game, just facing
    // the viewer instead of sitting flat.
    icon.quaternion.copy(camera.quaternion);
  }
}

// A deployed base is drivable — nothing in the pad/building system is tied
// to its live position — but driving off the dock spot is a one-way trigger:
// once it's unambiguously left, a power spire grows (slowly — visibly slower
// than the one Relocate Base plants) at the vacated spot, since whatever's
// still built there needs a story for why it's still powered.
const BASE_MOVE_THRESHOLD = 45; // comparable to the pad's own inner radius
const SPIRE_GROW_TIME = 60; // seconds — deliberately slow, distinct from Relocate Base's

function checkBaseRepositioning() {
  for (const inst of vehicles.instances) {
    if (inst.def.id !== 'base-station' || inst.mode !== 'deployed') continue;
    if (inst.spireGrown || !inst.deployOrigin) continue;
    const dist = Math.hypot(
      inst.group.position.x - inst.deployOrigin.x,
      inst.group.position.z - inst.deployOrigin.z
    );
    if (dist < BASE_MOVE_THRESHOLD) continue;
    structures.placeAt(structures.defOf('power-spire'), inst.deployOrigin.x, inst.deployOrigin.z, heightmap, {
      buildTimeOverride: SPIRE_GROW_TIME,
      teamId: inst.teamId,
    });
    inst.spireGrown = true;
  }
}

const vehicles = new VehicleController(world.scene);

const terraform = new Terraform(world);
const structures = new StructureController(world.scene, vehicles);
// The one destroy pipeline every killable thing routes through — see
// core/entities.js. Hooks are registered once every system that needs one
// exists, further down.
const entities = new Entities();

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
    if (point) {
      // Same snap the preview outline used, so the click lands exactly where
      // the player was shown it would.
      const snapped = snapToGrid(point.x, point.z);
      if (structures.canPlaceAt(pad, def, snapped.x, snapped.z)) {
        structures.place(def, pad, snapped);
        cancelPlacementMode();
      }
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
        // The harvester this mode was opened for can have been destroyed
        // while the player was still aiming the click.
        if (!harvester.dead) {
          harvester.targetField = field;
          // Anchored to the field's centre, not the click: it has to be
          // obvious *which* field was taken, even when the click landed out
          // at the edge.
          showHarvestMarker(harvester, field);
        }
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
  // Keys are bound to the window, so every full-screen overlay before play
  // starts has to swallow them explicitly or the player drives a vehicle that
  // does not exist yet.
  const overlayOpen =
    game.portalScreen?.open || game.difficultyScreen?.open || game.aiDifficultyScreen?.open;
  if (k in driveKeys && !isTextInputFocused() && !overlayOpen) driveKeys[k] = true;
  if (e.key === 'Escape' && commandContext.buildPlacementMode) cancelPlacementMode();
  // Debug: destroy whatever's under the cursor — 2B's destroy pipeline has
  // nothing to trigger it yet (combat is 2D), so this is its only way to run
  // until then.
  if (k === 'k' && !isTextInputFocused() && !overlayOpen) {
    const target = pickSelectable(lastX, lastY);
    if (target) entities.queueDestroy(target);
  }
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

/**
 * Progression state. The unlock is *latched*: raising the sea level shrinks the
 * island and can push the explored percentage back down, so a threshold
 * crossing is not monotone and must not be able to take the vehicle away again.
 */
const game = {
  mode: null, // 'sandbox' | 'multiplayer-ai', set once the portal routes past it
  difficulty: DIFFICULTIES[1],
  unlocked: false,
  portalScreen: null,
  difficultyScreen: null,
  aiDifficultyScreen: null,
  aiMatch: null, // { teamCount, buildDelaySeconds } once Multiplayer AI is chosen
  // Empty until beginMatch populates it for a Multiplayer AI match — tick()
  // iterates this every frame regardless of mode, so it must never be null.
  aiCommanders: [],
  // Sandbox is a one-team match, so this is never empty and nothing has to
  // special-case "no teams". Rebuilt by beginMatch once the mode is known.
  teams: createTeams(0),
  get playerTeam() {
    return this.teams[PLAYER_TEAM_ID];
  },
  /**
   * The owning team of any vehicle, structure or pad.
   *
   * Falls back to the player's team rather than null: everything placed before
   * teams existed (and everything in sandbox) is the player's, and a null here
   * would turn every economy call site into a null check for a case that
   * cannot happen.
   */
  teamOf(entity) {
    return this.teams[entity?.teamId ?? PLAYER_TEAM_ID] ?? this.playerTeam;
  },
  /** The fog mask a team reveals into. */
  fogFor(teamId) {
    return this.teams[teamId ?? PLAYER_TEAM_ID]?.fog ?? this.playerTeam.fog;
  },
  // Placeholder persistence: a tiny progress snapshot in localStorage, not the
  // full world state. Real save/load (terrain, vehicles, structures, fog) is
  // its own backend-backed design — see the roadmap's Phase 3.
  saveGame() {
    const snapshot = {
      mode: this.mode,
      difficultyId: this.difficulty?.id,
      credits: this.playerTeam.credits,
      savedAt: Date.now(),
    };
    localStorage.setItem('ptg-save', JSON.stringify(snapshot));
    alert('Progress saved (placeholder — full save/load is coming in a future update).');
    return snapshot;
  },
  loadGame() {
    const raw = localStorage.getItem('ptg-save');
    if (!raw) {
      alert('No saved game found.');
      return null;
    }
    const snapshot = JSON.parse(raw);
    alert(`Found a save from ${new Date(snapshot.savedAt).toLocaleString()} (placeholder — restoring it isn't implemented yet).`);
    return snapshot;
  },
};

const menu = new Menu(buildSchema(world, view, game));

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
        return vehicles.spawn(def, point, facility.angle, {
          activate: false,
          // A factory's output belongs to whoever owns the factory.
          teamId: facility.teamId,
        });
      }
    }

    // No viable angle at this distance; try farther out
    dockOffset += 8;
    attempt++;
  }

  // Fallback: spawn at original dock position even if not ideal
  const dock = facility.dock;
  const point = new THREE.Vector3(dock.x, heightmap.heightAt(dock.x, dock.z) + 0.05, dock.z);
  return vehicles.spawn(def, point, facility.angle, {
    activate: false,
    teamId: facility.teamId,
  });
}

// A facility ships one harvester the moment it finishes. Without that bootstrap
// the first harvester could never be afforded — nothing earns credits until one
// exists.
structures.onComplete = (instance) => {
  if (!instance.def.freeUnitOnComplete) return;
  // produces[0] by convention — the economy unit. A facility must never
  // bootstrap a team with a free combat vehicle.
  produceUnit(vehicles.defOf(instance.def.produces[0]), instance);
};

// ---- combat visuals: tracers and wreckage ----

// A small fixed pool of reusable line segments. Shots are frequent and short-
// lived, so building a mesh per shot would allocate (and need disposing)
// dozens of times a second; the pool caps that at a constant.
const TRACER_POOL_SIZE = 24;
const TRACER_LIFETIME = 0.09; // seconds
const tracers = [];
for (let i = 0; i < TRACER_POOL_SIZE; i++) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  line.visible = false;
  line.frustumCulled = false; // endpoints move every use; a stale bound would pop
  world.scene.add(line);
  tracers.push({ line, mat, timer: 0 });
}
let nextTracer = 0;

/** Draw a shot that has *already* been resolved — purely cosmetic. */
function showTracer(from, to, teamId, fromHeight, toHeight) {
  const t = tracers[nextTracer];
  nextTracer = (nextTracer + 1) % TRACER_POOL_SIZE;
  const pos = t.line.geometry.attributes.position;
  pos.setXYZ(0, from.x, heightmap.heightAt(from.x, from.z) + fromHeight, from.z);
  pos.setXYZ(1, to.x, heightmap.heightAt(to.x, to.z) + toHeight, to.z);
  pos.needsUpdate = true;
  // Team colour, so an unattended AI-vs-AI fight is readable at a glance.
  t.mat.color.setHex(game.teams[teamId]?.color ?? 0xffffff);
  t.line.visible = true;
  t.timer = TRACER_LIFETIME;
}

function updateTracers(dt) {
  for (const t of tracers) {
    if (!t.line.visible) continue;
    t.timer -= dt;
    if (t.timer <= 0) {
      t.line.visible = false;
      continue;
    }
    t.mat.opacity = Math.max(0, t.timer / TRACER_LIFETIME) * 0.9;
  }
}

/**
 * A scorched, half-collapsed marker left where something died.
 *
 * Deliberately not the unit's own mesh tipped over: the wreck has to read as
 * *not a unit* at a glance, or a battlefield of corpses becomes unparseable.
 * Left permanently — this is the record of what happened here.
 */
function leaveWreckage(inst) {
  const scale = inst.kind === 'structure' ? 3 : Math.max(1.2, (inst.def.dims?.hullLength ?? 5) * 0.28);
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1613, roughness: 0.95, metalness: 0.1 });
  for (let i = 0; i < 3; i++) {
    const chunk = new THREE.Mesh(
      new THREE.BoxGeometry(scale * (0.5 + Math.random() * 0.6), scale * 0.3, scale * (0.4 + Math.random() * 0.5)),
      mat
    );
    chunk.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, Math.random() * 0.4);
    chunk.position.set((Math.random() - 0.5) * scale, scale * 0.12, (Math.random() - 0.5) * scale);
    chunk.castShadow = true;
    group.add(chunk);
  }
  const p = inst.x !== undefined ? { x: inst.x, z: inst.z } : inst.group.position;
  group.position.set(p.x, heightmap.heightAt(p.x, p.z), p.z);
  world.scene.add(group);
}

const harvesterAI = new HarvesterAI({ vehicles, world, heightmap, structures, game });
const repairController = new RepairController({ vehicles, structures, heightmap, game });
const trafficController = new TrafficController({ vehicles });
const combatController = new CombatController({
  vehicles,
  structures,
  heightmap,
  entities,
  game,
  onShot: showTracer,
});

// ---- destroy pipeline: every system that owns instance-keyed state
// registers its own cleanup hook, in the order it needs to run.

// Reservation/state cleanup first, while the instance's own fields (teamId,
// repair, etc.) are still intact for these to read.
entities.onDestroy((inst) => harvesterAI.onDestroy(inst));
entities.onDestroy((inst) => repairController.onDestroy(inst));
entities.onDestroy((inst) => trafficController.onDestroy(inst));
// Anyone aiming at the deceased. combatController revalidates targets every
// tick anyway, so this is belt-and-braces rather than load-bearing — but it
// means a turret never spends even one frame tracking a corpse.
entities.onDestroy((inst) => {
  for (const v of vehicles.instances) {
    if (v.combatTarget === inst) v.combatTarget = null;
  }
});
// The record of what died here, placed while the instance still knows where
// it was — vehicles.remove/structures.remove below drop that.
entities.onDestroy((inst) => leaveWreckage(inst));
// The radial menu holds a direct reference, not a lookup — nothing else
// would ever notice it's pointed at a dead instance.
entities.onDestroy((inst) => {
  if (radialMenu.instance === inst) radialMenu.close();
});
// The vehicle the player is driving needs a replacement lined up before
// anything downstream (queueIcons, the marker fixes above, chase) has to
// cope with `vehicles.active` going away.
entities.onDestroy((inst) => handleVehicleLoss(inst));
// The actual removal — splice out of the owning collection and free the
// mesh — runs last, once every hook above has had a chance to read the
// instance's live state.
entities.onDestroy((inst) => {
  if (inst.kind === 'vehicle') vehicles.remove(inst);
  else if (inst.kind === 'structure') structures.remove(inst);
});

const RESPAWN_DELAY = 3; // seconds before a team with nothing left gets a fresh scout
const pendingRespawns = []; // { teamId, timer }

/**
 * The vehicle the player is driving just died. Hand control to another unit
 * of theirs if one survives; otherwise queue a fresh scout at their home
 * point after a short delay rather than leaving them locked out mid-match.
 * A no-op for every AI team and for any vehicle that wasn't the driven one.
 */
function handleVehicleLoss(inst) {
  if (inst.kind !== 'vehicle' || vehicles.active !== inst) return;

  const pos = inst.group.position;
  let survivor = null;
  let bestDist = Infinity;
  for (const v of vehicles.instances) {
    if (v.teamId !== inst.teamId || v === inst || v.dead) continue;
    const d = Math.hypot(v.group.position.x - pos.x, v.group.position.z - pos.z);
    if (d < bestDist) {
      bestDist = d;
      survivor = v;
    }
  }
  if (survivor) {
    vehicles.setActive(survivor);
    if (chase.enabled) chase.reset(survivor);
    return;
  }

  // isChasing() already falls back to free MapControls whenever `active` is
  // null, so there is nothing else to arrange for the gap before the respawn.
  vehicles.active = null;
  pendingRespawns.push({ teamId: inst.teamId, timer: RESPAWN_DELAY });
}

/** Frame-counted, not setTimeout — so it advances correctly under
 * window.__step's synthetic ticks too, not just real wall-clock frames. */
function updateRespawns(dt) {
  for (let i = pendingRespawns.length - 1; i >= 0; i--) {
    const r = pendingRespawns[i];
    r.timer -= dt;
    if (r.timer > 0) continue;
    pendingRespawns.splice(i, 1);

    const team = game.teams[r.teamId];
    // The player already took control of something else in the meantime —
    // the free scout would be an unwanted extra, not a rescue.
    if (!team || (team.isHuman && vehicles.active)) continue;

    const scoutDef = vehicles.defOf('scout-buggy');
    const origin = team.homePoint ?? { x: 0, z: 0 };
    const spot = findSpawnPointNear(heightmap, origin, { minRadius: 10, maxRadius: 60, camera });
    spot.point.y += 0.05;
    const inst = vehicles.spawn(scoutDef, spot.point, spot.heading, {
      teamId: r.teamId,
      activate: team.isHuman,
    });
    if (team.isHuman && chase.enabled) chase.reset(inst);
  }
}

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
          // findSpawnPointNear/findEdgeSpawnPoint face a vehicle back toward
          // its reference point — for the base station that consistently
          // leaves it facing out to sea instead of toward land, so flip it.
          const spawnHeading = def.id === 'base-station' ? heading + Math.PI : heading;
          const instance = vehicles.spawn(def, point, spawnHeading);
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

/** Shared by every mode's difficulty pick — only the difficulty source and
 * any per-mode extras (like the AI match config) differ. */
function beginMatch(difficulty) {
  game.difficulty = difficulty;
  // Sandbox is a one-team match; Multiplayer AI adds one team per AI opponent.
  game.teams = createTeams(game.aiMatch?.teamCount ?? 0);

  // The player keeps the mask the world already built (the shaders point at
  // its texture and must not be re-pointed). Every AI team gets a CPU-only
  // one — they scout for themselves and nothing draws their view.
  game.playerTeam.fog = world.fog;
  world.fogMasks.length = 1;
  for (const team of game.teams) {
    if (team.isHuman) continue;
    team.fog = new FogMask(world.fogTerrain);
    world.fogMasks.push(team.fog);
  }
  // Sandbox keeps the explore-to-unlock pacing untouched. An AI match starts
  // every team on equal footing — making the human scout first while AI
  // teams build from tick one would not be a fair opening.
  if (game.mode === 'multiplayer-ai') {
    game.unlocked = true;
    for (const def of VEHICLE_CATALOG) {
      if (def.unlock === 'exploration') vehiclePicker.setUnlocked(def.id, true);
    }
    deployStartingForces();
    // One commander per AI team, built after deployStartingForces so
    // team.homePoint already exists for it to explore outward from.
    game.aiCommanders = game.teams
      .filter((team) => !team.isHuman)
      .map(
        (team) =>
          new AiCommander({
            team,
            buildDelaySeconds: game.aiMatch?.buildDelaySeconds ?? 0,
            ctx: commandContext,
            camera,
          })
      );
  }
  // Re-render the lock hint now that the target percentage is known.
  for (const def of VEHICLE_CATALOG) vehiclePicker.applyLockState(def.id);
  // The drawer is only the opening move in sandbox; an AI match has already
  // put everyone on the board.
  if (game.mode !== 'multiplayer-ai') vehiclePicker.setOpen(true);
}

/**
 * Put every team on the island at once, evenly spaced around the coast.
 *
 * Each gets the same opening — a base station to deploy and a scout to look
 * around with — so "all versus all" starts genuinely symmetric. Only the
 * player's scout takes the keys; the rest are somebody else's problem until
 * the AI commander exists to drive them.
 */
function deployStartingForces() {
  const baseDef = vehicles.defOf('base-station');
  const scoutDef = vehicles.defOf('scout-buggy');
  const starts = findTeamSpawnPoints(heightmap, game.teams.length);

  game.teams.forEach((team, i) => {
    const { point, heading } = starts[i];
    point.y += 0.05; // avoid z-fighting with the ground on the spawn frame
    // A stable anchor for this team even after the base itself is gone —
    // the respawn-a-scout fallback (see handleVehicleLoss) needs somewhere
    // to aim that doesn't depend on the base station surviving.
    team.homePoint = { x: point.x, z: point.z };

    // findEdgeSpawnPointAtAngle faces a vehicle back toward the map centre,
    // which for the base station reads as facing out to sea — the same flip
    // the picker's own base spawn applies.
    vehicles.spawn(baseDef, point, heading + Math.PI, { activate: false, teamId: team.id });

    const beside = findSpawnPointNear(heightmap, point, {
      minRadius: baseDef.dims.hullLength / 2 + scoutDef.dims.hullLength / 2 + 4,
      maxRadius: baseDef.sightRadius * 0.8,
      camera,
    });
    beside.point.y += 0.05;
    vehicles.spawn(scoutDef, beside.point, beside.heading, {
      activate: team.isHuman,
      teamId: team.id,
    });
  });
}

game.difficultyScreen = new DifficultyScreen((difficulty) => {
  game.mode = 'sandbox';
  beginMatch(difficulty);
});

game.aiDifficultyScreen = new AiDifficultyScreen(({ difficulty, teamCount, buildDelaySeconds }) => {
  game.mode = 'multiplayer-ai';
  game.aiMatch = { teamCount, buildDelaySeconds };
  beginMatch(difficulty);
});

game.portalScreen = new PortalScreen((modeId) => {
  if (modeId === 'sandbox') game.difficultyScreen.show();
  else if (modeId === 'multiplayer-ai') game.aiDifficultyScreen.show();
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
// AI teams' fog reveals are staggered across this many frames — see the
// reveal loop below for why the player's own mask is exempt.
const FOG_STAGGER_PERIOD = 3;
let fogRevealCounter = 0;

function tick(dt, { render = true } = {}) {
  // Vehicles move first so the camera frames where they actually ended up.
  applyDriveInput();
  world.update(dt, camera);
  // Between the input and the fleet: the AI must see this frame's keys before
  // deciding (so it never issues an order the player just cancelled) and set
  // its targets before the fleet consumes them.
  harvesterAI.update(dt);
  // Same reasoning, one level up: each AI team's own deploy/build/scout
  // decisions need this frame's harvester targets already set (so it isn't
  // second-guessing an order harvesterAI just issued) and have to land before
  // trafficController reads what everyone is driving toward.
  for (const commander of game.aiCommanders) commander.update(dt);
  // After harvesterAI: a repairing harvester is already paused by the check
  // above, so this is the only thing setting its target this frame.
  repairController.update(dt);
  // After both AI systems have set their targets, and before movement reads
  // them: this is what actually decides `yielding` and hands out collision
  // damage for the frame about to run.
  trafficController.update(dt);
  // After every driver has had its say and before the fleet moves: a shot is
  // resolved against where things are *this* frame, and any resulting death is
  // queued for the single flush below rather than removed underneath the
  // movement step that is about to run.
  combatController.update(dt);
  vehicles.update(dt, heightmap, headlightsWanted(), camera);
  structures.update(dt, heightmap);

  // Flushed here, and nowhere else — after every system above has taken its
  // turn iterating vehicles/structures for the frame, before the fog reveal
  // loop below iterates them again. Never mid-iteration: a system splicing
  // an array while another system is still walking it would skip or
  // double-visit an entry.
  entities.flush();

  // Reveal after the vehicles have moved — world.update() runs before them, so
  // committing there would upload a frame stale. Each entity reveals into its
  // own team's mask: an AI scouting the far coast must not chart it for you.
  // The player's own mask still updates every frame (it drives the visible
  // fog shader and the explored-percentage readout); AI masks are only ever
  // read on the CPU on their own schedule, so they're staggered one team per
  // frame — the reveal loop is now an N-times cost with N teams, and nothing
  // needs an AI's fog fresher than "within the last few frames."
  fogRevealCounter = (fogRevealCounter + 1) % FOG_STAGGER_PERIOD;
  for (const v of vehicles.instances) {
    if (v.teamId !== PLAYER_TEAM_ID && v.teamId % FOG_STAGGER_PERIOD !== fogRevealCounter) continue;
    const mask = game.fogFor(v.teamId);
    if (mask) mask.reveal(v.group.position.x, v.group.position.z, v.def.sightRadius, v);
  }
  for (const s of structures.instances) {
    if (s.teamId !== PLAYER_TEAM_ID && s.teamId % FOG_STAGGER_PERIOD !== fogRevealCounter) continue;
    const mask = game.fogFor(s.teamId);
    if (mask) mask.reveal(s.x, s.z, s.def.sightRadius, s);
  }
  // Only the player's mask is drawn, so only it needs uploading; the AI masks
  // are read on the CPU and have no texture to commit.
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
  checkBaseRepositioning();
  updateRespawns(dt);
  radialMenu.update();

  if (!render) return;

  updateTracers(dt);
  updateMarker(clock.elapsedTime);
  updateHarvestMarker(clock.elapsedTime);
  updatePlacementPreview(lastX, lastY);
  syncQueueIcons();
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
      credits: game.playerTeam.credits,
      // Nothing to report before there is an economy — a permanent "0 cr"
      // during the scouting game is just noise.
      economyActive: game.playerTeam.credits > 0 || structures.instances.length > 0,
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
  structures, harvesterAI, repairController, trafficController, produceUnit,
  syncQueueIcons, queueIcons, checkBaseRepositioning,
  updatePlacementPreview, placementPreview, snapToGrid, footprintSize, resizeFootprintOutline,
  entities, pendingRespawns, pickSelectable, combatController, leaveWreckage,
});
