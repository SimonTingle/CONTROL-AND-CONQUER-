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
    speed: 22, // top speed, world units / second on the flat
    reverseSpeed: 9,
    acceleration: 16, // units/s² under power
    braking: 34, // units/s² on the brakes
    rollingResistance: 7, // units/s² coasting with no input
    turnSpeed: 3.2, // radians / second at full steering authority
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
];
