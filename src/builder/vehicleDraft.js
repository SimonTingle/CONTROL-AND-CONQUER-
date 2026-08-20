/**
 * The vehicle-builder's data model: making, copying and checking defs.
 *
 * A def is the same plain-data shape `src/vehicles/catalog.js` ships — no
 * functions, no THREE objects — which is the whole reason a parametric editor
 * is cheap here: `buildVehicleMesh` has no per-vehicle-id special cases, so
 * anything this file produces renders exactly like a built-in vehicle.
 *
 * Two constraints this file exists to protect:
 *
 * - `buildVehicleMesh` dereferences `def.lights` unconditionally, and
 *   `buildLights` reads `headlampInset`/`headlampDrop`/the three colours with
 *   no defaults. A def missing that block does not render badly, it *throws*.
 *   `blankDef()` therefore always includes one.
 * - Custom ids are namespaced `custom:` so they can never collide with a
 *   built-in, and so an unresolvable `custom:` id elsewhere reads as "that
 *   peer doesn't have this vehicle" rather than a corrupt save.
 */
import { VEHICLE_CATALOG } from '../vehicles/catalog.js';
import { STRUCTURE_CATALOG } from '../structures/structures.js';
import { fnv1a64 } from '../core/fnv1a.js';
import { deriveBounds, getPath } from './builderSchema.js';

/** The editor's own slider ranges, made binding. See deriveBounds(). */
const BOUNDS = deriveBounds();

export const CUSTOM_ID_PREFIX = 'custom:';

/** Save-format version, stored alongside the def. Bump on a breaking change. */
export const DRAFT_SCHEMA_VERSION = 1;

/**
 * Keys that describe *which* vehicle this is rather than *what* it is, plus the
 * runtime-only bookkeeping `loadCustomDefs` attaches. All excluded from the
 * fingerprint, so renaming a vehicle does not change its identity and two
 * authors who build the same thing under different names converge on one id.
 */
const IDENTITY_KEYS = ['id', 'name', 'description', 'draft', 'saveId', 'saveName'];

/**
 * `JSON.stringify` with object keys sorted at every depth, so two structurally
 * identical defs serialise identically regardless of the order their keys were
 * assigned in. Sound because defs are pure data — no functions, no THREE
 * objects — which the round-trip test in tests/vehicle-def.test.mjs pins.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

/** The canonical serialisation a def's id is derived from. */
export function defFingerprint(def) {
  const stats = {};
  for (const key of Object.keys(def ?? {})) {
    if (!IDENTITY_KEYS.includes(key)) stats[key] = def[key];
  }
  return canonicalJson(stats);
}

/**
 * A vehicle's id, derived from its contents.
 *
 * Previously this slugged the name (`My Tank` -> `custom:my-tank`), which meant
 * two accounts with entirely different vehicles both called "My Tank" produced
 * the *same id for different defs*. Nothing caught that: only `defId` strings
 * cross the wire, `snapshot.js` skips ids it cannot resolve without erroring,
 * and `stateHash.js` hashes instance ids and positions rather than defs. Two
 * peers would each simulate a different tank under one id — the exact silent
 * divergence class this project has already fixed three times.
 *
 * Content-addressing removes the collision by construction and, as a side
 * effect, makes the name a free-text label: call it whatever you like, and so
 * can everyone else.
 */
export function customIdFor(def) {
  return CUSTOM_ID_PREFIX + fnv1a64(defFingerprint(def));
}

/** Recompute `def.id` from its contents, in place. Returns the same def. */
export function syncId(def) {
  def.id = customIdFor(def);
  return def;
}

export const isCustomId = (id) => typeof id === 'string' && id.startsWith(CUSTOM_ID_PREFIX);

/**
 * A minimal but complete vehicle — deliberately the scout's rough shape rather
 * than zeroes, so the preview shows something drivable-looking on first open
 * and every slider starts somewhere sensible.
 */
