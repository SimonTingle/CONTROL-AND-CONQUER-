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
import { StatisticsScreen } from './ui/statisticsScreen.js';
import { buildSchema } from './ui/controlSchema.js';
import { VehiclePicker } from './ui/vehiclePicker.js';
import { DifficultyScreen, DIFFICULTIES } from './ui/difficultyScreen.js';
import { PortalScreen } from './ui/portalScreen.js';
import { AuthScreen } from './ui/authScreen.js';
import { BuilderScreen } from './builder/builderScreen.js';
import { SoundScreen } from './sound/soundScreen.js';
import * as radio from './audio/radio.js';
import { Chatter } from './audio/chatter.js';
import { pushRadioLine, clearRadioFeed } from './ui/radioFeed.js';
import { isGodModeAccount } from './core/adminAccount.js';
import { loadCustomRecipes } from './sound/customSounds.js';
import { soundCatalogFor } from './sound/soundCatalog.js';
import { loadCustomDefs } from './builder/customVehicles.js';
import { catalogFor } from './builder/customCatalog.js';
import { validateDef } from './builder/vehicleDraft.js';
import { api } from './net/api.js';
import { serialize, deserialize } from './core/snapshot.js';
import { AiDifficultyScreen } from './ui/aiDifficultyScreen.js';
import { createTeams, PLAYER_TEAM_ID } from './core/team.js';
import { FogMask } from './core/fogOfWar.js';
import { Hud } from './ui/hud.js';
import { Minimap } from './ui/minimap.js';
import { RadialMenu } from './ui/radialMenu.js';
import { VehicleController } from './vehicles/vehicleController.js';
import { HeadlightPool } from './vehicles/headlightPool.js';
import { VEHICLE_CATALOG } from './vehicles/catalog.js';
import { commandsFor } from './vehicles/commands.js';
import { HarvesterAI } from './vehicles/harvesterAI.js';
import { RepairController } from './vehicles/repairController.js';
import { FacilityControl, CLEARED, DOCKED, HOLDING } from './vehicles/facilityControl.js';
import { TrafficController } from './vehicles/trafficController.js';
import { AiCommander } from './vehicles/aiCommander.js';
import { CombatController } from './vehicles/combatController.js';
import * as audio from './audio/audio.js';
import { Projectiles, resetProjectileIds } from './vehicles/projectiles.js';
import { ProjectileFx, nightFactor } from './render/projectileFx.js';
import { Bounties, resetCoinIds } from './vehicles/bounty.js';
import { BountyFx } from './render/bountyFx.js';
import { CreditBurst } from './ui/creditBurst.js';
import { MatchEndScreen } from './ui/matchEndScreen.js';
import { Terraform } from './core/terraform.js';
import { Craters } from './core/craters.js';
import { DEFAULT_TERRAIN } from './terrain/heightmap.js';
import { SIM_DT, simClock, advanceSimClock, resetSimClock } from './core/simClock.js';
import { hashState } from './core/stateHash.js';
import { Intent, IntentQueue, applyIntent } from './net/intents.js';
import { LockstepSession } from './net/lockstep.js';
import { MatchClient } from './net/matchClient.js';
import { LobbyScreen } from './ui/lobbyScreen.js';
import { updateNetDebug, hideNetDebug } from './ui/netDebug.js';
import { StructureController } from './structures/structures.js';
import { Entities } from './core/entities.js';
import { NavGrid } from './core/navGrid.js';
import { PerfHud } from './core/perfHud.js';
import { TickProfiler } from './core/tickProfiler.js';
import { AutoQuality } from './core/autoQuality.js';
import { IS_MOBILE } from './core/platform.js';
import { showToast } from './ui/toast.js';

// __APP_VERSION__/__BUILD_TIME__ are literal strings substituted at build
// time by vite.config.js's `define` — not runtime values, so they describe
// exactly what was actually built, including a `-dirty` suffix if the build
// was made from uncommitted changes. Logged before any game setup runs, so
// "which version is this" is answerable even from a broken load — and
// stamped onto `game` (once it exists, see `beginMatch`'s neighbourhood)
// for console access without scrolling back through the log.
console.log(`[Procedural Terrain] ${__APP_VERSION__} · built ${__BUILD_TIME__}`);

// Phase 1 verification gap: this environment's browser tooling has no real
// touch/pointer CDP emulation, so IS_MOBILE can never actually read true
// here. Logged plainly so a real device can confirm it without devtools —
// see also the perf HUD's device line, set once the renderer/shadow settings
// below are known.
console.log(`[Procedural Terrain] IS_MOBILE=${IS_MOBILE}`);

const canvas = document.getElementById('viewport');

// docs/performance-optimization-plan.md Phase 1 — mobile was measured at
// ~10fps; DPR alone compounds every fragment cost paid downstream (shadows,
// terrain shader), so it's the highest-leverage single setting here. MSAA
// (antialias) is comparatively expensive on mobile tile-based GPUs too, cut
// alongside it rather than left to fight the lower resolution for the same
// visual-quality budget.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !IS_MOBILE,
  powerPreference: 'high-performance',
});
// Captured so autoQuality has something to restore to after dropping to 1 under
// load. On a Retina Mac this is 2, i.e. 4x the fragments of DPR 1 — measured at
// 4.4ms vs 1.65ms, which makes it the biggest single GPU lever left once the
// headlight-pool fix removed the spotlight blowup.
const BASE_PIXEL_RATIO = Math.min(window.devicePixelRatio, IS_MOBILE ? 1 : 2);
// userForced: set if the player ever picks a render resolution themselves, after
// which autoQuality stops touching it. Mirrors shadowQuality.userForced below.
const renderQuality = { userForced: false };
renderer.setPixelRatio(BASE_PIXEL_RATIO);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 6000);

// docs/performance-optimization-plan.md Phase 0 — on by default via ?perf=1,
// toggleable at runtime with the 'p' key (mirrors the settings drawer's 'm').
const perfHud = new PerfHud();
// Off by default (time() degrades to a bare fn() call, zero overhead) —
// "10fps but only 106 draws / 121k tris" proved the bottleneck is CPU-side
// JS, not the GPU, so this exists to show which system it actually is
// instead of guessing. Toggled alongside the perf HUD itself.
const tickProfiler = new TickProfiler();
const autoQuality = new AutoQuality();
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'p' && e.target === document.body) perfHud.toggle();
  // 'o' for "overhead" (breakdown) — shares 'p''s reasoning for why this is a
  // dedicated key rather than folded into it: the two are independently
  // useful (fps alone is enough most of the time; the breakdown is only
  // needed once fps already looks wrong) and the profiler's own per-call
  // overhead, though small, isn't something to pay for by default the way
  // perfHud.record()'s array push already is.
  if (e.key.toLowerCase() === 'o' && e.target === document.body) {
    tickProfiler.enabled = !tickProfiler.enabled;
    tickProfiler.reset();
  }
});
window.__tickProfiler = tickProfiler; // console access, same convention as window.__benchmark
window.__autoQuality = autoQuality;

const world = new World(renderer);

// Procedural, spatial audio — see src/audio/audio.js. Initialized as soon as
// both the camera and the scene exist; actual playback stays silent until
// resume() below fires on the first real pointer event.
audio.initAudio(camera, world.scene);
// Captured once, before autoQuality (below) ever has a chance to raise it —
// the value auto-quality restores to once fps recovers.
const BASE_FOG_DENSITY = world.atmosphere.params.fogDensity;
const { heightmap } = world;

// docs/performance-optimization-plan.md Phase 2 — shadows were identified as
// the likely single biggest mobile GPU cost: PCFSoftShadowMap (multi-tap
// per fragment) at a 2048² map. Mobile now defaults to a cheap, unfiltered
// map at half the resolution; desktop keeps the soft/high-res look. Exposed
// as a settings-drawer toggle (controlSchema.js's "Performance" group) so
// either platform can opt into the other's setting — a phone that turns out
// to handle it fine, or a desktop user who'd rather have the fps.
// userForced: set once the player touches the settings-drawer toggle themselves — after
// that, auto-quality (below) leaves shadow quality alone rather than fighting an explicit
// choice. Fog density is left out of that guard since there's no manual fog control to defer to.
// High by default on every platform, mobile included — unlike antialiasing and pixel ratio
// just above, this one isn't a per-frame cost that scales with resolution, so there's no
// mobile-specific reason to start it lower than desktop.
const shadowQuality = { high: true, userForced: false };
function applyShadowQuality(high) {
  shadowQuality.high = high;
  renderer.shadowMap.type = high ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
  const size = high ? 2048 : 1024;
  const sun = world.atmosphere.sunLight;
  sun.shadow.mapSize.set(size, size);
  // Three.js only allocates the shadow render target at this size on next
  // use; disposing the old one (if any) forces that reallocation instead of
  // silently keeping the previous resolution.
  sun.shadow.map?.dispose();
  sun.shadow.map = null;
  renderer.shadowMap.needsUpdate = true;
  // The shadow filter algorithm is baked into each material's compiled
  // shader program at first use, not read live from renderer.shadowMap.type
  // on every frame — so without this, the settings-drawer toggle would only
  // affect meshes created *after* it's flipped, not the ones already on
  // screen. Forcing every current material to recompile makes it apply
  // immediately, matching what the toggle visibly promises.
  world.scene.traverse((obj) => {
    if (!obj.material) return;
    for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      mat.needsUpdate = true;
    }
  });
  // Caster-set trimming (Phase 2, second half): the filter/resolution change
  // above cuts per-fragment cost; this cuts how many objects draw into the
  // shadow pass at all. Each group's shadowCasters array (structures.js,
  // vehicleFactory.js) is ordered primary-silhouette-first, so keeping only
  // the head of the array on low quality drops secondary detail (masts,
  // gantry rings, wheels, barrels) while the shape that actually reads as
  // "this thing has a shadow" stays.
  world.scene.traverse((obj) => {
    const casters = obj.userData?.shadowCasters;
    if (!casters) return;
    const keep = high ? casters.length : 1;
    casters.forEach((mesh, i) => {
      mesh.castShadow = i < keep;
    });
  });
}
applyShadowQuality(shadowQuality.high);
perfHud.setDeviceLine(
  `mobile=${IS_MOBILE} aa=${!IS_MOBILE} px=${renderer.getPixelRatio()} shadows=${shadowQuality.high ? 'soft/2048' : 'basic/1024'}`
);

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
// The scene's only vehicle headlights — four, shared, re-parented to whoever the
// player is driving. Vehicles used to carry their own; at 20 vehicles that was 80
// spotlights and 705ms of a 710ms frame. See headlightPool.js.
const headlightPool = new HeadlightPool(world.scene);
window.__headlightPool = headlightPool; // console access, same convention as window.__tickProfiler

