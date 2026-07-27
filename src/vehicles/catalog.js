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
    speed: 22, // world units / second
    turnSpeed: 3.2, // radians / second
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