export function blankDef(name = 'New Vehicle') {
  // `id` is filled in by syncId() at the end — it is derived from everything
  // below it, so it cannot be written here.
  const def = {
    id: '',
    name,
    description: 'Built in the vehicle editor.',
    role: 'unit',
    tags: ['combat'],
    weight: 2,
    unlock: null,
    cost: 400,
    maxHealth: 150,
    // Spawnable so it appears in the sandbox drawer; not produced by any
    // factory until the author wires one up.
    spawnable: true,
    producedBy: null,
    turret: {
      range: 60,
      fireArc: Math.PI * 1.5,
      sweepRate: 1.4,
      rotationRate: 2.5,
      armedSpeedFactor: 0.5,
      armedSteerFactor: 0.5,
      damage: 8,
      fireInterval: 1.5,
      muzzleHeight: 1.9,
      projectileColor: 0xffa018,
      projectileSpeed: 140,
    },
    sightRadius: 50,
    speed: 18,
    reverseSpeed: 8,
    acceleration: 12,
    braking: 28,
    rollingResistance: 6,
    maxSteerAngle: 0.5,
    steerRate: 1.8,
    maxClimbGrade: 0.5,
    axles: 2,
    axleFractions: [1.0, -1.0],
    steerRatios: [1.0, 0],
    shape: { nose: true, turret: true, tank: false, tracked: false, cabinLength: 0.3, cabinX: 0.2 },
    // Only read when shape.tracked is on, but always present so switching to
    // tracks in the editor never lands on undefined dimensions.
    pivotRate: 0.9,
    // Never omit this block — see the file header.
    lights: {
      style: 'lamps',
      headlampInset: 0.3,
      headlampDrop: 0.24,
      beamAngle: 0.5,
      beamDistance: 120,
      beamIntensity: 900,
      beamColor: '#f6fbff',
      tailColor: '#ff2b18',
      reverseColor: '#f4f8ff',
      reverseBeamIntensity: 380,
      reverseBeamDistance: 55,
      reverseBeamAngle: 0.68,
      tailBeamIntensity: 130,
      tailBeamDistance: 24,
      tailBeamAngle: 0.8,
      duskElevation: 8,
    },
    dims: {
      hullLength: 7.5,
      hullWidth: 2.8,
      hullHeight: 1.3,
      cabinHeight: 0.9,
      wheelRadius: 0.8,
      wheelWidth: 0.6,
      suspensionTravel: 1.0,
      turretRadius: 1.0,
      turretHeight: 0.75,
      barrelRadius: 0.16,
      barrelLength: 3.0,
      roadWheels: 5,
      trackWidth: 0.95,
      trackThickness: 0.18,
    },
    colors: { hull: '#4b4f46', cabin: '#292d28', wheel: '#161616', trim: '#8f9a86' },
    previewDistance: 16,
  };
  return syncId(def);
}

/**
 * Deep copy via JSON — sound precisely because defs are pure data, and the
 * round-trip test in tests/vehicle-def.test.mjs is what keeps that true.
 */
export const cloneDef = (def) => JSON.parse(JSON.stringify(def));

/**
 * Copy a built-in (or any) vehicle into an editable custom one.
 *
 * The runtime-only keys are stripped rather than carried: a fork is a new
 * vehicle, not a second handle on the save row the original came from.
 */
export function forkDef(def, name) {
  const copy = cloneDef(def);
  copy.name = name ?? `${def.name} (copy)`;
  delete copy.draft;
  delete copy.saveId;
  delete copy.saveName;
  return syncId(copy);
}

const REQUIRED_DIMS = [
  'hullLength', 'hullWidth', 'hullHeight', 'cabinHeight',
  'wheelRadius', 'wheelWidth',
];
const REQUIRED_COLORS = ['hull', 'cabin', 'wheel', 'trim'];
// Structures with a `produces` list — the only ones a `producedBy` can name
// and have it mean anything. Derived rather than hardcoded so a new producing
// structure is picked up without editing this file.
const PRODUCERS = STRUCTURE_CATALOG.filter((d) => d.produces?.length).map((d) => d.id);
// The subset buildLights reads without a default — anything here being absent
// is a thrown TypeError at render time, not a cosmetic problem.
const REQUIRED_LIGHTS = ['headlampInset', 'headlampDrop', 'beamColor', 'tailColor', 'reverseColor'];

const isPositive = (v) => Number.isFinite(v) && v > 0;

/** Paths the mesh builder only reads when the matching shape flag is on. */
const TURRET_ONLY_PATHS = [
  'dims.turretRadius', 'dims.turretHeight', 'dims.barrelRadius', 'dims.barrelLength',
];
const TRACKED_ONLY_PATHS = [
  'dims.roadWheels', 'dims.trackWidth', 'dims.trackThickness', 'pivotRate',
];