const terraform = new Terraform(world);
// Permanent terrain damage. Simulation state — it changes ground height, and
// therefore line of sight, wheel grounding and pathing — so it is recorded and
// replayed rather than left to the renderer. See core/craters.js.
const craters = new Craters(world);
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
  // Most browsers (iOS Safari strictly) refuse to produce sound until a real
  // user gesture resumes the AudioContext. This is that gesture — the first
  // press on the canvas, whatever it turns out to mean for the game itself.
  // Cheap to call every press: resume() is a no-op once already running.
  audio.resume();
  // Speech needs the same user activation the AudioContext does, and Chrome's
  // getVoices() is async and returns [] until its list has loaded — so this
  // rides the identical gesture rather than adding a second hook of its own.
  radio.primeSpeech();
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
      // Validity is checked here so the click feels immediate and an invalid
      // spot stays in placement mode; the placement itself is queued, and
      // re-validated on apply in case the ground was taken meanwhile.
      if (structures.canPlaceAt(pad, def, snapped.x, snapped.z)) {
        submitIntent(Intent.build(def.id, pad.id, snapped.x, snapped.z, pad.teamId ?? game.localTeamId));
        audio.playAt('uiConfirm', snapped.x, heightmap.heightAt(snapped.x, snapped.z) + 1, snapped.z, null, 0.6);
        cancelPlacementMode();
      } else {
        audio.playAt('uiRefused', snapped.x, heightmap.heightAt(snapped.x, snapped.z) + 1, snapped.z, null, 0.6);
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
      const { harvester } = commandContext.harvestSelectMode;
      // requireOnField so a click on bare ground finds nothing, rather than
      // quietly sending the harvester to whichever field is nearest the miss.
      // A field blocked for the harvester's own team is excluded the same
      // way: applyIntent's 'harvest' case would refuse the order anyway, and
      // catching it here means the player sees the click miss instead of
      // watching the marker appear and then nothing happen.
      const field = world.blooms.nearestTo(point.x, point.z, {
        minStock: 0,
        requireOnField: true,
        reject: (f) => f.blockedByTeam?.has(harvester.teamId),
      });
      if (field) {
        // The harvester this mode was opened for can have been destroyed
        // while the player was still aiming the click.
        if (!harvester.dead) {
          submitIntent(Intent.harvest(harvester.id, field.id));
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

  // Handle sustained-fire target selection mode
  if (commandContext.targetSelectMode) {
    const { unit } = commandContext.targetSelectMode;
    const hit = pickSelectable(e.clientX, e.clientY);
    // A miss, a friendly, or the unit's own self cancels the mode without
    // ordering anything — same "invalid click has no other effect" shape as
    // harvest targeting, just filtered to "a live enemy" instead of "a field".
    if (unit && !unit.dead && hit && hit !== unit && !hit.dead && hit.teamId !== unit.teamId) {
      submitIntent(Intent.target(unit.id, hit.id, hit.kind ?? 'vehicle'));
    }
    commandContext.targetSelectMode = null;
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
  // setTarget is the authority on whether the order is legal (it refuses
  // water), so ask it before queueing — the ball has to mark an order that was
  // actually accepted, not one that will be silently dropped on apply.
  if (vehicles.active && !vehicles.active.dead &&
      vehicles.active.canTarget(point.x, point.z, heightmap)) {
    submitIntent(Intent.move(vehicles.active.id, point.x, point.z));
    showMarker(point);
  } else marker.visible = false;
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
  let instance = pickSelectable(clientX, clientY);

  if (instance) {
    // On touch, the first tap of a double-tap can already have issued a move
    // order through pointerup before this ever runs (the native dblclick path
    // only, since the manual detector suppresses it up front). Double-tapping
    // a vehicle means "command this one", not "drive it to the ground behind
    // it" — so take that order back. A building has no order to cancel.
    if (input.tapToMove) {
      instance.arrive?.('cancelled');
      marker.visible = false;
    }
    radialMenu.openFor(instance, commandsFor(instance, commandContext), clearanceSubtitle(instance));
    audio.playAt('uiConfirm', instance.group.position.x, instance.group.position.y + 2, instance.group.position.z, null, 0.5);
    return;
  }

  // No vehicle or structure under the click — try a crystal field, using the
  // same ground-pick-then-nearestTo path harvestSelectMode already uses to
  // aim a manual harvest order, so a click on bare ground finds nothing here
  // either rather than snapping to whatever field is nearest the miss.
  const point = pickTerrain(clientX, clientY, canvas, camera, heightmap, hit);
  if (!point) return;
  const field = world.blooms.nearestTo(point.x, point.z, { minStock: 0, requireOnField: true });
  if (!field) return;

  instance = fieldMenuTarget(field);
  radialMenu.openFor(instance, fieldCommands(field, game.localTeamId), '');
  audio.playAt('uiConfirm', field.x, heightmap.heightAt(field.x, field.z) + 2, field.z, null, 0.5);
}

/**
 * A crystal field wrapped just enough to satisfy RadialMenu.openFor's
 * contract (`def.name`, `group.position`, `menuAnchorHeight`, `speed`,
 * `menuOpen`). Fields are InstancedMesh slices with none of those on the
 * field record itself, and building a real per-field object for something
 * that never moves and is opened rarely is not worth a second entity system.
 */
function fieldMenuTarget(field) {
  return {
    kind: 'field',
    id: field.id,
    def: { name: 'Crystal Field' },
    group: { position: new THREE.Vector3(field.x, heightmap.heightAt(field.x, field.z) + 2, field.z) },
    menuAnchorHeight: 0,
    speed: 0, // stationary — never trips radialMenu's drove-away auto-close
    menuOpen: false,
    // Live, not captured at open time: a base pad poured over this field
    // while the menu is open must still close it, the same as any other
    // instance the menu was opened on being destroyed out from under it.
    get dead() {
      return field.dead;
    },
  };
}

/** The field's radial menu: a single toggle, scoped to the acting team. */
function fieldCommands(field, teamId) {
  const blocked = field.blockedByTeam?.has(teamId);
  return [
    {
      id: blocked ? 'unblock' : 'block',
      label: blocked ? 'Allow harvesters' : 'Block harvesters',
      hint: blocked
        ? 'Your harvesters may work this field again'
        : 'Your harvesters will avoid this field',
      blocked: !blocked,
    },
  ];
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
  if (k in driveKeys && !isTextInputFocused() && !overlayOpen) {
    driveKeys[k] = true;
    // Drive state is latched on the vehicle and only sent when it changes, so
    // a key going down has to emit here. Without this nothing ever applies
    // throttle at all — the per-tick polling it replaced is gone.
    syncDriveIntent();
  }
  if (e.key === 'Escape' && commandContext.buildPlacementMode) cancelPlacementMode();
  if (e.key === 'Escape' && commandContext.targetSelectMode) commandContext.targetSelectMode = null;
  // Debug: destroy whatever's under the cursor. This writes simulation state
  // directly — `queueDestroy` marks the instance dead synchronously — which
  // is exactly what CLAUDE.md says has silently desynced matches before, so
  // it is gated to local play. Press it online and only your client would
  // lose the unit; the peer keeps simulating it, and there is no recovery
  // from that.
  //
  // It is not routed through an intent instead because it should not be a
  // player action at all: it exists so the destroy pipeline can be triggered
  // by hand, and combat now triggers it constantly, so the original reason
  // for it ("combat is 2D, this is its only way to run") no longer holds.
  if (k === 'k' && !isTextInputFocused() && !overlayOpen && game.mode !== 'multiplayer-online') {
    const target = pickSelectable(lastX, lastY);
    if (target) entities.queueDestroy(target);
  }
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in driveKeys) {
    driveKeys[k] = false;
    syncDriveIntent();
  }
});
// Keys held while the window loses focus would otherwise stick down.
addEventListener('blur', () => {
  for (const k in driveKeys) driveKeys[k] = false;
  syncDriveIntent();
});

function isTextInputFocused() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

/**
 * The local player's intent queue.
 *
 * Single player drains this straight into the sim at the top of the next step.
 * A networked match will instead hand each batch to the lockstep session, which
 * stamps it with a turn and sends it — so the producers above never need to
 * know which mode they are in, and the local path is the same code that runs
 * online rather than a separate one that only gets exercised in multiplayer.
 */
const intentQueue = new IntentQueue();

function submitIntent(intent) {
  intentQueue.push(intent);
}

function drainIntents() {
  // In a match the queue belongs to the lockstep session, which drains it when
  // it sends. Applying locally as well would execute every order twice on the
  // issuing client and once everywhere else.
  //
  // Keyed on the *mode*, not just on `match` being live. A dropped connection
  // nulls `match` while leaving the mode alone, and testing only the object
  // meant a disconnected client silently promoted itself to authoritative local
  // play: it applied its own orders with `teamId = null`, which switches the
  // ownership check off entirely (see intents.js) and hands the player command
  // of *both* teams' units in what is still nominally a networked match.
  if (match || game.mode === 'multiplayer-online') return;
  const batch = intentQueue.drain();
  if (!batch.length) return;
  // Local play passes teamId null: there is one human team, and the ownership
  // check exists to stop a *remote* client ordering somebody else's units.
  for (const intent of batch) applyIntent(intent, commandContext, null);
}

/**
 * Emit a drive intent, but only when the driving actually changed.
 *
 * Drive state is latched on the vehicle rather than re-sent every step, so
 * holding W is two intents (press, release) instead of sixty a second. That is
 * what keeps the wire cost of continuous input negligible, and it is why the
 * *change* has to be detected here rather than at the key handler alone — the
 * player switching vehicle changes who is being driven without any key moving.
 */
let lastDrive = { instanceId: null, throttle: 0, steer: 0 };

function syncDriveIntent() {
  const active = vehicles.active;
  const id = active && !active.dead ? active.id : null;
  const throttle = (driveKeys.w ? 1 : 0) - (driveKeys.s ? 1 : 0);
  const steer = (driveKeys.d ? 1 : 0) - (driveKeys.a ? 1 : 0);
  if (id === lastDrive.instanceId && throttle === lastDrive.throttle && steer === lastDrive.steer) {
    return;
  }
  lastDrive = { instanceId: id, throttle, steer };
  // setActive already zeroes the vehicle being left behind, so a handover only
  // needs the incoming vehicle told what the keys are currently doing.
  if (id !== null) submitIntent(Intent.drive(id, throttle, steer));
}

/**
 * Lamps follow the sun, so dusk, night and dawn all light up without the
 * player touching anything. The manual override is for inspecting the beam.
 */
// floodHeadlights is a testing-only switch that gives *every* vehicle real
// beams — deliberately the expensive shape the headlight pool exists to avoid.
// Off by default, never persisted; see HeadlightPool.setFlood().
//
// forceHeadlights defaults on for mobile: on a small/dim screen the active
// vehicle's beam is worth having lit even before headlightsWanted()'s own
// dusk check would turn it on, and — unlike floodHeadlights — this only ever
// touches the single light already attached to vehicles.active, not the
// re-link-triggering light *count* HeadlightPool's header warns about.
const lighting = { forceHeadlights: IS_MOBILE, floodHeadlights: false };
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
    // Shells in flight are aimed at points on a heightfield that no longer
    // exists — they would land in mid-air or inside a new hill.
    projectiles.clear();
    projectileFx.clear();
    // The craters recorded holes in a heightfield that has just been thrown
    // away; replaying them onto the new one would dig them in the wrong places.
    craters.clear();
    // And the coins were hovering over ground that has moved.
    bounties.clear();
    bountyFx.clear();
    // Buildings stand on the old heightfield, and harvesters hold references to
    // fields that no longer exist.
    structures.clear();
    facilityControl.reset();
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
  /**
   * The player explicitly picked a vehicle from the drawer — take the camera
   * there regardless of what it was doing a moment ago. Without this, a
   * minimap click (which deliberately drops `chase.enabled` to hand the view
   * to free MapControls) left every vehicle-picker selection silently doing
   * nothing to the camera: `setActive` alone never touched it, and the one
   * call site that did (`chase.reset`) only fired `if (chase.enabled)`, which
   * is exactly the flag the minimap had just turned off.
   */
  focusVehicle(instance) {
    if (!instance) return null;
    vehicles.setActive(instance);
    view.setChase(true); // re-enables chase and recenters — see setChase above
    return instance;
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
  matchEndScreen: null,
  // teamId -> the display name of the player holding that seat. Online only,
  // and read by exactly one thing: the Statistics screen. Team.name itself is
  // deliberately left alone, so the minimap, HUD and radial menu keep showing
  // what they always showed rather than a player-controlled string.
  playerNames: {},
  // Latched once a result is decided, so the end screen is shown exactly once
  // and the world stops being driven behind it.
  matchOver: false,
  // Sandbox is a one-team match, so this is never empty and nothing has to
  // special-case "no teams". Rebuilt by beginMatch once the mode is known.
  teams: createTeams(0),
  /**
   * Which team this client drives.
   *
   * Always 0 in sandbox and against AI, but online the server assigns a seat —
   * the second player into a lobby is team 1, and everything that used to
   * assume "the human is team 0" has to ask this instead.
   */
  localTeamId: PLAYER_TEAM_ID,
  get playerTeam() {
    return this.teams[this.localTeamId] ?? this.teams[PLAYER_TEAM_ID];
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
    return this.teams[entity?.teamId ?? this.localTeamId] ?? this.playerTeam;
  },
  /** The fog mask a team reveals into. */
  fogFor(teamId) {
    return this.teams[teamId ?? this.localTeamId]?.fog ?? this.playerTeam.fog;
  },
  /**
   * The full world state — terrain params, pads, teams, every vehicle and
   * structure, fog, and the cross-references between them. See
   * core/snapshot.js for what is stored versus recomputed.
   */
  snapshot() {
    return serialize(snapshotContext());
  },

  /**
   * Save locally. Works signed out and with no backend at all, which is the
   * whole point: cloud saves are an addition to this, not a replacement.
   */
  saveGame(slot = 'default') {
    const snap = this.snapshot();
    localStorage.setItem(`ptg-save:${slot}`, JSON.stringify(snap));
    return snap;
  },

  /** Every local save's slot name, for the Save/Load field's autocomplete. */
  listLocalSaves() {
    const prefix = 'ptg-save:';
    const names = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) names.push(key.slice(prefix.length));
    }
    return names.sort((a, b) => a.localeCompare(b));
  },

  /** Used by autosave's pruning; not exposed in the Save/Load field itself. */
  deleteLocalSave(slot) {
    localStorage.removeItem(`ptg-save:${slot}`);
  },

  /** The exact stored JSON for a slot, or null — backs the Save/Load field's
   * export. Kept here so the `ptg-save:` key prefix lives in one place. */
  rawLocalSave(slot) {
    return localStorage.getItem(`ptg-save:${slot}`);
  },

  loadGame(slot = 'default') {
    const raw = localStorage.getItem(`ptg-save:${slot}`);
    if (!raw) return null;
    return this.applySnapshot(JSON.parse(raw));
  },

  /** Rebuild the world from a snapshot, from any source (local or cloud). */
  applySnapshot(snap) {
    const result = deserialize(snapshotContext(), snap);
    // The nav grid caches flow fields against the old heightfield, and the
    // menu shows per-team credits that have just been replaced wholesale.
    heightmap.terrainVersion++;
    menu.rebuild();
    return result;
  },

  /** Cloud save under the signed-in account. Requires game.account. */
  async saveToCloud(name) {
    const snap = this.snapshot();
    return api.putSave(name, snap.mode, snap.schemaVersion, snap);
  },

  listCloudSaves() {
    return api.listSaves();
  },

  async loadFromCloud(id) {
    const { payload } = await api.getSave(id);
    return this.applySnapshot(payload);
  },
  // docs/performance-optimization-plan.md Phase 2 — read/written by the
  // settings drawer's "Performance" group (controlSchema.js).
  shadowQuality,
  setShadowQuality(high) {
    shadowQuality.userForced = true;
    applyShadowQuality(high);
  },
  version: __APP_VERSION__,
  buildTime: __BUILD_TIME__,
};

