/**
 * Vehicle catalog — pure data. Adding a second vehicle is a new entry here,
 * not new plumbing: vehicleFactory.js reads dims/colors, vehiclePicker.js
 * renders one preview per entry automatically.
 */
export const VEHICLE_CATALOG = [
  {
    id: 'scout-buggy',
    name: 'Scout Buggy',
    description: 'Fast, light recon vehicle.',
    role: 'unit',
    // What an AI commander reads to decide what a unit is *for*, generically —
    // see aiCommander.js. Not read by anything else yet.
    tags: ['recon', 'combat'],
    // Always available — it is the vehicle that does the unlocking.
    unlock: null,
    maxHealth: 100,
    // Gun. The range/arc/slew numbers drive the scan sweep today and are the
    // same ones target acquisition will read once there is anything to shoot.
    turret: {
      range: 60, // world units it could engage within
      fireArc: Math.PI * 1.5, // radians of traverse, centred on vehicle-forward
      sweepRate: 1.4, // radians/second of the idle scan phase
      rotationRate: 2.5, // radians/second slew when tracking
      // Armed is a real trade, not a formality: a third of the speed and a
      // much lazier steer, so arming somewhere is a commitment.
      armedSpeedFactor: 0.35,
      armedSteerFactor: 0.4,
    },
    // World units of fog it clears. Tuned against the island's actual land area:
    // at 22 u/s a straight run sweeps ~2r per unit travelled, so 55 puts Easy
    // (15%) a bit under a minute of driving away rather than fifteen seconds.
    sightRadius: 55,
    speed: 22, // top speed, world units / second on the flat
    reverseSpeed: 9,
    acceleration: 16, // units/s² under power
    braking: 34, // units/s² on the brakes
    rollingResistance: 7, // units/s² coasting with no input
    // Steering is geometric, not a flat yaw rate: the turning circle falls out
    // of wheelbase and lock angle, so a long truck and a short buggy corner
    // differently without either being hand-tuned.
    maxSteerAngle: 0.62, // radians at full lock (~36°)
    steerRate: 3.0, // radians/second the front wheels swing toward lock
    // Steepest grade (rise/run) it can climb. 0.8 ≈ 39°; anything steeper is
    // impassable and the vehicle abandons the order rather than grinding.
    maxClimbGrade: 0.8,
    lights: {
      // Lamp placement is expressed as fractions of the hull so a differently
      // proportioned vehicle gets a rig that still fits it.
      headlampInset: 0.34, // lateral, as a fraction of hull width
      headlampDrop: 0.15, // vertical, fraction of hull height below its top
      beamAngle: 0.42, // radians, half-cone
      beamDistance: 170,
      beamIntensity: 900, // physical units — r169 lights are candela-like
      beamColor: '#fff2d6',
      tailColor: '#ff2b18',
      // Faint red wash on the ground behind — a glow, not a beam, so it is
      // much weaker and much shorter-range than anything else on the vehicle.
      tailBeamIntensity: 130,
      tailBeamDistance: 22,
      tailBeamAngle: 0.85,
      reverseColor: '#f4f8ff',
      // Reversing lamps throw a shorter, wider pool than the headlights —
      // enough to see what you are backing into, not a driving beam.
      reverseBeamIntensity: 320,
      reverseBeamDistance: 70,
      reverseBeamAngle: 0.62,
      // Sun elevation (degrees) at or below which the lamps come on, so they
      // cover dusk, night and dawn.
      duskElevation: 8,
    },
    dims: {
      hullLength: 5.2,
      hullWidth: 2.6,
      hullHeight: 1.3,
      cabinHeight: 0.9,
      wheelRadius: 0.75,
      wheelWidth: 0.55,
      turretRadius: 0.55,
      turretHeight: 0.6,
      barrelRadius: 0.12,
      barrelLength: 1.8,
    },
    colors: {
      hull: '#5a6b4d',
      cabin: '#33402c',
      wheel: '#1c1c1c',
      trim: '#8a8f78',
    },
    previewDistance: 9,
  },

  {
    id: 'base-station',
    name: 'Base Station',
    description: 'Eight-wheeled mobile base. Slow, heavy, hard to turn.',
    role: 'unit', // becomes a structure by deploying; the pad and its buildings are structures
    tags: ['command'],
    // Earned by exploring the island with the scout, not available from the
    // start — see the difficulty thresholds in ui/difficultyScreen.js.
    unlock: 'exploration',
    maxHealth: 400,
    // Deployment flattens a construction pad. The radius is sized from what has
    // to fit on it: this hull is 15.6 long, and 40 leaves room for it plus four
    // to six building footprints with lanes between them.
    deploy: {
      padRadius: 40, // fully flat inner disc
      padBlend: 18, // annulus easing back to untouched terrain
      duration: 5, // seconds the flatten takes
      // Greatest height difference across the pad, in world units, that the
      // site may have. 25 refuses the roughly 16% of land where the earthwork
      // would be dramatic, without ruling out ordinary rolling ground (whose
      // spread runs ~15 on this terrain).
      maxRelief: 25,
    },
    sightRadius: 30, // it is a base, not a scout
    speed: 9,
    reverseSpeed: 4,
    acceleration: 3.5, // laden: it takes its time getting there
    braking: 9,
    rollingResistance: 2.6, // and a long time stopping
    maxSteerAngle: 0.35, // ~20° — a heavy 8x8 does not have buggy lock
    steerRate: 1.1,
    maxClimbGrade: 0.5, // less than the scout: weight, not traction
    // Four axles: a steering pair up front and a close-coupled rear bogie, the
    // real 8x8 layout. The second axle takes partial lock, which is what claws
    // back some of the turning circle a four-axle rigid body would otherwise
    // have — see steeringWheelbase() for why more axles resist yaw.
    axles: 4,
    axleFractions: [1.0, 0.52, -0.5, -1.0],
    steerRatios: [1.0, 0.45, 0, 0],
    shape: {
      nose: false,
      turret: false,
      tank: true,
      tankLength: 0.6,
      tankX: -0.16,
      cabinLength: 0.17, // short cab, right at the front
      cabinX: 0.38,
    },
    lights: {
      // A full-width bar at each end rather than four discrete lamps.
      style: 'bar',
      headlampInset: 0.3,
      headlampDrop: 0.28,
      beamAngle: 0.5,
      beamDistance: 150,
      beamIntensity: 1100,
      beamColor: '#f6fbff',
      tailColor: '#ff2b18',
      // Wider and a touch stronger than the scout's: it is a wider vehicle.
      tailBeamIntensity: 190,
      tailBeamDistance: 30,
      tailBeamAngle: 0.95,
      reverseColor: '#f4f8ff',
      reverseBeamIntensity: 420,
      reverseBeamDistance: 60,
      reverseBeamAngle: 0.7,
      duskElevation: 8,
    },
    dims: {
      hullLength: 15.6, // three times the scout
      hullWidth: 3.4,
      hullHeight: 1.5,
      cabinHeight: 1.5,
      wheelRadius: 1.1,
      wheelWidth: 0.7,
      // A body this long spans far more terrain curvature than a buggy, and
      // plane-fit residual grows with the square of the span — so the arches
      // need real travel rather than the wheel-radius default.
      suspensionTravel: 1.8,
      turretRadius: 0,
      turretHeight: 0,
      barrelRadius: 0,
      barrelLength: 0,
    },
    colors: {
      hull: '#3d444d',
      cabin: '#222932',
      wheel: '#161616',
      trim: '#9aa6b2',
    },
    previewDistance: 26,
  },

  {
    id: 'crystal-harvester',
    name: 'Crystal Harvester',
    description: 'Autonomous six-wheel hauler. Fills at a bloom field, unloads at the facility.',
    role: 'unit',
    tags: ['economy'],
    // Produced by the facility, never conjured from the drawer — a card that
    // handed one over free would contradict the economy it belongs to. It also
    // keeps the picker's per-card WebGL context count down.
    spawnable: false,
    producedBy: 'harvester-facility',
    cost: 600, // credits; the facility ships the first one free
    unlock: null,
    maxHealth: 220,

    capacity: 240, // stock units carried
    fillRate: 40, // units/second drawn from a field
    unloadRate: 80, // units/second delivered to a facility

    sightRadius: 38,
    speed: 14,
    reverseSpeed: 6,
    acceleration: 7,
    braking: 18,
    rollingResistance: 4,
    maxSteerAngle: 0.45,
    steerRate: 1.8,
    // Between the buggy's 0.8 and the base's 0.5: it has to reach fields on
    // rolling ground without being able to go everywhere the scout can.
    maxClimbGrade: 0.62,

    axles: 3,
    axleFractions: [1.0, -0.35, -1.0],
    steerRatios: [1.0, 0.3, 0],
    shape: {
      nose: false,
      turret: false,
      tank: true,
      tankLength: 0.5,
      tankX: -0.18,
      cabinLength: 0.22,
      cabinX: 0.34,
    },
    // Discrete cells rather than a smooth bar, for the same reason the HUD's
    // health bar is dotted: a partial load stays countable at a glance. Being
    // emissive, a laden harvester driving home at night glows with its cargo.
    loadIndicator: { segments: 6, color: '#7ce8ff' },
    lights: {
      style: 'bar',
      headlampInset: 0.3,
      headlampDrop: 0.26,
      beamAngle: 0.48,
      beamDistance: 130,
      beamIntensity: 950,
      beamColor: '#f6fbff',
      tailColor: '#ff2b18',
      reverseColor: '#f4f8ff',
      reverseBeamIntensity: 380,
      reverseBeamDistance: 55,
      reverseBeamAngle: 0.68,
      tailBeamIntensity: 120,
      tailBeamDistance: 24,
      tailBeamAngle: 0.8,
      duskElevation: 8,
    },
    dims: {
      hullLength: 11.4,
      hullWidth: 3.0,
      hullHeight: 1.4,
      cabinHeight: 1.3,
      wheelRadius: 0.95,
      wheelWidth: 0.65,
      suspensionTravel: 1.3,
      turretRadius: 0,
      turretHeight: 0,
      barrelRadius: 0,
      barrelLength: 0,
    },
    colors: { hull: '#4a4335', cabin: '#2a271f', wheel: '#161616', trim: '#c8a24a' },
    previewDistance: 20,
  },
];