/**
 * Is this bounded path inert for this def?
 *
 * Range-checking a field nothing reads would be a validator stricter than the
 * engine — the failure mode this file's axle rules already exist to avoid. Two
 * shipped vehicles prove it is not hypothetical: `base-station` and
 * `crystal-harvester` both carry `dims.turretRadius: 0` and friends, well under
 * the editor's minimum, because they have no turret to size. Both render fine,
 * and forking either one must stay valid.
 */
function isDormantPath(path, def) {
  if (!def.shape?.turret && TURRET_ONLY_PATHS.includes(path)) return true;
  if (!def.shape?.tracked && TRACKED_ONLY_PATHS.includes(path)) return true;
  return false;
}

/**
 * @returns {string[]} human-readable problems; empty means the def is safe to
 *   hand to `buildVehicleMesh` and to save.
 */
export function validateDef(def, { catalog = VEHICLE_CATALOG } = {}) {
  const problems = [];
  if (!def || typeof def !== 'object') return ['Not a vehicle definition.'];

  if (!def.id || typeof def.id !== 'string') problems.push('Needs an id.');
  else if (!isCustomId(def.id)) problems.push(`Custom vehicle ids must start with "${CUSTOM_ID_PREFIX}".`);
  // The id is a content address, so it has to actually address this content.
  // A def whose id does not match its own stats is either hand-edited or was
  // written by an older build; either way it must not be trusted, because the
  // whole point of the scheme is that one id means one vehicle everywhere.
  else if (def.id !== customIdFor(def)) problems.push('Id does not match the vehicle — re-save it.');
  // Now that ids are derived, a match means the two defs are byte-identical
  // rather than merely same-named: a real duplicate, not a name clash.
  else if (catalog.some((d) => d.id === def.id)) problems.push('An identical vehicle already exists.');

  if (!def.name || typeof def.name !== 'string') problems.push('Needs a name.');

  // Mirror what vehicleFactory.js actually requires, no more: `axles` defaults
  // to 2 and both arrays are optional (scout-buggy ships without any of them).
  // Being stricter here would reject vehicles the engine renders happily.
  // `axleFractions`, when present, is what actually decides the axle count —
  // axleOffsets() maps it directly and never consults `axles`.
  if (def.axles !== undefined) {
    // Not `< 1`: axleOffsets divides by (count - 1) for counts above two, so a
    // single axle yields NaN offsets rather than a one-axle vehicle.
    if (!Number.isInteger(def.axles) || def.axles < 2) {
      problems.push('axles must be a whole number, 2 or more.');
    }
  }
  if (def.axleFractions !== undefined) {
    if (!Array.isArray(def.axleFractions) || def.axleFractions.length < 2) {
      problems.push('axleFractions must list at least 2 positions.');
    } else if (!def.axleFractions.every(Number.isFinite)) {
      problems.push('Every axle position must be a number.');
    } else if (Number.isInteger(def.axles) && def.axleFractions.length !== def.axles) {
      // Not fatal to the engine, but it means `axles` is a lie — the count
      // comes from the array — and the editor should never emit that.
      problems.push(`axleFractions lists ${def.axleFractions.length} axles but axles says ${def.axles}.`);
    }
  }
  if (def.steerRatios !== undefined) {
    if (!Array.isArray(def.steerRatios)) {
      problems.push('steerRatios must be a list.');
    } else if (!def.steerRatios.every(Number.isFinite)) {
      problems.push('Every steer ratio must be a number.');
    } else {
      const axleCount = def.axleFractions?.length ?? def.axles ?? 2;
      if (def.steerRatios.length !== axleCount) {
        problems.push(`steerRatios must list one value per axle (${axleCount}).`);
      }
    }
  }

  if (!def.dims || typeof def.dims !== 'object') {
    problems.push('Needs a dims block.');
  } else {
    for (const key of REQUIRED_DIMS) {
      if (!isPositive(def.dims[key])) problems.push(`dims.${key} must be a positive number.`);
    }
    if (def.shape?.turret) {
      for (const key of ['turretRadius', 'turretHeight', 'barrelRadius', 'barrelLength']) {
        if (!isPositive(def.dims[key])) problems.push(`dims.${key} must be a positive number for a turreted vehicle.`);
      }
    }
    if (def.shape?.tracked) {
      // The belt is built as an outline with the same outline inset by the
      // thickness punched out. A thickness at or above the wheel radius would
      // collapse that hole, leaving a solid slab where the running gear should
      // be — so this is a geometry constraint, not a taste one.
      const thickness = def.dims.trackThickness;
      if (thickness !== undefined) {
        if (!isPositive(thickness)) problems.push('dims.trackThickness must be a positive number.');
        else if (thickness >= def.dims.wheelRadius) {
          problems.push('dims.trackThickness must be smaller than the wheel radius.');
        }
      }
      if (def.dims.trackWidth !== undefined && !isPositive(def.dims.trackWidth)) {
        problems.push('dims.trackWidth must be a positive number.');
      }
      if (def.dims.roadWheels !== undefined) {
        if (!Number.isInteger(def.dims.roadWheels) || def.dims.roadWheels < 2) {
          problems.push('dims.roadWheels must be a whole number, 2 or more.');
        }
      }
      // A track that cannot pivot cannot turn at all: it has no steered axle,
      // so this rate is its only source of yaw.
      if (def.pivotRate !== undefined && !isPositive(def.pivotRate)) {
        problems.push('pivotRate must be a positive number for a tracked vehicle.');
      }
    }
  }

  if (!def.colors || typeof def.colors !== 'object') {
    problems.push('Needs a colors block.');
  } else {
    for (const key of REQUIRED_COLORS) {
      if (typeof def.colors[key] !== 'string') problems.push(`colors.${key} must be a colour.`);
    }
  }

  // See the file header: this block is load-bearing, not decorative.
  if (!def.lights || typeof def.lights !== 'object') {
    problems.push('Needs a lights block — the mesh builder requires one.');
  } else {
    for (const key of REQUIRED_LIGHTS) {
      if (def.lights[key] === undefined) problems.push(`lights.${key} is required.`);
    }
  }

  // `producedBy` names the structure that can build this vehicle. Only
  // structures that actually produce units can honour it — pointing at the
  // repair bay would leave a vehicle that claims to be buildable and never
  // appears in any menu.
  if (def.producedBy !== null && def.producedBy !== undefined) {
    if (!PRODUCERS.includes(def.producedBy)) {
      problems.push(`producedBy must be one of: ${PRODUCERS.join(', ')} (or none).`);
    }
  }
  if (def.unlock !== null && def.unlock !== undefined && def.unlock !== 'exploration') {
    // An unrecognised unlock string is not ignored by the picker — it leaves
    // the vehicle permanently locked with a generic "Locked" label.
    problems.push("unlock must be 'exploration', or none.");
  }
  if (!Number.isFinite(def.cost) || def.cost < 0) {
    problems.push('cost must be zero or more.');
  }
  if (def.producedBy && !Array.isArray(def.tags)) {
    // aiCommander selects produced units by tag, so a buildable vehicle with
    // no tags can be built by a player but never by an AI.
    problems.push('A buildable vehicle needs at least one tag.');
  }
  // Harvesting needs `capacity`, `fillRate` and `unloadRate`, which harvesterAI
  // reads with no defaults and the editor cannot author. Without this, the
  // combination the Production panel actively offers — built at the harvester
  // facility, tagged 'economy' — produces a vehicle aiCommander buys as part of
  // its economy and which can then never harvest anything.
  if (def.tags?.includes('economy') && def.capacity === undefined) {
    problems.push('An economy vehicle needs harvesting stats, which the editor cannot set yet — use another role.');
  }

  for (const key of ['speed', 'reverseSpeed', 'acceleration', 'braking', 'maxHealth', 'sightRadius']) {
    if (!isPositive(def[key])) problems.push(`${key} must be a positive number.`);
  }
  if (!Number.isFinite(def.maxClimbGrade) || def.maxClimbGrade <= 0) {
    problems.push('maxClimbGrade must be a positive number.');
  }

  // Every slider's own range, now binding rather than advisory.
  for (const [path, { min, max }] of Object.entries(BOUNDS)) {
    if (isDormantPath(path, def)) continue;
    const value = getPath(def, path);
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value)) {
      problems.push(`${path} must be a number.`);
    } else if (value < min || value > max) {
      problems.push(`${path} must be between ${min} and ${max}.`);
    }
  }

  return problems;
}