// The drawer's second page. Passed in rather than built inside Menu because it
// reads live simulation collections, which the schema-driven control list has
// no business knowing about.
/**
 * The team radio. Presentation only — it observes the sim and writes nothing,
 * which is why it is constructed here rather than owned by anything simulated.
 * See audio/chatter.js on why it never hooks a sim callback.
 */
/** How close a danger zone has to be to home before it is "base under attack"
 * rather than a skirmish somewhere on the island. Roughly the base block's own
 * footprint plus a margin. */
const BASE_ALERT_RADIUS = 70;

const chatter = new Chatter({ onCaption: (line) => pushRadioLine(line) });

const statisticsScreen = new StatisticsScreen({ game, vehicles, structures });
const menu = new Menu(() => buildSchema(world, view, game), statisticsScreen);

const hud = new Hud();

/**
 * Bottom-right minimap. Presentation only — a click moves the camera, which
 * is not simulated, so this needs no intent (see renderTick's header).
 */
const minimap = new Minimap({
  onJump(x, z) {
    // Setting controls.target alone would silently do nothing while the chase
    // rig is active: renderTick forces controls.enabled = false every frame
    // whenever isChasing(). So hand the camera back the same way setChase does.
    chase.enabled = false;
    controls.enabled = true;
    controls.target.set(x, heightmap.heightAt(x, z), z);
    controls.update();
  },
});

/**
 * A box on the ground showing roughly where the camera is looking.
 *
 * Deliberately an approximation rather than the true frustum footprint, after
 * two attempts at exactness both failed for the same reason: with the camera
 * angled the way an RTS view is, the upper screen corners look at or above the
 * horizon and have no ground intersection at all. Raymarching the terrain
 * returned nothing there, so the rectangle never drew; intersecting a ground
 * plane pushed those corners to the map edge, so it drew as a diagonal streak
 * across the whole map. The visible ground in that direction really is
 * unbounded — there is no honest quad to draw.
 *
 * So this is a square centred on what the camera is pointed at, sized from its
 * distance and field of view. It answers the question the minimap is actually
 * asked ("where am I looking?") and cannot degenerate.
 */
function cameraGroundQuad() {
  const t = controls.target;
  const dist = camera.position.distanceTo(t);
  if (!Number.isFinite(dist) || dist <= 0) return null;
  // Half-width of the ground the camera covers at that distance. Widened a
  // little because a tilted view sees further than a head-on one.
  const half = dist * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.25;
  return [
    { x: t.x - half, z: t.z - half },
    { x: t.x + half, z: t.z - half },
    { x: t.x + half, z: t.z + half },
    { x: t.x - half, z: t.z + half },
  ];
}

/**
 * Every radial-menu command in the game funnels through here, which is what
 * makes routing them through the intent queue a two-line change rather than a
 * rewrite: a command is fully described by its id plus the instance it was
 * opened on, so it serialises without touching the command table itself.
 */
const radialMenu = new RadialMenu(camera, {
  /**
   * A menu opened or closed on a unit. `menuOpen` is read by the autonomous
   * drivers, so this is simulation state and goes through the intent stream
   * like every other player action — not written onto the instance from the
   * DOM handler, which held the unit on this client only.
   *
   * The crystal-field wrapper (`fieldMenuTarget`) is skipped: it is a
   * throwaway object built per open, it has no presence in the simulation,
   * and there is nothing about a field that can be held still.
   */
  onHold(instance, held) {
    if (!instance || instance.kind === 'field') return;
    submitIntent(Intent.menuHold(instance.id, instance.kind, held));
  },
  onCommand(cmd, instance) {
    // Commands that only put *this* client into a UI mode ("now click a
    // target", "now click where to build") never travel as intents —
    // applyIntent runs execute() on every peer, so submitting one put
    // everybody into the mode. See commands.js's `local: true`.
    if (cmd.local) {
      cmd.execute?.(instance, commandContext);
      return;
    }
    if (instance.kind === 'field') {
      submitIntent(Intent.blockField(instance.id, game.localTeamId, cmd.blocked));
      const p = instance.group.position;
      // cmd.blocked is the *new* state the click is about to set — a distinct
      // confirm/cancel pair for turning avoidance on vs. off, same shape as
      // any other toggle in the game.
      audio.playAt(cmd.blocked ? 'uiConfirm' : 'uiCancel', p.x, p.y, p.z, null, 0.6);
      return;
    }
    submitIntent(Intent.command(instance.id, instance.kind, cmd.id));
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
  // The single choke point every produced unit passes through, so the match
  // record is counted once here rather than at each of the call sites that
  // can order one.
  game.teamOf(facility).stats.unitsBuilt++;

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
  // Fires once per finished building whoever placed it — the structure
  // equivalent of produceUnit's single choke point.
  game.teamOf(instance).stats.structuresBuilt++;
  audio.playAt('structureComplete', instance.x, heightmap.heightAt(instance.x, instance.z) + 2, instance.z);
  if (!instance.def.freeUnitOnComplete) return;
  // produces[0] by convention — the economy unit. A facility must never
  // bootstrap a team with a free combat vehicle.
  produceUnit(vehicles.defOf(instance.def.produces[0]), instance);
};

// ---- combat visuals: projectiles and wreckage ----

// Shell visuals — the flying shell, its ground shadow/glow, the muzzle flash
// and the impact. Pooled, and entirely presentational: it reads the sim's
// projectile array and never writes to it. See render/projectileFx.js.
const projectileFx = new ProjectileFx(world.scene, heightmap, game);

/**
 * The heavy-tracked-tank's flare.
 *
 * Kept as its own tiny cosmetic list rather than going through the projectile
 * simulation, because a flare is not a shot: it deals no damage, hits nothing,
 * decides no hit-or-miss, and must not appear in a lockstep state hash. It is
 * a light that rises and hangs, so it is drawn like one.
 */
const FLARE_POOL_SIZE = 4;
const flares = [];
for (let i = 0; i < FLARE_POOL_SIZE; i++) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff2a8,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  world.scene.add(mesh);
  flares.push({ mesh, mat, from: new THREE.Vector3(), to: new THREE.Vector3(), elapsed: 0, duration: 0, active: false });
}
let nextFlare = 0;

const FLARE_SPEED = 60; // units/second, slow enough to read as rising
const FLARE_HANG = 2.5; // seconds it burns at the top before fading

function showFlare(instance, target) {
  const f = flares[nextFlare];
  nextFlare = (nextFlare + 1) % FLARE_POOL_SIZE;
  const pos = instance.group.position;
  f.from.set(pos.x, heightmap.heightAt(pos.x, pos.z) + 3, pos.z);
  f.to.set(target.x, heightmap.heightAt(target.x, target.z) + 140, target.z);
  f.duration = Math.max(1e-3, f.from.distanceTo(f.to) / FLARE_SPEED);
  f.elapsed = 0;
  f.active = true;
  f.mat.opacity = 1;
  f.mesh.position.copy(f.from);
  f.mesh.visible = true;
}

function updateFlares(dt) {
  for (const f of flares) {
    if (!f.active) continue;
    f.elapsed += dt;
    if (f.elapsed < f.duration) {
      f.mesh.position.lerpVectors(f.from, f.to, f.elapsed / f.duration);
      continue;
    }
    // At the top: hang and burn out.
    f.mesh.position.copy(f.to);
    const hang = (f.elapsed - f.duration) / FLARE_HANG;
    f.mat.opacity = Math.max(0, 1 - hang);
    if (hang >= 1) {
      f.active = false;
      f.mesh.visible = false;
    }
  }
}

/**
 * A shot was fired. Muzzle flash only — the shell itself is a simulated
 * entity now and draws itself from the projectile array every frame, so
 * unlike the old cosmetic tracer this hook has nothing to animate.
 */
function showMuzzleFlash(from, to, teamId, fromHeight, toHeight, turretDef) {
  const color = turretDef?.projectileColor ?? game.teams[teamId]?.color ?? 0xffffff;
  // Nudged toward the target so the flash sits at the barrel rather than in
  // the middle of the hull.
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz) || 1;
  const x = from.x + (dx / d) * 1.6;
  const z = from.z + (dz / d) * 1.6;
  projectileFx.spawnMuzzleFlash(
    x,
    heightmap.heightAt(x, z) + fromHeight,
    z,
    color,
    turretDef?.damage
  );
  audio.playAt('weaponFire', x, heightmap.heightAt(x, z) + fromHeight, z, { calibre: turretDef?.damage });
}

/**
 * One engine loop per live, moving-capable vehicle. Entirely render-side: it
 * only reads `vehicles.instances` (never writes) and keys loops on vehicle
 * id, reaping any whose vehicle is no longer in that array — the same
 * liveness test the projectile/bounty render pools already use, just applied
 * to audio.js's own key set instead of a local one.
 *
 * `immobile` (vehicleController.js — true only while `mode === 'deploying'`)
 * is excluded: a base station mid-flatten has no speed to react to, and an
 * engine drone under a stationary deploy animation would just be noise.
 */
function updateEngineAudio(dt) {
  const live = new Set();
  for (const v of vehicles.instances) {
    if (v.dead || v.immobile) continue;
    live.add(v.id);
    // Heavier vehicles idle lower — the same weight number trackMask.js
    // already reads to decide how dark a track a vehicle leaves.
    const baseHz = THREE.MathUtils.clamp(260 - v.def.weight * 14, 55, 220);
    const speedFrac = v.def.speed > 0 ? Math.min(1, v.speed / v.def.speed) : 0;
    audio.updateEngineLoop(v.id, v.group, baseHz, speedFrac, dt, v.def.id);
  }
  for (const key of audio.activeLoopKeys()) {
    if (!live.has(key)) audio.stopEngineLoop(key);
  }
}

/**
 * A shell landed. The single seam between the simulation and everything that
 * happens as a consequence of an impact — explosion, light, debris, and (for
 * a ground hit) the crater and scorch mark.
 */
