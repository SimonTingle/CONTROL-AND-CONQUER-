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
    // Always available — it is the vehicle that does the unlocking.
    unlock: null,
    maxHealth: 100,
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
    // Earned by exploring the island with the scout, not available from the
    // start — see the difficulty thresholds in ui/difficultyScreen.js.
    unlock: 'exploration',
    maxHealth: 400,
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
];
