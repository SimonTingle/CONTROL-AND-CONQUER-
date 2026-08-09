/**
 * The scene's entire supply of vehicle headlights: four SpotLights, shared.
 *
 * Why a pool at all. Vehicles used to build their own lights — 2 driving beams,
 * a brake pool and 1-2 reversing lamps each. Three.js compiles the number of
 * *visible* lights into every material's shader and evaluates all of them per
 * fragment, and it does that whether a light's intensity is 5 or 0. So a
 * 20-vehicle match put 80 spotlights in the scene, all sitting at intensity 0 in
 * daylight, and paid for every one: measured on the deployed build, 705ms of a
 * 710ms frame. Hiding them took the same frame to 4ms.
 *
 * Why the count is fixed rather than adaptive. Changing the number of visible
 * lights forces Three.js to re-link every material in the scene — measured at
 * 764ms. So the obvious fix ("hide distant vehicles' lights") would stall for
 * most of a second every time a vehicle crossed the threshold. These four lights
 * are therefore created once and left `visible = true` forever; only their
 * intensity and their parent change. Four costs ~0.8ms and the cost curve is
 * still flat there — it turns sharply nonlinear by 16.
 *
 * What the player sees. Beams follow the vehicle you are driving. Every other
 * vehicle keeps its emissive lamp lenses (built per-vehicle in vehicleFactory),
 * so the fleet still visibly lights up at night — it just doesn't each cast its
 * own cone onto the ground.
 */

import * as THREE from 'three';

export class HeadlightPool {
  constructor(scene) {
    this.scene = scene;
    this.attachedTo = null;

    // Parked on the scene until a vehicle claims them. Positions are meaningless
    // until then; what matters is that they exist and stay visible from here on.
    const make = (penumbra, decay) => {
      const spot = new THREE.SpotLight(0xffffff, 0, 10, 0.5, penumbra, decay);
      spot.castShadow = false; // beams lighting the ground never needed to also cast
      spot.visible = true; // never toggled — see the header note on re-linking
      const aim = new THREE.Object3D();
      spot.target = aim;
      scene.add(spot, aim);
      return { spot, aim };
    };

    // Two driving beams, one brake pool, one reversing lamp — the rig a single
    // vehicle used to carry, matching the old per-vehicle geometry exactly.
    this.beams = [make(0.55, 1.1), make(0.55, 1.1)];
    this.tail = make(0.9, 1.4);
    this.reverse = make(0.6, 1.1);
    this.all = [...this.beams, this.tail, this.reverse];
  }

  /**
   * Point the rig at a vehicle, or at nothing.
   *
   * Re-parenting does not change the light *count*, so this is free of the
   * re-link cost that gates the whole design — the lights simply ride the new
   * group's transform, exactly as the per-vehicle ones used to.
   */
  attach(instance) {
    if (instance === this.attachedTo) return;
    this.attachedTo = instance;

    const lights = instance?.group?.userData?.lights;
    if (!lights?.mounts) {
      // No vehicle (or one with no lamp rig): park the lights back on the scene
      // and mute them. Still visible, still counted, still costing their fixed
      // ~0.8ms — that constancy is the point.
      for (const { spot, aim } of this.all) {
        this.scene.add(spot, aim);
        spot.intensity = 0;
      }
      return;
    }

    const { group } = instance;
    const cfg = lights.config;
    const { noseX, tailX, lampY, lampZ, reverseZ, bar } = lights.mounts;

    for (const { spot, aim } of this.all) group.add(spot, aim);

    // Driving beams: at the lenses, aimed well ahead and slightly down so the
    // pool lands on the terrain rather than shooting off over the horizon.
    this.beams.forEach(({ spot, aim }, i) => {
      const side = i === 0 ? -1 : 1;
      spot.color.set(cfg.beamColor);
      spot.distance = cfg.beamDistance;
      spot.angle = cfg.beamAngle;
      spot.position.set(noseX, lampY, side * lampZ);
      aim.position.set(
        noseX + cfg.beamDistance * 0.55,
        lampY - cfg.beamDistance * 0.16,
        side * lampZ
      );
    });

    // Brake glow: aimed back and steeply down, so the red lands close behind
    // rather than reaching out like a driving beam.
    this.tail.spot.color.set(cfg.tailColor);
    this.tail.spot.distance = cfg.tailBeamDistance;
    this.tail.spot.angle = cfg.tailBeamAngle;
    this.tail.spot.position.set(tailX, lampY, 0);
    this.tail.aim.position.set(
      tailX - cfg.tailBeamDistance * 0.35,
      lampY - cfg.tailBeamDistance * 0.5,
      0
    );

    // Reversing lamp: centreline on a bar rig, otherwise inboard of the tail
    // lights. One light either way — the old code built two for the non-bar
    // case, but a single centre lamp reads the same against a fixed budget.
    this.reverse.spot.color.set(cfg.reverseColor);
    this.reverse.spot.distance = cfg.reverseBeamDistance;
    this.reverse.spot.angle = cfg.reverseBeamAngle;
    this.reverse.spot.position.set(tailX, lampY, bar ? 0 : -reverseZ);
    this.reverse.aim.position.set(
      tailX - cfg.reverseBeamDistance * 0.5,
      lampY - cfg.reverseBeamDistance * 0.22,
      bar ? 0 : -reverseZ
    );
  }

  /**
   * Per-frame intensities for the attached vehicle. Mirrors the policy the old
   * per-vehicle `updateLights` applied, with the same reasoning behind each:
   * the reversing beam and the tail wash only light up after dark, or they'd
   * wash a coloured patch onto sunlit ground for no visible benefit.
   */
  update(headlightsOn) {
    const inst = this.attachedTo;
    if (!inst || inst.dead) {
      for (const { spot } of this.all) spot.intensity = 0;
      return;
    }

    const cfg = inst.group?.userData?.lights?.config;
    if (!cfg) return;

    for (const { spot } of this.beams) {
      spot.intensity = headlightsOn ? cfg.beamIntensity : 0;
    }

    const tailGlow = headlightsOn ? (inst.braking ? 1 : 0.3) : 0;
    this.tail.spot.intensity = cfg.tailBeamIntensity * tailGlow;

    this.reverse.spot.intensity =
      inst.reversing && headlightsOn ? cfg.reverseBeamIntensity : 0;
  }
}