function handleImpact(impact) {
  projectileFx.spawnImpact(impact, world.atmosphere.params.elevation);
  // Same sqrt(damage/REFERENCE_DAMAGE) shape Craters.shapeFor uses to size a
  // crater, so the bang and the hole agree — see synth.js's explosion() header.
  const intensity = Math.sqrt(Math.max(0.2, (impact.damage ?? 20) / 20));
  audio.playAt(
    impact.ground ? 'explosionGround' : 'explosionHull',
    impact.x,
    impact.y,
    impact.z,
    { intensity }
  );
  if (!impact.ground) return;

  // Only a ground hit scars the ground. A shell that hit a hull spent itself
  // on armour; the wreck it leaves is `leaveWreckage`'s business.
  //
  // The crater is simulation state and the scorch is not, but they are sized
  // off the same shape so the burn always matches the hole it surrounds —
  // deriving the scorch radius independently is how the two drift apart.
  const tier = game.teams[impact.teamId]?.weaponTier ?? 0;
  const record = craters.dig(impact.x, impact.z, impact.damage, tier);
  const shape = record ?? Craters.shapeFor(impact.damage, tier);
  // Light weapons leave no crater but still blacken the ground, so the scorch
  // falls back to a small fixed radius rather than being skipped with it.
  const scorchRadius = shape ? shape.radius * 1.8 : 2.2;
  world.scorchMask.stamp(impact.x, impact.z, scorchRadius, shape ? 0.95 : 0.5);
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

// Built once and reused for the whole match — see navGrid.js's own header for
// why one coarse flow-field cache can serve an entire army, and now every
// harvester too. Moved up here (it used to live much further down, built
// after harvesterAI) specifically so harvesterAI can take it as a
// constructor dependency the same way aiCommander already does via
// commandContext, rather than reaching for a module-level binding that
// didn't exist yet at its own construction time.
const navGrid = new NavGrid(heightmap, structures);

// Ground control for every dock. Constructed before its two consumers because
// both take it as a dependency — it owns the claim bookkeeping they each used
// to keep their own copy of.
const facilityControl = new FacilityControl({ vehicles, structures, heightmap });
const harvesterAI = new HarvesterAI({
  vehicles, world, heightmap, structures, game, facilityControl, navGrid,
});
const repairController = new RepairController({
  vehicles, structures, heightmap, game, facilityControl,
});
const trafficController = new TrafficController({ vehicles });
// Shells in flight. Constructed before combatController because that is what
// hands shells to it — and after `entities`, since a shell's arrival is what
// queues a kill now.
const projectiles = new Projectiles({
  vehicles,
  structures,
  heightmap,
  entities,
  game,
  onImpact: handleImpact,
});
const combatController = new CombatController({
  vehicles,
  structures,
  heightmap,
  game,
  projectiles,
  onShot: showMuzzleFlash,
});

// Salvage coins. Simulation state (they are credits), with the coin mesh and
// the HUD flourish on the render side — see vehicles/bounty.js.
const bountyFx = new BountyFx(world.scene, heightmap);
const creditBurst = new CreditBurst(hud.creditsValue);
const bounties = new Bounties({
  vehicles,
  game,
  onCollected: handleBountyCollected,
});

/**
 * A coin was picked up. The credits are already in the team's account by the
 * time this runs — this only decides whether to make a fuss about it.
 */
function handleBountyCollected(coin, team, collector) {
  // Only the local player's own collections get the flourish. An AI hoovering
  // up coins across the map would otherwise spray the player's HUD with
  // credits it never received.
  if (team.id !== game.localTeamId) return;
  const anchor = collector.group.position;
  _burstAnchor.set(anchor.x, heightmap.heightAt(anchor.x, anchor.z) + 3, anchor.z);
  _burstAnchor.project(camera);
  // z > 1 is behind the camera, where the projected coordinates mirror into
  // nonsense — same guard radialMenu's `_reposition` uses.
  const screen =
    _burstAnchor.z > 1
      ? null
      : {
          x: (_burstAnchor.x * 0.5 + 0.5) * window.innerWidth,
          y: (-_burstAnchor.y * 0.5 + 0.5) * window.innerHeight,
        };
  creditBurst.play(coin.value, screen);
  audio.playAt('coinPickup', anchor.x, heightmap.heightAt(anchor.x, anchor.z) + 1, anchor.z);
}

/** Scratch vector for the projection above — allocating one per coin would
 * churn garbage in the middle of a fight. */
const _burstAnchor = new THREE.Vector3();

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
// The death sound, placed the same tick and for the same reason as the wreck
// above: the instance still knows where it was and how big it was.
entities.onDestroy((inst) => {
  const p = inst.x !== undefined ? { x: inst.x, z: inst.z } : inst.group.position;
  const scale = inst.kind === 'structure' ? 2.2 : Math.max(0.6, (inst.def.dims?.hullLength ?? 5) * 0.18);
  audio.playAt('destroyed', p.x, heightmap.heightAt(p.x, p.z) + 1, p.z, { scale });
});
// The salvage, dropped in the same breath and for the same reason: the
// instance still knows where it was and how many kills it had earned, and
// vehicles.remove() below takes both away.
entities.onDestroy((inst) => {
  const coin = bounties.drop(inst);
  if (coin) audio.playAt('coinSpawn', coin.x, heightmap.heightAt(coin.x, coin.z) + 2, coin.z);
});
// Match record. Counted here rather than at the kill site so *every* cause of
// death lands in the tally, not just weapons.
entities.onDestroy((inst) => {
  const stats = game.teamOf(inst)?.stats;
  if (!stats) return;
  if (inst.kind === 'structure') stats.structuresLost++;
  else stats.unitsLost++;
  // The one stat that genuinely needs capturing at destroy time rather than at
  // its increment site: the Statistics screen lists earnings *per harvester*,
  // and a per-unit list can only be appended to when a unit leaves. Live
  // harvesters are read straight off vehicles.instances instead, so this holds
  // exactly the ones that would otherwise vanish. Safe here because the
  // removal hook below runs last, so creditsDelivered is still readable.
  if (inst.kind === 'vehicle' && inst.def?.id === 'crystal-harvester') {
    stats.deadHarvesterEarnings.push(inst.creditsDelivered ?? 0);
  }
});
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

/**
 * Eliminate any team that has lost its base station, and end the match once
 * one side is left standing.
 *
 * Base-station-destroyed is the whole rule, and the base is a *mobile*
 * vehicle with a relocate command — so a losing team can genuinely drive its
 * base out of danger rather than watch it die. That falls out for free and is
 * worth keeping.
 *
 * Only runs for Multiplayer AI: sandbox has one team, and "you have no base"
 * is a normal state there (you start without one and earn it).
 */
function checkMatchEnd() {
  if (game.mode !== 'multiplayer-ai' || game.matchOver) return;

  for (const team of game.teams) {
    if (team.defeated) continue;
    const hasBase = vehicles.instances.some(
      (v) => !v.dead && v.teamId === team.id && v.def.id === 'base-station'
    );
    if (hasBase) continue;
    team.defeated = true;
    // A defeated team stops thinking. Its units are left where they are —
    // wreckage and stragglers are part of the record of the match.
    const commander = game.aiCommanders.find((c) => c.team.id === team.id);
    if (commander) commander.team.defeated = true;
  }

  const alive = game.teams.filter((t) => !t.defeated);
  // Not over while two or more are still standing.
  if (alive.length > 1) return;

  game.matchOver = true;
  const winner = alive[0] ?? null;
  const playerWon = !!winner?.isHuman;
  audio.playGlobal(playerWon ? 'victory' : 'defeat');
  game.matchEndScreen.show({
    playerWon,
    winner,
    teams: game.teams,
  });
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
// `entities` is here for the deployDefense intent, which consumes the vehicle
// it deploys from and must do so through the destroy pipeline rather than
// splicing an array another system may still be walking.
const commandContext = { vehicles, world, heightmap, terraform, structures, game, produceUnit, navGrid, entities, facilityControl, onFlare: showFlare };

/**
 * One line of ground-control status for the radial menu: how many vehicles are
 * holding for a facility, or where this vehicle stands in that queue. Empty
 * when neither applies, which is most of the time.
 */
function clearanceSubtitle(instance) {
  if (instance.kind === 'structure') {
    const waiting = facilityControl.queueDepth(instance);
    if (!waiting) return '';
    return waiting === 1 ? '1 vehicle holding' : `${waiting} vehicles holding`;
  }
  if (facilityControl.isStuck(instance)) return 'cannot reach dock';
  const status = facilityControl.statusOf(instance);
  if (status === CLEARED) return 'cleared to approach';
  if (status === DOCKED) return 'docked';
  if (status === HOLDING) return 'holding for clearance';
  return '';
}

/**
 * Everything core/snapshot.js needs to read or rebuild a world.
 *
 * A function rather than an object literal because `game.saveGame` is defined
 * above several of these bindings; resolving them at call time keeps the
 * declaration order of this file free of a dependency it does not otherwise
 * have.
 */
function snapshotContext() {
  return { world, heightmap, terraform, vehicles, structures, game, harvesterAI, projectiles, craters, bounties };
}

const vehiclePicker = new VehiclePicker(VEHICLE_CATALOG, {
  vehicles,
  playerTeamId: PLAYER_TEAM_ID,
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
    view.focusVehicle(instance);
  },
  // Clicking an already-Active card bypasses onSelect entirely (it calls
  // vehicles.setActive directly) — this is the camera side of that path.
  onFocus(instance) {
    view.focusVehicle(instance);
  },
});

// The settings menu and the vehicle drawer are two independently built
// components, neither aware the other exists. On a desktop-width window that
// is harmless — two 320px panels from opposite edges of a much wider screen
// never meet — but below the same ~720px width style.css shrinks the panels
// at, both open together cover most of the screen and overlap unreadably.
// Sandbox mode makes this the *default* state on a phone, since it opens the
// vehicle drawer automatically at start (see beginMatch). Below that width,
// opening one now closes the other; above it, both can stay open exactly as
// they always could, since nothing here changes desktop behaviour at all.
const NARROW_VIEWPORT = matchMedia('(max-width: 720px)');
menu.onOpen = () => { if (NARROW_VIEWPORT.matches) vehiclePicker.setOpen(false); };
vehiclePicker.onOpen = () => { if (NARROW_VIEWPORT.matches) menu.setOpen(false); };

vehiclePicker.lockText = (def) =>
  def.unlock === 'exploration'
    ? `Locked — chart ${Math.round(game.difficulty.unlockAt * 100)}% of the island`
    : 'Locked';

/** Latch the unlock once the island is charted enough. */
function updateProgression(explored) {
  if (game.unlocked || explored < game.difficulty.unlockAt) return;
  game.unlocked = true;
  // The picker's own catalog, not VEHICLE_CATALOG: it is the merged list
  // applyCustomCatalog() maintains, so an author-built vehicle set to unlock
  // by exploration is released here too rather than staying locked forever.
  for (const def of vehiclePicker.catalog) {
    if (def.unlock === 'exploration') vehiclePicker.setUnlocked(def.id, true);
  }
}

// ---------------------------------------------------------------------------
// Online match session
// ---------------------------------------------------------------------------

/** Turns between state-hash reports. 10 turns = ~1s at 10 turns/sec. */
const HASH_EVERY_TURNS = 10;
/**
 * How far ahead the host schedules a resync snapshot. It has to serialise at a
 * turn the diverged client has not reached yet — a snapshot of a turn already
 * simulated cannot be applied without replaying input the client has consumed
 * and the server will not resend.
 */
const RESYNC_LEAD_TURNS = 3;

/** The live match, or null in single player. */
let match = null;
/** Seconds since the last "waiting…" notice, so a stall explains itself once a second. */
let matchWaitTimer = 0;
/**
 * How many of those once-a-second notices a mid-match stall has run for.
 * The running quorum now waits for an absent peer indefinitely rather than
 * releasing without them (server/src/ws/match.js) — there is no timeout that
 * ejects the player automatically the way there used to be. A brief stall
 * (a lost packet, a moment of lag) is normal and should look like one; a long
 * one needs a way out attached, or the player is stuck with no recourse but to
 * close the tab. This is what tells the two apart.
 */
let matchStallSeconds = 0;
const MID_MATCH_STALL_ESCALATE_S = 5;

/**
 * Leave an online match, for any reason.
 *
 * A full reload, not a return to the portal in place. `matchEndScreen`
 * (below) already settled this question for "play again" and says why:
 * rebuilding a match in place means unwinding the world, the fleet, the fog
 * masks, the commanders and the destroy queue by hand, and any one of those
 * missed is a subtle cross-match bug. Returning to the portal without
 * reloading kept the old (still-populated) world sitting behind the portal
 * screen, and the lobby's own state (`LobbyScreen.current`) survived the trip
 * too — so clicking back into Multiplayer Online could re-enter the very match
 * just left and run `beginMatch` a second time on top of the old one, doubling
 * every vehicle on the board. A reload is the version of this fix that cannot
 * miss a subsystem, the same reasoning `matchEndScreen` already relied on.
 *
 * The reason is shown before the navigation actually happens (`sessionStorage`
 * survives a reload; a toast queued right before one does not), and read back
 * once on load — see the `pendingToast` handling near the bottom of this file.
 */
function endOnlineMatch(reason) {
  if (!match) return;
  match.client.close();
  if (reason) sessionStorage.setItem('pendingToast', reason);
  location.reload();
}

/**
 * Record who is holding which seat, for the Statistics screen.
 *
 * Fed from all three places the server describes the roster — `welcome` on
 * connect, `begin` when the match starts, and `playerJoined` for anyone who
 * arrives after. Purely additive: a name is never cleared when a player drops,
 * because their team's stats stay on the board and an anonymous row would be
 * worse than a name that has stepped away.
 *
 * @param {Array<{teamId: number, displayName: string}>|undefined} players
 */
function rememberPlayerNames(players) {
  for (const p of players ?? []) {
    if (p?.teamId == null || !p.displayName) continue;
    game.playerNames[p.teamId] = p.displayName;
  }
}

/**
 * Join a match and hand the simulation's clock to the lockstep session.
 *
 * Everything about the world is derived, not received: the seed comes from the
 * lobby row, terrain regenerates from it, and both clients deploy identical
 * starting forces because `deployStartingForces` is itself deterministic.
 *
 * Refuses to run while a match is already live. `beginMatch` (called below) is
 * purely additive — it spawns starting forces without clearing the world — so
 * a second call on top of a live match doubles every vehicle on the board.
 * `LobbyScreen` guards against calling this twice for its own reasons (see
 * `entered` there); this is the backstop for any other way it could be
 * reached twice, so the two defenses do not have to stay in sync by hand.
 */
async function startOnlineMatch(matchId, difficulty) {
  if (match) {
    console.error('startOnlineMatch called while a match is already live — ignoring.');
    return;
  }
  // Cleared per match rather than in beginMatch: the roster arrives with
  // `welcome`, which lands *before* beginMatch runs, so clearing there would
  // wipe the names this match just learned. Seats are reassigned every match,
  // so a stale entry would put the previous opponent's name on a new player.
  game.playerNames = {};
  const { match: info } = await api.getMatch(matchId);
  const client = new MatchClient(matchId, {
    // The server holds every client at the gate until the roster is complete;
    // reporting input before that is what used to deadlock the match.
    onBegin: (msg) => {
      // Reconciled here as well as at connect: `begin` carries the final
      // roster, which is the first point a client that joined early knows who
      // else ended up in the match.
      rememberPlayerNames(msg.players);
      if (!match || match.begun) return;
      match.begun = true;
      if (msg.resuming) {
        // Rejoining a match already in progress. Pick up at the first turn the
        // server has not released rather than at turn 0 — the turns before it
        // are gone, and asking for them is what used to leave a late client
        // waiting on broadcasts that had already happened.
        match.session.resumeAt(match.releasedTurn + 1);
        showToast('Rejoining the match — resynchronising…', 4000);
      } else {
        match.session.start();
        showToast('All players connected — match starting.', 4000);
      }
    },
    onWaiting: (msg) => {
      if (!match) return;
      // Repeats every few seconds while the roster is short. The match will
      // never begin on its own from here, so this has to be actionable rather
      // than reassuring.
      match.waitingFor = msg;
    },
    onResyncNeeded: (msg) => scheduleResync(msg.users ?? []),
    onTurn: (turn, inputs) => match?.session.receiveTurn(turn, inputs),
    onAgreed: (msg) => {
      if (!match) return;
      match.agreedTurn = msg.turn;
      match.agreedPeers = msg.peers;
      // A later verified agreement supersedes an earlier disagreement: the
      // resync worked, or the drift was transient.
      if (match.desyncTurn != null && msg.turn > match.desyncTurn) match.desyncTurn = null;
    },
    onDesync: (msg) => {
      // The server's comparison is the authority on agreement; every client
      // shows it, while only the host acts on it.
      if (match) match.desyncTurn = msg.turn;
      handleDesync(msg);
    },
    onSnapshot: (msg) => {
      // Buffered, not applied here: it has to land exactly at its turn
      // boundary, which is the one moment both machines agree on.
      if (match) match.pendingSnapshot = msg;
    },
    // The server has always sent this; nothing read it until the Statistics
    // screen needed a name for each seat. Deliberately no toast — the arrival
    // is already visible in the lobby, and onPlayerLeft below toasts because a
    // *departure* pauses the match, which is a different kind of news.
    onPlayerJoined: (msg) => {
      rememberPlayerNames([msg]);
    },
    onPlayerLeft: (msg) => {
      // Their team is not handed to an AI commander — that would be a sensible
      // follow-up but is not implemented. The match pauses on them instead (see
      // server/src/ws/match.js's roster-based quorum) until they reconnect or
      // somebody still present chooses to leave.
      showToast(
        `${msg.teamId === game.localTeamId ? 'You' : 'A player'} left the match — ` +
          'waiting for them to reconnect.',
        4000
      );
    },
    onError: (msg) => {
      if (msg.error !== 'turn_already_released') return;
      // This session's clock cannot be reconciled with the server's: it asked
      // to report a turn already broadcast, which means it fell far enough
      // behind (or jumped far enough ahead, via a stale rejoin) that the normal
      // resync machinery — anchored to a turn still in the future — cannot
      // reach it. Continuing would silently re-stall on the same turn forever
      // and, since the quorum is now the whole roster, take every other player
      // down with it. Ending cleanly here is what makes that impossible.
      endOnlineMatch('Lost sync with the match and could not recover — please rejoin.');
    },
    onClose: () => endOnlineMatch('Disconnected from the match.'),
  });

  // A protocol version mismatch is rejected inside connect() itself — before
  // `welcome` can even resolve — so by the time this line returns, the two
  // peers are already known to agree. See matchClient.js's PROTOCOL_VERSION.
  const welcome = await client.connect();

  game.mode = 'multiplayer-online';
  game.localTeamId = welcome.teamId;
  rememberPlayerNames(welcome.players);

  // The match's vehicle set, pinned from the host's loadout when the lobby was
  // created and relayed identically to every peer. Every client validates the
  // same received bytes with the same deterministic checker, so every client
  // reaches the same verdict — and a def that fails ends the match here rather
  // than being skipped, because skipping is precisely how a peer ends up
  // simulating a different fleet from everyone else. The server has already
  // bounds-checked these; anything failing now is a build mismatch, and a loud
  // stop is the honest answer to that.
  const matchDefs = Array.isArray(welcome.customDefs) ? welcome.customDefs : [];
  for (const def of matchDefs) {
    const problems = validateDef(def, { catalog: VEHICLE_CATALOG });
    if (problems.length) {
      // Not endOnlineMatch(): `match` is not assigned until further down, and
      // that helper no-ops without it. Same effect, done directly.
      client.close();
      sessionStorage.setItem(
        'pendingToast',
        `This match uses a vehicle this build cannot load ("${def?.name ?? 'unnamed'}": ${problems[0]}).`
      );
      location.reload();
      return;
    }
  }
  game.matchDefs = matchDefs;
  // Team count comes from the lobby row rather than from who happens to be
  // connected: a client that joins the socket late must still build the same
  // number of teams as everyone else, or it diverges before it starts.
  const totalTeams = info.maxPlayers + info.aiCount;
  game.aiMatch = { teamCount: totalTeams - 1, buildDelaySeconds: 5 };

  // Same island for everyone, from the seed the lobby fixed at creation.
  // Defaults plus the shared seed — deliberately NOT this client's current
  // params. Spreading `heightmap.params` here meant the island was built from
  // whatever world sliders each player happened to have set locally, so two
  // clients could generate entirely different terrain from the same seed. Every
  // spawn point is derived from the heightmap, so that diverges the match from
  // its first tick: each player sees their own island with the other team's
  // vehicles at coordinates that mean nothing on it (a base station left
  // hovering over the wrong ground is the classic tell).
  world.regenerate({ ...DEFAULT_TERRAIN, seed: welcome.seed });
  beginMatch(difficulty);
  // Human seats are the low team ids (join hands out the lowest free one), so
  // this split is the same on every client without needing to be communicated.
  for (const team of game.teams) team.isHuman = team.id < info.maxPlayers;
  game.aiCommanders = game.aiCommanders.filter((c) => !c.team.isHuman);

  const session = new LockstepSession({
    ticksPerTurn: welcome.ticksPerTurn,
    inputDelayTurns: welcome.inputDelayTurns,
    queue: intentQueue,
    send: (turn, inputs) => client.sendInput(turn, inputs),
    onTurn: (inputs, turn) => onMatchTurn(inputs, turn),
  });

  match = {
    client,
    session,
    isHost: welcome.isHost,
    userId: welcome.userId,
    expectedPlayers: welcome.expectedPlayers,
    /**
     * How far the match had already got when this client connected. -1 for a
     * fresh match; anything higher means we are rejoining one in progress and
     * must resume from there rather than from turn 0.
     */
    releasedTurn: welcome.releasedTurn ?? -1,
    /** Flipped by the server's `begin`; until then the sim does not advance. */
    begun: false,
    /** Set by the server's `waiting` frame while the roster is short. */
    waitingFor: null,
    /** Last turn-aligned state digest, shown in the sync readout. */
    checkpoint: null,
    /** Turn the server last reported clients disagreeing, or null. */
    desyncTurn: null,
    /** Last turn the server actually COMPARED and found agreement. */
    agreedTurn: null,
    /** How many clients that comparison covered. */
    agreedPeers: 0,
    /** Set by the host when it owes somebody a snapshot. */
    resyncAtTurn: null,
    resyncTargets: [],
    pendingSnapshot: null,
  };
  // Deliberately no session.start() here — see the onBegin handler above. A
  // client that starts reporting on connect races every other client to the
  // turn clock, and the loser can never catch up.
  // A server predating the start barrier never sends `begin`, and this client
  // will not simulate without it — so the match would hang in silence forever.
  // `expectedPlayers` is the marker for that build, so say so plainly rather
  // than letting two players stare at a motionless world.
  if (welcome.expectedPlayers === undefined) {
    showToast(
      'The game server is out of date and will never start this match — ' +
      'redeploy the API, then try again.',
      15000
    );
    console.error(
      'match server predates the lockstep start barrier (no expectedPlayers in ' +
      'welcome); it will never broadcast "begin" and this client will not ' +
      'simulate without it. Redeploy server/.'
    );
  } else {
    showToast(
      `Joined as team ${welcome.teamId} — waiting for ${welcome.expectedPlayers} players…`,
      5000
    );
  }
  return welcome;
}

/**
 * The start of one turn: the single point where every client is provably at the
 * same simulated instant. Hashing, resync and input application all happen here
 * for exactly that reason.
 */
function onMatchTurn(inputs, turn) {
  // A snapshot scheduled for this turn replaces local state before anything
  // else touches it, so the turn's inputs then apply to the corrected world.
  if (match.pendingSnapshot?.turn === turn) {
    deserialize(snapshotContext(), match.pendingSnapshot.payload);
    match.pendingSnapshot = null;
    showToast('Resynchronised with the host.', 4000);
  }

  // Host side of the same handshake: serialise at the turn it promised.
  if (match.isHost && match.resyncAtTurn === turn) {
    const payload = serialize(snapshotContext());
    for (const userId of match.resyncTargets) match.client.sendSnapshot(userId, turn, payload);
    match.resyncAtTurn = null;
    match.resyncTargets = [];
  }

  if (turn % HASH_EVERY_TURNS === 0) {
    const hash = hashState({ vehicles, structures, game, projectiles, bounties, blooms: world.blooms, harvesterAI }, simClock.tick);
    // Kept as well as sent: the on-screen readout shows this turn-aligned
    // value so two devices are always comparing the same simulated moment.
    match.checkpoint = { turn, hash: hash.split(':')[1] ?? hash };
    match.client.sendHash(turn, hash);
  }

  // teamId is stamped by the server from the match roster, so this is the
  // ownership the applier enforces — not anything the sender claimed.
  for (const intent of inputs) applyIntent(intent, commandContext, intent.teamId);
}

/**
 * Somebody's simulation has drifted. Only the host acts: it schedules a
 * snapshot a few turns out and sends it to every client outside its own group.
 */
function handleDesync(msg) {
  if (!match?.isHost) return;
  const mine = msg.groups.find((g) => g.users.includes(match.userId));
  const targets = msg.groups.filter((g) => g !== mine).flatMap((g) => g.users);
  if (!targets.length) return;
  if (scheduleResync(targets)) {
    console.warn(`desync at turn ${msg.turn}; resyncing ${targets.length} client(s)`);
  }
}

/**
 * Host side of a resync: promise a snapshot at a turn far enough ahead that
 * every client can be at it when the snapshot lands.
 *
 * Two things ask for this — the server's desync comparison, and a player
 * rejoining a running match (whose world is stale or absent, which is the same
 * problem arriving by a different route). Both want identical handling, so they
 * share this rather than each scheduling their own.
 *
 * @returns {boolean} whether a resync was scheduled — false if one is already
 *   in flight, since a second would only overwrite the first's targets.
 */
function scheduleResync(targets) {
  if (!match?.isHost || match.resyncAtTurn !== null || !targets.length) return false;
  match.resyncAtTurn = match.session.turn + RESYNC_LEAD_TURNS;
  match.resyncTargets = targets;
  return true;
}

/**
 * Is this a multi-team match on a shared island (versus AI, versus people, or
 * both)? Those all open the same way — every team on the board at once — as
 * opposed to sandbox's explore-to-unlock pacing.
 */
function isSkirmish() {
  return game.mode === 'multiplayer-ai' || game.mode === 'multiplayer-online';
}

/** Shared by every mode's difficulty pick — only the difficulty source and
 * any per-mode extras (like the AI match config) differ. */
function beginMatch(difficulty) {
  game.difficulty = difficulty;
  game.matchOver = false;
  audio.playGlobal('matchStart');
  // Re-evaluated per match, not once at startup: `game.mode` is what decides
  // whether author-built vehicles are allowed, and it is only final by the
  // time a match actually begins. Online matches get the built-in catalog back
  // even if a sandbox session just added to it.
  applyCustomCatalog();
  applyCustomSounds();
  // A new match is a new net: drop any queued traffic, forget the observed
  // baseline (or the first tick would announce the starting units as newly
  // built), and stop a line still being spoken from the last match.
  chatter.reset();
  radio.cancelSpeech();
  clearRadioFeed();
  // A match is the unit of simulated time — tick 0 is its first step. Every
  // ban, threat memory and (later) lockstep turn number is relative to this.
  resetSimClock(0);
  // Shell ids restart with the match for the same reason the clock does: they
  // are only ever compared within one, and a save from a long session should
  // not carry ids into a fresh one.
  projectiles.clear();
  projectileFx.clear();
  resetProjectileIds();
  craters.clear();
  bounties.clear();
  bountyFx.clear();
  resetCoinIds();
  // Sandbox is a one-team match; Multiplayer AI adds one team per AI opponent.
  game.teams = createTeams(game.aiMatch?.teamCount ?? 0);

  // The player keeps the mask the world already built (the shaders point at
  // its texture and must not be re-pointed). Every AI team gets a CPU-only
  // one — they scout for themselves and nothing draws their view.
  // The rendered mask belongs to *this* client's team — online that may not be
  // team 0. Everyone else gets a CPU-only mask: they scout for themselves and
  // nothing draws their view.
  game.playerTeam.fog = world.fog;
  world.fogMasks.length = 1;
  for (const team of game.teams) {
    if (team === game.playerTeam) continue;
    team.fog = new FogMask(world.fogTerrain);
    world.fogMasks.push(team.fog);
  }
  vehiclePicker.playerTeamId = game.localTeamId;
  // The minimap is match-only. Built once here rather than waiting for the
  // half-second poll, so it is not blank for the first half second.
  minimap.root?.classList.remove('hidden');
  minimap.rebuildRaster(world.fogTerrain, game.playerTeam?.fog ?? world.fog);
  // Sandbox keeps the explore-to-unlock pacing untouched. An AI match starts
  // every team on equal footing — making the human scout first while AI
  // teams build from tick one would not be a fair opening.
  if (isSkirmish()) {
    game.unlocked = true;
    for (const def of vehiclePicker.catalog) {
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
  if (!isSkirmish()) vehiclePicker.setOpen(true);
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

    // findEdgeSpawnPointAtAngle already returns a heading pointing from the
    // coast back toward the island centre (`atan2(-dirZ, -dirX)`), so it is
    // used as-is. It previously had Math.PI added, borrowed from the vehicle
    // picker — but the picker spawns the base *beside another vehicle* via
    // findSpawnPointNear, which faces it back at that vehicle and does need
    // flipping. Applying the same flip here pointed every team out to sea.
    vehicles.spawn(baseDef, point, heading, { activate: false, teamId: team.id });

    const beside = findSpawnPointNear(heightmap, point, {
      minRadius: baseDef.dims.hullLength / 2 + scoutDef.dims.hullLength / 2 + 4,
      maxRadius: baseDef.sightRadius * 0.8,
      camera,
    });
    beside.point.y += 0.05;
    // `beside.heading` faces the scout back at the base it was placed next to,
    // which on a coastal spawn means facing the water as well. The whole team
    // should open facing the island it has to cross.
    vehicles.spawn(scoutDef, beside.point, heading, {
      // This client's own team, not "any human team". Online every player's
      // team is human, so activating on isHuman handed each client whichever
      // human scout spawned last — an enemy unit, whose orders the intent
      // applier then correctly refused.
      activate: team.id === game.localTeamId,
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

game.matchEndScreen = new MatchEndScreen(() => {
  // Simplest honest "play again": a full reload puts every system back to a
  // known-clean state. Rebuilding a match in place would mean unwinding the
  // world, the fleet, the fog masks, the commanders and the destroy queue
  // by hand, and any one of those missed is a subtle cross-match bug.
  location.reload();
});

// Accounts are optional and additive: `game.account` stays null when there's
// no API server configured, when the server is unreachable, or when the player
// simply hasn't signed in — and every one of those is a normal state the game
// plays fine in. Only cloud saves and online multiplayer consult it.
//
// Defined before portalScreen (which reads game.signIn/signOut/account via
// closures, so the order they're assigned in doesn't matter by the time a
// player actually clicks) so the portal's account corner has something real
// to call from the very first screen shown.
game.account = null;
game.authScreen = new AuthScreen((user) => {
  game.account = user;
  menu.rebuild();
  game.portalScreen?.refreshAccount();
});
game.signIn = () => game.authScreen.show();
game.signOut = async () => {
  try {
    await api.logout();
  } catch {
    // A failed logout request still means the player wants to be signed out
    // locally; the session expires server-side on its own.
  }
  game.account = null;
  menu.rebuild();
  game.portalScreen?.refreshAccount();
  // Another player's vehicles must not stay in the drawer after a sign-out.
  refreshCustomDefs();
  refreshCustomSounds();
};

game.lobbyScreen = new LobbyScreen({
  api,
  // The lobby hands back a match id once it is running; from here the world is
  // built entirely from the seed on that match row.
  onStart: (matchId) => {
    startOnlineMatch(matchId, DIFFICULTIES.find((d) => d.id === 'normal') ?? DIFFICULTIES[0])
      .catch((err) => {
        console.error('could not join match', err);
        showToast(`Could not join the match: ${err.message}`, 6000);
        game.portalScreen.buildGrid();
        game.portalScreen.open = true;
        game.portalScreen.root.classList.remove('hidden');
      });
  },
  onBack: () => {
    game.portalScreen.buildGrid();
    game.portalScreen.open = true;
    game.portalScreen.root.classList.remove('hidden');
  },
});

game.portalScreen = new PortalScreen(
  (modeId) => {
    if (modeId === 'sandbox') game.difficultyScreen.show();
    else if (modeId === 'multiplayer-ai') game.aiDifficultyScreen.show();
    else if (modeId === 'multiplayer-online') game.lobbyScreen.show();
  },
  {
    isConfigured: api.isConfigured,
    getAccount: () => game.account,
    onSignIn: () => game.signIn(),
    onSignOut: () => game.signOut(),
    onGodMode: (app) => (app === 'sound' ? game.openSoundCreator() : game.openBuilder()),
  }
);

/**
 * Author-built vehicles, loaded once per sign-in and kept here so
 * `applyCustomCatalog()` can re-apply them whenever the mode changes.
 */
game.customDefs = [];

/**
 * The vehicle set an online match supplied, from its `welcome` frame.
 *
 * Kept separate from `customDefs` on purpose: these are not this player's
 * vehicles, they are the match's, pinned from the host's loadout when the
 * lobby was created and relayed identically to every peer. Online play uses
 * this and ignores `customDefs` entirely — see catalogFor().
 */
game.matchDefs = [];

/**
 * Author-built sounds, and the set an online match supplied — kept apart for
 * exactly the reason `customDefs` and `matchDefs` are. A sound cannot desync a
 * match (audio is presentation-only), but a recipe is still instructions to
 * render a graph on every peer, so online takes its sounds from the match
 * rather than from whatever this machine happens to have. See soundCatalog.js.
 */
game.customRecipes = [];
game.matchRecipes = [];

/**
 * Point the picker and the vehicle controller at the catalog this mode is
 * allowed to see.
 *
 * `catalogFor` is the whole rule — allowlists in both directions, so anything
 * it does not recognise gets the built-in catalog only. Both consumers have to
 * be updated together: the picker decides what can be *chosen*, `defOf`
 * decides what an id can still *resolve to*, and a mismatch between them is a
 * vehicle that can be spawned but not restored, or listed but not built.
 */
function applyCustomCatalog() {
  const catalog = catalogFor(game.mode, game.customDefs, game.matchDefs);
  const extras = catalog.filter((d) => !VEHICLE_CATALOG.includes(d));
  vehicles.setExtraDefs(extras);
  vehiclePicker.setCatalog(catalog);
}

/**
 * Install the sounds this mode is allowed to play.
 *
 * Called from the same places `applyCustomCatalog()` is, and for the same
 * reason: the answer changes when the mode changes, and a stale answer here
 * means the wrong sound plays rather than the wrong vehicle spawning.
 */
function applyCustomSounds() {
  audio.setRecipes(soundCatalogFor(game.mode, game.customRecipes, game.matchRecipes));
}

/** Reload the signed-in author's sounds and make them available. */
async function refreshCustomSounds() {
  if (!api.isConfigured || !game.account) {
    game.customRecipes = [];
    applyCustomSounds();
    return;
  }
  try {
    const { recipes } = await loadCustomRecipes();
    game.customRecipes = recipes;
  } catch {
    // A sound editor that cannot reach the backend must not stop the game.
    game.customRecipes = [];
  }
  applyCustomSounds();
}

/** Reload the signed-in author's vehicles and make them available. */
async function refreshCustomDefs() {
  if (!api.isConfigured || !game.account) {
    game.customDefs = [];
    applyCustomCatalog();
    return;
  }
  try {
    const { defs } = await loadCustomDefs();
    game.customDefs = defs;
  } catch {
    // A builder that cannot reach the backend must not stop the game starting.
    game.customDefs = [];
  }
  applyCustomCatalog();
}

game.openBuilder = () => {
  // Re-verified here rather than trusted from the button's render: the
  // button is the only caller today, but this guard is what actually makes
  // that true rather than merely currently true. See adminAccount.js.
  if (!isGodModeAccount(game.account)) return;
  if (!game.builderScreen) {
    game.builderScreen = new BuilderScreen({
      toast: (m) => showToast(m),
      // Reloading on close is what makes a vehicle saved in the editor appear
      // in the drawer without a page refresh.
      onClose: () => refreshCustomDefs(),
    });
  }
  game.builderScreen.open();
};

game.openSoundCreator = () => {
  if (!isGodModeAccount(game.account)) return;
  if (!game.soundScreen) {
    game.soundScreen = new SoundScreen({
      toast: (m) => showToast(m),
      // Reloading on close is what makes a sound saved in the editor take
      // effect without a page refresh — the same rule as the vehicle builder.
      onClose: () => refreshCustomSounds(),
    });
  }
  game.soundScreen.open();
};

// Restores an existing session on load. Never throws and never blocks startup:
// `api.me()` resolves to null for signed-out, no-backend, and unreachable
// alike, because none of those should stop the game from starting.
api.me().then((user) => {
  if (!user) return;
  game.account = user;
  menu.rebuild();
  game.portalScreen?.refreshAccount();
  refreshCustomDefs();
});

// A mailed reset link points back at this page with the token in the query
// string — jump straight to "set new password" rather than making the player
// find their own way to it through sign-in. Stripped from the URL
// immediately (history.replaceState, no reload) so refreshing or sharing the
// link afterward doesn't re-arm a token that's either already spent or about
// to be.
{
  const resetToken = new URLSearchParams(location.search).get('resetToken');
  if (resetToken && api.isConfigured) {
    game.authScreen.showReset(resetToken);
    const url = new URL(location.href);
    url.searchParams.delete('resetToken');
    history.replaceState(null, '', url);
  }
}

// A message queued right before `location.reload()` — see `endOnlineMatch` —
// would otherwise vanish with the page that was about to show it. sessionStorage
// survives the reload; this reads it back exactly once and clears it, so it
// cannot resurface on some unrelated later reload.
{
  const pendingToast = sessionStorage.getItem('pendingToast');
  if (pendingToast) {
    sessionStorage.removeItem('pendingToast');
    showToast(pendingToast, 8000);
  }
}

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Diagnostic only: requestAnimationFrame is throttled hard by browsers once a
// tab/window loses focus, and animate() below is the only thing that drives
// LockstepSession forward. A backgrounded client during an online match can
// fall behind and stop sending turn input long before anything else notices —
// this makes that visible in the console instead of only showing up as an
// unexplained stall on the *other* client.
addEventListener('visibilitychange', () => {
  console.log(`[visibility] ${document.visibilityState} at ${performance.now().toFixed(0)}ms`);
});

const clock = new THREE.Clock();
let statsTimer = 0;
let frames = 0;
let fps = 0;

// Tick-driven, not setInterval — same reasoning updateRespawns already states:
// this has to advance correctly under window.__step's synthetic ticks too,
// not just real wall-clock frames, and a real JS timer would never fire (or
// fire at the wrong rate) while __step is fast-forwarding simulated seconds.
const AUTOSAVE_INTERVAL_SECONDS = 300;
const AUTOSAVE_KEEP = 8; // ~40 minutes of history at the 5-minute interval
const AUTOSAVE_PREFIX = 'Autosave ';
let autosaveTimer = 0;

/** Zero-padded and lexicographically sortable, unlike toLocaleString(). */
function autosaveTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A generated name only — manual saves (controlSchema.js's save field) are
 * completely untouched by this, by design: typing a name and clicking Save
 * still overwrites that exact slot, exactly as before.
 */
function autosave() {
  const name = AUTOSAVE_PREFIX + autosaveTimestamp();
  game.saveGame(name);
  showToast(`Autosaved ${autosaveTimestamp()}`);

  // Prune oldest-first once there are more than AUTOSAVE_KEEP — the
  // timestamp's format sorts lexicographically the same as chronologically,
  // so listLocalSaves()'s existing alphabetical sort is already the right order.
  const autosaves = game.listLocalSaves().filter((n) => n.startsWith(AUTOSAVE_PREFIX));
  const excess = autosaves.length - AUTOSAVE_KEEP;
  for (let i = 0; i < excess; i++) game.deleteLocalSave(autosaves[i]);
}

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

/**
 * One fixed simulation step. Everything that changes game state lives here and
 * nowhere else — `renderTick` below is pure presentation.
 *
 * `dt` is a parameter rather than a hardcoded SIM_DT only so `window.__step`
 * can still fast-forward at a chosen step size; real play always passes SIM_DT.
 */
function simTick(dt) {
  const p = tickProfiler;
  advanceSimClock();
  // Player intent is applied here — at a fixed point in the step — rather than
  // inside the DOM event handler that produced it. Browsers deliver events
  // whenever they like; a simulation that must match another machine's cannot
  // be at the mercy of that.
  drainIntents();
  p.time('world', () => world.update(dt, camera, p));
  // Between the input and the fleet: the AI must see this frame's keys before
  // deciding (so it never issues an order the player just cancelled) and set
  // its targets before the fleet consumes them.
  // Before harvesterAI and repairController both: they must route against an
  // already-decided assignment, not race each other to claim a dock. Also the
  // pass that rebuilds the clearance index from the live fleet, which is what
  // reaps claims whose holder died or whose facility is gone.
  p.time('facilityControl', () => facilityControl.update());
  p.time('harvesterAI', () => harvesterAI.update(dt));
  // Same reasoning, one level up: each AI team's own deploy/build/scout
  // decisions need this frame's harvester targets already set (so it isn't
  // second-guessing an order harvesterAI just issued) and have to land before
  // trafficController reads what everyone is driving toward.
  p.time('aiCommanders', () => {
    if (!game.matchOver) for (const commander of game.aiCommanders) commander.update(dt);
  });
  // After harvesterAI: a repairing harvester is already paused by the check
  // above, so this is the only thing setting its target this frame.
  p.time('repairController', () => repairController.update(dt));
  // After both AI systems have set their targets, and before movement reads
  // them: this is what actually decides `yielding` and hands out collision
  // damage for the frame about to run.
  p.time('trafficController', () => trafficController.update(dt));
  // After every driver has had its say and before the fleet moves: a shot is
  // resolved against where things are *this* frame, and any resulting death is
  // queued for the single flush below rather than removed underneath the
  // movement step that is about to run.
  p.time('combatController', () => combatController.update(dt));
  // Immediately after the guns, and before the fleet moves: a shell resolves
  // against where things are *this* frame, and any resulting death is queued
  // for the single flush below rather than removed underneath the movement
  // step that is about to run — the same placement, and the same reasoning,
  // that hitscan resolution used to have inside combatController itself.
  p.time('projectiles', () => projectiles.update(dt));
  // After the shells, so a coin dropped by a kill this tick is claimable from
  // the next one — and before entities.flush(), so a collector destroyed on
  // the same tick it drove over a coin has already been paid.
  p.time('bounties', () => bounties.update());
  p.time('vehicles', () => {
    const headlights = headlightsWanted();
    vehicles.update(dt, heightmap, headlights, camera);
    // Called every frame rather than only on selection change: attach() is a
    // no-op when the target is unchanged, and driving it from here means the
    // pool also recovers on its own when the active vehicle is destroyed and
    // the 2B handoff picks a replacement (or leaves none).
    headlightPool.attach(vehicles.active);
    headlightPool.update(headlights);
    // Testing-only flood mode. Both calls are no-ops while it's off, so the
    // normal path pays nothing for it.
    headlightPool.setFlood(lighting.floodHeadlights);
    headlightPool.syncFlood(vehicles.instances, headlights);
  });
  p.time('structures', () => structures.update(dt, heightmap));

  // Flushed here, and nowhere else — after every system above has taken its
  // turn iterating vehicles/structures for the frame, before the fog reveal
  // loop below iterates them again. Never mid-iteration: a system splicing
  // an array while another system is still walking it would skip or
  // double-visit an entry.
  p.time('entitiesFlush', () => entities.flush());

  // Reveal after the vehicles have moved — world.update() runs before them, so
  // committing there would upload a frame stale. Each entity reveals into its
  // own team's mask: an AI scouting the far coast must not chart it for you.
  // The player's own mask still updates every frame (it drives the visible
  // fog shader and the explored-percentage readout); AI masks are only ever
  // read on the CPU on their own schedule, so they're staggered one team per
  // frame — the reveal loop is now an N-times cost with N teams, and nothing
  // needs an AI's fog fresher than "within the last few frames."
  p.time('fogReveal', () => {
    fogRevealCounter = (fogRevealCounter + 1) % FOG_STAGGER_PERIOD;
    for (const v of vehicles.instances) {
      if (v.teamId !== game.localTeamId && v.teamId % FOG_STAGGER_PERIOD !== fogRevealCounter) continue;
      const mask = game.fogFor(v.teamId);
      if (mask) mask.reveal(v.group.position.x, v.group.position.z, v.def.sightRadius, v);
    }
    for (const s of structures.instances) {
      if (s.teamId !== game.localTeamId && s.teamId % FOG_STAGGER_PERIOD !== fogRevealCounter) continue;
      const mask = game.fogFor(s.teamId);
      if (mask) mask.reveal(s.x, s.z, s.def.sightRadius, s);
    }
    // Only the player's mask is drawn, so only it needs uploading; the AI masks
    // are read on the CPU and have no texture to commit.
    world.fog.commit();
  });

  // Tire tracks — every vehicle, every team, no staggering: unlike fog this is
  // shared world detail, not team-private knowledge, so there's no "whose
  // turn" to reason about.
  p.time('trackMask', () => {
    const mask = world.trackMask;
    for (const v of vehicles.instances) {
      if (v.dead || v.speed < 0.2) continue; // parked/stationary lays nothing new
      // Weight drives darkness; the wheels drive where and how wide. Spread
      // chosen so nothing saturates: scout 1.2t -> 0.41, harvester 4.5t ->
      // 0.57, tank 6t -> 0.65, base station 12t -> 0.95. An earlier curve
      // pinned both the tank and the base station at 1.0, which threw away
      // the weight difference the feature exists to show.
      const intensity = Math.min(1, 0.35 + v.def.weight / 20);
      const dims = v.def.dims;
      mask.stampVehicle(
        v.group.position.x,
        v.group.position.z,
        v.heading,
        dims.hullWidth * 0.5, // wheel lines sit at the hull edge
        Math.max(dims.wheelWidth * 0.5, mask.cellSize * 0.5), // never sub-texel
        intensity,
        v
      );
    }
    mask.decay(dt);
    mask.commit();

    // Scorch decays on the same tick as tracks — same shape of mask, same
    // reason it belongs in the sim step rather than the render one: the fade
    // is expressed in simulated seconds so it runs at the same rate under
    // window.__step's headless fast-forward as it does in real play.
    world.scorchMask.decay(dt);
    world.scorchMask.commit();
  });


  // After the camera has settled, so the menu projects against this frame's
  // view rather than lagging it by one.
  p.time('terraform', () => terraform.update(dt));
  p.time('matchState', () => {
    checkBaseRepositioning();
    // After entities.flush() above, so "does this team still have a base" is
    // asked of a fleet with this tick's deaths already removed rather than one
    // still holding a corpse.
    checkMatchEnd();
    updateRespawns(dt);
  });

  // Before the render-only early return, same reasoning as updateRespawns
  // above: this has to fire correctly under window.__step's headless
  // fast-forward, not just real animate() frames.
  //
  // Skipped entirely in an online match: a local save only ever captures this
  // one client's world, and loading it back can't reconnect to the lockstep
  // session or the other player — so it would neither resume the match nor
  // even agree with what the other player has. It would just be a stray
  // toast and a save-slot nobody can use.
  if (game.mode !== 'multiplayer-online') {
    autosaveTimer += dt;
    if (autosaveTimer >= AUTOSAVE_INTERVAL_SECONDS) {
      autosaveTimer = 0;
      autosave();
    }
  }

}

/**
 * Presentation only — never mutates simulation state, so it can run once per
 * animation frame at whatever rate the display manages while the sim above runs
 * on its own fixed clock. `dt` here is real frame time (what fps counters,
 * tracer fades and auto-quality want), not simulated time.
 */
function renderTick(dt) {
  const p = tickProfiler;

  // The camera lives here rather than in simTick because it is presentation,
  // and because MapControls' damping only applies while update() is called —
  // leaving it in the simulation meant a lockstep stall froze the view, so a
  // match waiting on a peer looked like a hung game rather than a paused one.
  p.time('cameraControls', () => {
    if (isChasing()) {
      // MapControls would fight the chase rig for the camera transform.
      controls.enabled = false;
      chase.update(dt, vehicles.active);
    } else {
      controls.enabled = true;
      controls.update();
    }
  });

  if (match) {
    updateNetDebug({
      seed: heightmap.params.seed,
      teamId: game.localTeamId,
      turn: match.session.turn,
      simTick: simClock.tick,
      stalled: match.session.stalled,
      begun: match.begun,
      players: match.expectedPlayers,
      connected: match.client.connected,
      checkpoint: match.checkpoint,
      desyncTurn: match.desyncTurn,
      agreedTurn: match.agreedTurn,
      agreedPeers: match.agreedPeers,
      vehicles: vehicles.instances.filter((v) => !v.dead).length,
      structures: structures.instances.filter((x) => !x.dead).length,
      credits: game.teams.map((t) => Math.round(t.credits)),
    });
  }

  // A stalled match is normal and temporary, but an unexplained frozen world is
  // not. Re-toasting on a slow cadence keeps the message up for as long as the
  // wait lasts and clears itself shortly after play resumes.
  if (match && match.session.stalled && match.session.stallSteps > 0) {
    matchWaitTimer += dt;
    if (matchWaitTimer >= 1) {
      matchWaitTimer = 0;
      matchStallSeconds += 1;
      const waiting = match.waitingFor;
      if (!match.begun && waiting) {
        // The server has told us the roster is short and stayed short. It will
        // now wait indefinitely rather than starting a match that cannot work,
        // so this is a decision for the player, not a status line — it needs a
        // way out attached.
        showToast(
          `Still waiting for ${waiting.expected - waiting.present} of ` +
            `${waiting.expected} players to connect.`,
          0,
          { label: 'Leave match', onClick: () => endOnlineMatch(null) }
        );
      } else if (match.begun && matchStallSeconds >= MID_MATCH_STALL_ESCALATE_S) {
        // The match itself pauses on an absent or lagging peer for as long as
        // it takes rather than ejecting anyone automatically (see
        // server/src/ws/match.js's roster-based quorum) — a pause that looks
        // identical to a freeze is what made the underlying bug hard to even
        // report. Past a few seconds this stops being ordinary jitter and
        // needs the same way out as the pre-start wait.
        showToast(
          'Still waiting for the other player — the match is paused, not frozen.',
          0,
          { label: 'Leave match', onClick: () => endOnlineMatch(null) }
        );
      } else {
        showToast(
          match.begun
            ? 'Waiting for the other player…'
            : `Waiting for ${match.expectedPlayers} players to connect…`,
          2000
        );
      }
    }
  } else {
    matchWaitTimer = 0;
    matchStallSeconds = 0;
  }

  // Shell visuals. Driven by real frame time, not sim time: the shells' own
  // positions come from the fixed-step sim, but how their flashes and debris
  // decay is presentation and should follow the viewer's clock.
  p.time('projectileFx', () => {
    projectileFx.updateShells(projectiles.instances, world.atmosphere.params.elevation);
    projectileFx.updateEffects(dt);
    updateFlares(dt);
    bountyFx.update(bounties.instances, dt, world.atmosphere.params.elevation);
  });
  // Presentation, so it runs here rather than in simTick — where it used to.
  // `_reposition` closes the menu when its anchor goes behind the near plane,
  // which is a *camera* test, and the camera is not replicated: running it
  // inside the simulation meant the sim branched on where each client happened
  // to be looking. The hold it applies to a vehicle now travels as an intent
  // (see radialMenu's onHold), so the sim state is agreed even though the
  // trigger is local.
  p.time('radialMenu', () => {
    // A field has no entities.onDestroy hook to close its menu (that pipeline
    // is vehicles/structures only), so the one case radialMenu.update can't
    // already catch — a base pad poured over the field while its menu is open
    // — is handled here.
    if (radialMenu.isOpen && radialMenu.instance.kind === 'field' && radialMenu.instance.dead) {
      radialMenu.close();
    }
    radialMenu.update();
  });
  p.time('engineAudio', () => updateEngineAudio(dt));
  p.time('ambienceAudio', () => audio.updateAmbience(nightFactor(world.atmosphere.params.elevation)));
  // Per-frame, unlike the rest of the HUD's half-second poll — see
  // Hud.updateHealth for why health specifically cannot wait.
  p.time('hudHealth', () => hud.updateHealth(vehicles.active));
  // Blips and the view rectangle move every frame; the terrain+fog raster
  // behind them is rebuilt on the half-second poll below instead.
  p.time('minimap', () => {
    if (minimap.root?.classList.contains('hidden')) return;
    minimap.draw({
      size: heightmap.params.size,
      fogMask: game.playerTeam?.fog ?? world.fog,
      vehicles: vehicles.instances,
      structures: structures.instances,
      colorOf: (teamId) => game.teams?.find((t) => t.id === teamId)?.color ?? '#8ea3b6',
      viewCorners: cameraGroundQuad(),
    });
  });
  p.time('markers', () => {
    updateMarker(clock.elapsedTime);
    updateHarvestMarker(clock.elapsedTime);
    updatePlacementPreview(lastX, lastY);
    syncQueueIcons();
    canvas.classList.toggle(
      'crosshair-mode',
      !!commandContext.harvestSelectMode ||
        !!commandContext.buildPlacementMode ||
        !!commandContext.targetSelectMode
    );
  });
  p.time('vehiclePicker', () => vehiclePicker.update(dt));
  // Only does anything while the Statistics page is the one showing — see
  // Menu.update. Render-side, like everything else in this loop.
  p.time('menu', () => menu.update(dt));
  p.time('render', () => renderer.render(world.scene, camera));
  perfHud.record(dt);
  perfHud.render(renderer, tickProfiler);

  autoQuality.record(dt);
  autoQuality.update({
    // Drives the dwell timer and the fog ramp — see autoQuality.js's header on
    // why this controller has to be damped in time, not just hysteresed.
    dt,
    userForcedPixelRatio: renderQuality.userForced,
    setPixelRatio: (ratio) => renderer.setPixelRatio(ratio),
    basePixelRatio: BASE_PIXEL_RATIO,
    setFogDensity: (density) => { world.atmosphere.params.fogDensity = density; },
    baseFogDensity: BASE_FOG_DENSITY,
  });
  // One quality signal, not two: audio's voice budget and panning model
  // shrink on exactly the same "this device is struggling" verdict the
  // renderer already reached, rather than running a second detector.
  audio.setLowPower(autoQuality.low);

  frames++;
  statsTimer += dt;
  if (statsTimer >= 0.5) {
    fps = Math.round(frames / statsTimer);
    frames = 0;
    statsTimer = 0;

    // Same cadence, same reasoning as exploration below: counting lights costs a
    // scene.traverse, and twice a second is plenty for a number that only moves
    // when something is structurally wrong.
    let lights = 0;
    world.scene.traverse((o) => { if (o.isLight) lights++; });
    perfHud.setLightCount(lights);

    // One fused pass over the fog's own 256x256 grid. Same cadence and same
    // reasoning as the light count above: 65 K cells is cheap but pointless
    // to redo per frame, since fog reveals at walking pace.
    if (!minimap.root?.classList.contains('hidden')) {
      minimap.rebuildRaster(world.fogTerrain, game.playerTeam?.fog ?? world.fog);
    }

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

    // The radio, on the same half-second cadence and for the same reason as
    // everything else in this block: chatter reacts to things that change at
    // human pace, and polling it per frame would be pure waste. It diffs the
    // world rather than being called back into — see audio/chatter.js.
    const localTeamId = game.localTeamId;
    const zones = harvesterAI.dangerZonesFor(localTeamId) ?? [];
    const home = game.playerTeam?.homePoint;
    chatter.observe({
      localTeamId,
      units: vehicles.instances.filter((v) => !v.dead && v.teamId === localTeamId).length,
      structures: structures.instances.filter((i) => !i.dead && i.teamId === localTeamId).length,
      dangerZones: zones.length,
      // "Near base" is what separates a raid on the home block from a
      // skirmish at a crystal field on the far side of the island.
      dangerNearBase: !!home && zones.some((z) => Math.hypot(z.x - home.x, z.z - home.z) <= z.radius + BASE_ALERT_RADIUS),
      harvestersInDanger: vehicles.instances.filter(
        (v) => !v.dead && v.teamId === localTeamId && v.def?.tags?.includes('economy')
          && zones.some((z) => Math.hypot(z.x - v.group.position.x, z.z - v.group.position.z) <= z.radius),
      ).length,
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

/**
 * Advance the sim and draw one frame. Kept as the single entry point that
 * `window.__step` and `__benchmark` already drive.
 */
function tick(dt, { render = true } = {}) {
  simTick(dt);
  if (render) renderTick(dt);
}

/**
 * The simulation runs on a fixed step; only rendering runs per animation frame.
 *
 * This is not a micro-optimisation — it is a correctness requirement. Feeding
 * `clock.getDelta()` straight into the sim (what this used to do) means every
 * machine integrates movement with a slightly different `dt` every frame, so
 * two clients replaying identical inputs still drift apart. It also made the
 * game subtly frame-rate dependent in single player.
 *
 * The sim rate stays at 60Hz, which is why no render interpolation is needed:
 * positions are still updated at least as often as they are drawn.
 */
const MAX_FRAME_DT = 0.25; // a tab regaining focus must not deliver a huge dt
const MAX_CATCHUP_STEPS = 5; // bound the work per frame — see the drop below
let simAccumulator = 0;

// Diagnostic only: reports how many match ticks actually ran per wall-clock
// second, next to the visibilitychange log above. In a healthy foreground tab
// this should track ~60/s; if it collapses right as visibility goes 'hidden',
// that's the throttling hypothesis confirmed rather than assumed.
let matchTickCount = 0;
let matchTickTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  const frameDt = Math.min(clock.getDelta(), MAX_FRAME_DT);
  simAccumulator += frameDt;

  let steps = 0;
  while (simAccumulator >= SIM_DT && steps < MAX_CATCHUP_STEPS) {
    // In a match the session decides when a step is allowed: if the inputs for
    // the current turn have not arrived, the simulation waits rather than
    // running ahead and reconciling. Rendering continues either way, so a stall
    // reads as the world pausing, not as the game freezing.
    // An online match with no live session must not advance at all. Testing
    // `match` alone left a disconnected client free-running an ungated 60Hz
    // simulation of a world it no longer shared with anyone — the game looked
    // perfectly healthy while being, by then, entirely private.
    if (game.mode === 'multiplayer-online' && !match) break;
    if (match && !match.session.beginStep()) break;
    simAccumulator -= SIM_DT;
    steps++;
    simTick(SIM_DT);
    match?.session.endStep();
    if (match) matchTickCount++;
  }
  if (match) {
    matchTickTimer += frameDt;
    if (matchTickTimer >= 1) {
      console.log(
        `[tick-rate] ${matchTickCount} match ticks/s · visibility=${document.visibilityState}` +
        (match.session.stalled ? ' · STALLED' : '')
      );
      matchTickCount = 0;
      matchTickTimer = 0;
    }
  }
  // Time spent stalled is not a debt to repay in a burst — the match paused for
  // everyone, so drop the backlog rather than fast-forwarding out of it.
  if (match?.session.stalled) simAccumulator = Math.min(simAccumulator, SIM_DT);
  // If we hit the cap the machine cannot keep up; keeping the backlog would
  // make every subsequent frame run the cap too and never recover (the classic
  // spiral of death). Drop the debt instead and let the match run slow.
  if (steps >= MAX_CATCHUP_STEPS) simAccumulator = 0;

  renderTick(frameDt);
}

animate();

/**
 * Dev helper: advance the simulation by `seconds` at a fixed step, without
 * rendering. Lets a slow system (a harvest run, a regrowth cycle) be exercised
 * and asserted from the console in a fraction of the wall-clock time.
 */
window.__step = (seconds, dt = SIM_DT) => {
  const steps = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < steps; i++) tick(dt, { render: false });
  return { steps, simulated: +(steps * dt).toFixed(2) };
};

/**
 * Does the simulation produce identical results from identical starting state?
 *
 * This is the claim lockstep multiplayer rests on, so it is worth being able to
 * ask directly rather than inferring it from a match that looks about right.
 * The method: snapshot the live world, run it forward N ticks recording state
 * hashes, restore the identical snapshot, run it again, and compare.
 *
 * Note what is and isn't covered. The "inputs" here are the AI commanders and
 * every autonomous system (harvesters, traffic, combat) — which is most of the
 * simulation and all of the parts with interesting branching. It does not
 * replay human clicks; those become deterministic by construction in 4C, since
 * they are queued and applied at fixed tick boundaries.
 *
 * A mismatch reports the first sampled tick that differs, which is far more
 * useful than a bare boolean — it says how long the two runs stayed together.
 */
/**
 * This client's current state digest. Exposed because when two machines
 * disagree, the first question is always "disagree about what" — and being able
 * to read and diff the hash from a console on each side is the cheapest way in.
 */
window.__hashState = () => hashState({ vehicles, structures, game, projectiles, bounties, blooms: world.blooms, harvesterAI }, simClock.tick);
// Console/e2e debug access to the audio engine — mirrors every other
// window.__ hook here, and is how a headless smoke test confirms the
// AudioContext actually reached 'running' rather than staying suspended.
window.__audio = audio;

/**
 * Issue player intent from the console, exactly as a click would.
 *
 * The point of routing input through data is that it can be produced without a
 * mouse — which makes order-handling testable, and is what a replay or a
 * scripted determinism run needs.
 */
window.__intent = { submit: submitIntent, Intent };

/**
 * The live match, for debugging a stall or a desync from the console.
 *
 * `stalled` is the field to look at first: a frozen world in a match is almost
 * always "waiting for a peer's input", which looks identical to a hang from the
 * outside and is completely different in cause.
 */
window.__match = () => (match ? {
  turn: match.session.turn,
  tickInTurn: match.session.tickInTurn,
  stalled: match.session.stalled,
  stallSteps: match.session.stallSteps,
  bufferedTurns: [...match.session.received.keys()],
  sentThrough: match.session.sentThrough,
  isHost: match.isHost,
  connected: match.client.connected,
  simTick: simClock.tick,
} : null);

/**
 * Drive a networked match forward without requestAnimationFrame — the headless
 * test pane suspends rAF, so this is the only way to exercise the real lockstep
 * gating there. Mirrors animate()'s loop exactly.
 */
window.__stepMatch = (steps = 60) => {
  if (!match) return { error: 'not in a match' };
  let ran = 0;
  for (let i = 0; i < steps; i++) {
    if (!match.session.beginStep()) break;
    simTick(SIM_DT);
    match.session.endStep();
    ran++;
  }
  return { ran, ...window.__match() };
};

window.__determinismCheck = ({ ticks = 900, sampleEvery = 60 } = {}) => {
  if (!game.teams?.length) return { ok: false, error: 'Start a match first.' };

  const baseline = JSON.stringify(serialize(snapshotContext()));
  const hashCtx = { vehicles, structures, game, projectiles, bounties, blooms: world.blooms, harvesterAI };

  const run = () => {
    deserialize(snapshotContext(), JSON.parse(baseline));
    const out = [];
    for (let i = 0; i < ticks; i++) {
      simTick(SIM_DT);
      if ((i + 1) % sampleEvery === 0) out.push(hashState(hashCtx, simClock.tick));
    }
    return out;
  };

  const a = run();
  const b = run();
  const firstDivergence = a.findIndex((h, i) => h !== b[i]);

  // Leave the world on the second run's state rather than half-restored.
  const result = {
    ok: firstDivergence === -1,
    ticks,
    samples: a.length,
    firstDivergence: firstDivergence === -1 ? null : {
      sample: firstDivergence,
      tick: (firstDivergence + 1) * sampleEvery,
      runA: a[firstDivergence],
      runB: b[firstDivergence],
    },
    finalHash: a[a.length - 1] ?? null,
  };
  console[result.ok ? 'log' : 'warn']('determinism:', result);
  return result;
};

/**
 * Fixed, repeatable scene for A/B testing performance changes —
 * docs/performance-optimization-plan.md Phase 0. Same terrain seed (the
 * heightmap's untouched default), same camera framing, same vehicle count
 * and layout every call, so a before/after fps comparison actually measures
 * the code change and not scene variance. Only meaningful once a match has
 * started (sandbox or Multiplayer AI) — call after choosing a mode, or use
 * the `?benchmark=<n>` URL param to skip the portal entirely.
 *
 * Run from the console: `__benchmark()`, or `__benchmark({ vehicleCount: 40 })`
 * for the denser scene Phase 4 (draw-call reduction) is measured against.
 *
 * @param {object} [opts]
 * @param {number} [opts.vehicleCount] armed vehicles spawned in a fixed grid
 *   in front of the camera.
 */
window.__benchmark = ({ vehicleCount = 20 } = {}) => {
  controls.enabled = false;
  camera.position.set(0, 140, 220);
  camera.lookAt(0, 0, 0);

  const gunDef = vehicles.defOf('gun-platform');
  const cols = Math.ceil(Math.sqrt(vehicleCount));
  const spacing = 14;
  for (let i = 0; i < vehicleCount; i++) {
    const x = (i % cols) * spacing - (cols * spacing) / 2;
    const z = Math.floor(i / cols) * spacing + 40;
    const y = heightmap.heightAt(x, z) + 0.05;
    const v = vehicles.spawn(gunDef, { x, y, z }, 0, { activate: false, teamId: i % 2 });
    v.mode = 'armed';
  }

  perfHud.setVisible(true);
  console.log(
    `[benchmark] ${vehicleCount} vehicles spawned, camera fixed, perf HUD on. ` +
    `Let it settle a few seconds, then read the overlay (top-left) or window.perfHud.samples.`
  );
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
  projectiles, projectileFx, tick, perfHud,
});

// docs/performance-optimization-plan.md Phase 0 — `?perf=1` shows the HUD
// immediately; `?benchmark=<n>` additionally skips the portal straight into
// a fixed sandbox scene with `<n>` vehicles, for platforms (mobile) where
// typing into a console isn't practical.
{
  const params = new URLSearchParams(location.search);
  if (params.has('perf') || params.has('benchmark')) perfHud.setVisible(true);
  if (params.has('benchmark')) {
    const vehicleCount = parseInt(params.get('benchmark'), 10) || 20;
    game.portalScreen.choose('sandbox');
    game.difficultyScreen.choose(DIFFICULTIES.find((d) => d.id === 'normal') ?? DIFFICULTIES[1]);
    // One frame so the world/heightmap actually exist before spawning into it.
    requestAnimationFrame(() => window.__benchmark({ vehicleCount }));
  }
}
