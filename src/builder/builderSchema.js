/**
 * Every editable parameter, as data.
 *
 * Same idea as src/ui/controlSchema.js — a declarative list the renderer turns
 * into widgets — but addressing fields by dotted path rather than closures,
 * because here the object being edited is swapped wholesale every time the
 * author picks a different vehicle from the left column. Closures captured
 * over one def would keep writing to the old one.
 *
 * Ranges are chosen to stay inside what vehicleFactory.js and the sim actually
 * cope with: no zero or negative dimension, and no wheel so large it swallows
 * the hull.
 */

/** Read `a.b.c` off an object, undefined if any step is missing. */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Write `a.b.c`, creating intermediate objects as needed. */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let target = obj;
  for (const k of keys) {
    if (target[k] == null || typeof target[k] !== 'object') target[k] = {};
    target = target[k];
  }
  target[last] = value;
}

const num = (path, label, min, max, step) => ({ type: 'slider', path, label, min, max, step });
const bool = (path, label) => ({ type: 'toggle', path, label });
const col = (path, label) => ({ type: 'color', path, label });

/**
 * @returns {{title: string, controls: object[]}[]}
 */
export const BUILDER_GROUPS = [
  {
    title: 'Identity',
    controls: [
      { type: 'text', path: 'name', label: 'Name' },
      { type: 'text', path: 'description', label: 'Description' },
    ],
  },
  {
    title: 'Chassis',
    controls: [
      num('dims.hullLength', 'Hull length', 3, 20, 0.1),
      num('dims.hullWidth', 'Hull width', 1.5, 8, 0.1),
      num('dims.hullHeight', 'Hull height', 0.4, 4, 0.05),
      num('dims.cabinHeight', 'Cabin height', 0.2, 3, 0.05),
      bool('shape.nose', 'Nose'),
      bool('shape.tank', 'Tank body'),
      num('shape.cabinLength', 'Cabin length', 0.1, 0.9, 0.01),
      num('shape.cabinX', 'Cabin position', -0.5, 0.5, 0.01),
    ],
  },
  {
    title: 'Wheels',
    controls: [
      // Two is the floor: axleOffsets() spreads extra axles with
      // `2 * axleX * i / (count - 1)`, which is a divide-by-zero at one axle.
      num('axles', 'Axles', 2, 6, 1),
      num('dims.wheelRadius', 'Wheel radius', 0.3, 2, 0.05),
      num('dims.wheelWidth', 'Wheel width', 0.2, 1.5, 0.05),
      num('dims.suspensionTravel', 'Suspension travel', 0.1, 3, 0.05),
    ],
  },
  {
    title: 'Turret',
    controls: [
      bool('shape.turret', 'Has turret'),
      num('dims.turretRadius', 'Turret radius', 0.3, 3, 0.05),
      num('dims.turretHeight', 'Turret height', 0.2, 2, 0.05),
      num('dims.barrelRadius', 'Barrel radius', 0.05, 0.6, 0.01),
      num('dims.barrelLength', 'Barrel length', 0.5, 8, 0.1),
      num('turret.range', 'Range', 10, 200, 1),
      num('turret.damage', 'Damage', 1, 100, 1),
      num('turret.fireInterval', 'Fire interval', 0.2, 6, 0.1),
      num('turret.muzzleHeight', 'Muzzle height', 0.5, 5, 0.1),
      num('turret.rotationRate', 'Slew rate', 0.2, 6, 0.1),
      num('turret.armedSpeedFactor', 'Armed speed factor', 0.1, 1, 0.05),
      num('turret.armedSteerFactor', 'Armed steer factor', 0.1, 1, 0.05),
    ],
  },
  {
    title: 'Performance',
    controls: [
      num('speed', 'Top speed', 2, 60, 0.5),
      num('reverseSpeed', 'Reverse speed', 1, 30, 0.5),
      num('acceleration', 'Acceleration', 1, 40, 0.5),
      num('braking', 'Braking', 2, 60, 0.5),
      num('rollingResistance', 'Rolling resistance', 0.5, 20, 0.5),
      num('maxSteerAngle', 'Steering lock', 0.1, 1.2, 0.01),
      num('steerRate', 'Steer rate', 0.2, 5, 0.1),
      num('maxClimbGrade', 'Max climb grade', 0.1, 1.2, 0.01),
    ],
  },
  {
    title: 'Stats',
    controls: [
      num('maxHealth', 'Max health', 20, 2000, 10),
      num('cost', 'Cost', 0, 5000, 25),
      num('sightRadius', 'Sight radius', 10, 150, 1),
      num('weight', 'Weight (t)', 0.2, 60, 0.1),
      bool('spawnable', 'In sandbox drawer'),
    ],
  },
  {
    title: 'Lights',
    controls: [
      { type: 'select', path: 'lights.style', label: 'Style', options: ['lamps', 'bar'] },
      num('lights.headlampInset', 'Lamp inset', 0, 1, 0.01),
      num('lights.headlampDrop', 'Lamp drop', 0, 1, 0.01),
      num('lights.beamAngle', 'Beam angle', 0.1, 1.2, 0.01),
      num('lights.beamDistance', 'Beam distance', 20, 300, 5),
      num('lights.beamIntensity', 'Beam intensity', 0, 2000, 10),
      col('lights.beamColor', 'Beam colour'),
      col('lights.tailColor', 'Tail colour'),
      col('lights.reverseColor', 'Reverse colour'),
    ],
  },
  {
    title: 'Colours',
    controls: [
      col('colors.hull', 'Hull'),
      col('colors.cabin', 'Cabin'),
      col('colors.wheel', 'Wheels'),
      col('colors.trim', 'Trim'),
    ],
  },
];

/**
 * Keep the axle arrays consistent with the axle count.
 *
 * `axleFractions` is what axleOffsets() actually reads, so changing the axle
 * slider has to rewrite it or the count silently does nothing. Positions are
 * spread evenly between the outer axles — the same layout axleOffsets() would
 * compute itself — and steering defaults to front-axle-only, matching
 * axleSteerRatios()'s own fallback.
 */
export function resyncAxles(def) {
  const count = Math.max(2, Math.round(def.axles ?? 2));
  def.axles = count;

  const fractions = [];
  for (let i = 0; i < count; i++) fractions.push(1 - (2 * i) / (count - 1));
  def.axleFractions = fractions;

  const ratios = new Array(count).fill(0);
  ratios[0] = 1;
  def.steerRatios = ratios;
}
