/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with `npm run sync:bounds` from the repo root. The source of
 * truth is BUILDER_GROUPS in src/builder/builderSchema.js;
 * tests/vehicle-bounds-sync.test.mjs fails if this copy drifts from it.
 *
 * Vendored rather than imported because server/Dockerfile copies only
 * server/src into the API image.
 */
export const VEHICLE_BOUNDS = {
  'dims.hullLength': { min: 3, max: 20 },
  'dims.hullWidth': { min: 1.5, max: 8 },
  'dims.hullHeight': { min: 0.4, max: 4 },
  'dims.cabinHeight': { min: 0.2, max: 3 },
  'shape.cabinLength': { min: 0.1, max: 0.9 },
  'shape.cabinX': { min: -0.5, max: 0.5 },
  'axles': { min: 2, max: 6 },
  'dims.wheelRadius': { min: 0.3, max: 2 },
  'dims.wheelWidth': { min: 0.2, max: 1.5 },
  'dims.suspensionTravel': { min: 0.1, max: 3 },
  'dims.roadWheels': { min: 2, max: 10 },
  'dims.trackWidth': { min: 0.3, max: 3 },
  'dims.trackThickness': { min: 0.05, max: 0.8 },
  'pivotRate': { min: 0.2, max: 3 },
  'dims.turretRadius': { min: 0.3, max: 3 },
  'dims.turretHeight': { min: 0.2, max: 2 },
  'dims.barrelRadius': { min: 0.05, max: 0.6 },
  'dims.barrelLength': { min: 0.5, max: 8 },
  'turret.range': { min: 10, max: 200 },
  'turret.damage': { min: 1, max: 100 },
  'turret.fireInterval': { min: 0.2, max: 6 },
  'turret.muzzleHeight': { min: 0.5, max: 5 },
  'turret.rotationRate': { min: 0.2, max: 6 },
  'turret.armedSpeedFactor': { min: 0.1, max: 1 },
  'turret.armedSteerFactor': { min: 0.1, max: 1 },
  'speed': { min: 2, max: 60 },
  'reverseSpeed': { min: 1, max: 30 },
  'acceleration': { min: 1, max: 40 },
  'braking': { min: 2, max: 60 },
  'rollingResistance': { min: 0.5, max: 20 },
  'maxSteerAngle': { min: 0.1, max: 1.2 },
  'steerRate': { min: 0.2, max: 5 },
  'maxClimbGrade': { min: 0.1, max: 1.2 },
  'cost': { min: 0, max: 5000 },
  'maxHealth': { min: 20, max: 2000 },
  'sightRadius': { min: 10, max: 150 },
  'weight': { min: 0.2, max: 60 },
  'lights.headlampInset': { min: 0, max: 1 },
  'lights.headlampDrop': { min: 0, max: 1 },
  'lights.beamAngle': { min: 0.1, max: 1.2 },
  'lights.beamDistance': { min: 20, max: 300 },
  'lights.beamIntensity': { min: 0, max: 2000 },
};
