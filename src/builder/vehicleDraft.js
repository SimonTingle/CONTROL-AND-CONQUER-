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

export const CUSTOM_ID_PREFIX = 'custom:';

/** Save-format version, stored alongside the def. Bump on a breaking change. */
export const DRAFT_SCHEMA_VERSION = 1;

/** `My Tank Mk II` -> `custom:my-tank-mk-ii`. */
export function customIdFor(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return CUSTOM_ID_PREFIX + slug;
}

export const isCustomId = (id) => typeof id === 'string' && id.startsWith(CUSTOM_ID_PREFIX);

/**
 * A minimal but complete vehicle — deliberately the scout's rough shape rather
 * than zeroes, so the preview shows something drivable-looking on first open
 * and every slider starts somewhere sensible.
 */
export function blankDef(name = 'New Vehicle') {
  return {
    id: customIdFor(name),
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
    shape: { nose: true, turret: true, tank: false, cabinLength: 0.3, cabinX: 0.2 },
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
    },
    colors: { hull: '#4b4f46', cabin: '#292d28', wheel: '#161616', trim: '#8f9a86' },
    previewDistance: 16,
  };
}

/**
 * Deep copy via JSON — sound precisely because defs are pure data, and the
 * round-trip test in tests/vehicle-def.test.mjs is what keeps that true.
 */
export const cloneDef = (def) => JSON.parse(JSON.stringify(def));

/** Copy a built-in (or any) vehicle into an editable custom one. */
export function forkDef(def, name) {
  const copy = cloneDef(def);
  copy.name = name ?? `${def.name} (copy)`;
  copy.id = customIdFor(copy.name);
  return copy;
}

const REQUIRED_DIMS = [
  'hullLength', 'hullWidth', 'hullHeight', 'cabinHeight',
  'wheelRadius', 'wheelWidth',
];
const REQUIRED_COLORS = ['hull', 'cabin', 'wheel', 'trim'];
// The subset buildLights reads without a default — anything here being absent
// is a thrown TypeError at render time, not a cosmetic problem.
const REQUIRED_LIGHTS = ['headlampInset', 'headlampDrop', 'beamColor', 'tailColor', 'reverseColor'];

const isPositive = (v) => Number.isFinite(v) && v > 0;

/**
 * @returns {string[]} human-readable problems; empty means the def is safe to
 *   hand to `buildVehicleMesh` and to save.
 */
export function validateDef(def, { catalog = VEHICLE_CATALOG } = {}) {
  const problems = [];
  if (!def || typeof def !== 'object') return ['Not a vehicle definition.'];

  if (!def.id || typeof def.id !== 'string') problems.push('Needs an id.');
  else if (!isCustomId(def.id)) problems.push(`Custom vehicle ids must start with "${CUSTOM_ID_PREFIX}".`);
  else if (def.id === CUSTOM_ID_PREFIX) problems.push('Name produces an empty id.');
  else if (catalog.some((d) => d.id === def.id)) problems.push(`Id "${def.id}" is already taken.`);

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

  for (const key of ['speed', 'reverseSpeed', 'acceleration', 'braking', 'maxHealth', 'sightRadius']) {
    if (!isPositive(def[key])) problems.push(`${key} must be a positive number.`);
  }
  if (!Number.isFinite(def.maxClimbGrade) || def.maxClimbGrade <= 0) {
    problems.push('maxClimbGrade must be a positive number.');
  }

  return problems;
}
