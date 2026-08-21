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
    title: 'Running gear',
    controls: [
      // Tracks replace the steered wheels entirely: the belt's road wheels
      // become the suspension contacts and the vehicle pivots instead of
      // steering, so `Axles` below only positions the belt's end arcs.
      bool('shape.tracked', 'Tracks'),
      // Two is the floor: axleOffsets() spreads extra axles with
      // `2 * axleX * i / (count - 1)`, which is a divide-by-zero at one axle.
      num('axles', 'Axles', 2, 6, 1),
      num('dims.wheelRadius', 'Wheel radius', 0.3, 2, 0.05),
      num('dims.wheelWidth', 'Wheel width', 0.2, 1.5, 0.05),
      num('dims.suspensionTravel', 'Suspension travel', 0.1, 3, 0.05),
      num('dims.roadWheels', 'Road wheels (tracked)', 2, 10, 1),
      num('dims.trackWidth', 'Track width (tracked)', 0.3, 3, 0.05),
      num('dims.trackThickness', 'Track thickness (tracked)', 0.05, 0.8, 0.01),
      num('pivotRate', 'Pivot rate (tracked)', 0.2, 3, 0.05),
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
    title: 'Production',
    controls: [
      // `producedBy` had no reader at all until custom vehicles needed one:
      // built-in units are listed by their factory in `structures.js`, which a
      // player cannot edit. See producedUnitIds() in vehicles/commands.js.
      {
        type: 'select',
        path: 'producedBy',
        label: 'Built at',
        options: [
          { value: '', label: 'Not buildable' },
          { value: 'armed-factory', label: 'Armed Factory' },
          { value: 'harvester-facility', label: 'Harvester Facility' },
        ],
      },
      {
        type: 'select',
        path: 'unlock',
        label: 'Availability',
        options: [
          { value: '', label: 'From the start' },
          { value: 'exploration', label: 'After exploring' },
        ],
      },
      // `tags` — not the factory — is what aiCommander selects on: it asks for
      // an 'economy' unit, then a 'combat' one. A vehicle built at the
      // harvester facility but tagged 'combat' would never be bought by an AI
      // as part of its economy. Written as tags[0] so the array shape the rest
      // of the game reads stays intact.
      {
        type: 'select',
        path: 'tags.0',
        label: 'Role (AI picks by this)',
        options: [
          { value: 'combat', label: 'Combat' },
          { value: 'economy', label: 'Economy' },
          { value: 'recon', label: 'Recon' },
        ],
      },
      // The build price, charged at the factory. Also what the AI weighs when
      // it decides whether it can afford one.
      num('cost', 'Price (cr)', 0, 5000, 25),
      bool('spawnable', 'In sandbox drawer'),
    ],
  },
  {
    title: 'Stats',
    controls: [
      num('maxHealth', 'Max health', 20, 2000, 10),
      num('sightRadius', 'Sight radius', 10, 150, 1),
      num('weight', 'Weight (t)', 0.2, 60, 0.1),
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
 * Every slider's range, as `{ 'dotted.path': { min, max } }`.
 *
 * The ranges above were always the real limits of what `vehicleFactory.js` and
 * the sim cope with — but until now they were *only* HTML attributes on a
 * widget, so nothing enforced them. `validateDef` had no upper bound on
 * anything: a def with `speed: 1e6` or `turret.damage: 1e9` validated cleanly
 * and would have been perfectly playable, which stops being merely odd once a
 * vehicle can arrive from another player.
 *
 * Derived rather than restated so there is exactly one place a range is
 * written down. Adding a slider makes it binding automatically; changing one
 * changes both the widget and the check together.
 */
export function deriveBounds(groups = BUILDER_GROUPS) {
  const bounds = {};
  for (const group of groups) {
    for (const control of group.controls) {
      if (control.type !== 'slider') continue;
      bounds[control.path] = { min: control.min, max: control.max };
    }
  }
  return bounds;
}

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

  def.steerRatios = defaultSteerRatios(def, count);
}

/**
 * A track has no steered axle at all — it turns by running its two belts at
 * different speeds. Leaving a front-axle steer ratio on a tracked def would be
 * a lie about the vehicle: `steeringWheelbase` would report a finite wheelbase
 * for running gear that has none, and anything reading it would describe a
 * tank as if it steered like a lorry.
 */
function defaultSteerRatios(def, count) {
  const ratios = new Array(count).fill(0);
  if (!def.shape?.tracked) ratios[0] = 1; // front axle only, as on a real 8x8
  return ratios;
}

/** Re-derive the steering arrays after the tracked flag is switched. */
export function resyncTracked(def) {
  const count = def.axleFractions?.length ?? def.axles ?? 2;
  def.steerRatios = defaultSteerRatios(def, count);
}
