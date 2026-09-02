/**
 * The scene's entire supply of real vehicle headlights: a small, fixed
 * number of rigs, shared.
 *
 * Why a pool at all. Vehicles used to build their own lights — 2 driving
 * beams, a brake pool and 1-2 reversing lamps each. Three.js compiles the
 * number of *visible* lights into every material's shader and evaluates all
 * of them per fragment, and it does that whether a light's intensity is 5 or
 * 0. So a 20-vehicle match put 80 spotlights in the scene, all sitting at
 * intensity 0 in daylight, and paid for every one: measured on the deployed
 * build, 705ms of a 710ms frame. Hiding them took the same frame to 4ms.
 *
 * Why the count is fixed rather than adaptive. Changing the number of
 * visible lights forces Three.js to re-link every material in the scene —
 * measured at 764ms. So the obvious fix ("hide distant vehicles' lights")
 * would stall for most of a second every time a vehicle crossed the
 * threshold. These rigs are therefore created once and left `visible = true`
 * forever; only their intensity and their parent change.
 *
 * Why RIG_COUNT is 8. Originally this pool held exactly one rig, matching
 * "only the vehicle you personally drive casts real light" — every other
 * player's driven vehicle showed only its static emissive lamp lenses to
 * everyone else, which is exactly what a real-multiplayer report asked to
 * fix: a teammate or opponent's real headlight beam should be visible to
 * other players too, not just to whoever is behind the wheel. 8 rigs (32
 * SpotLights) stays comfortably inside the flat part of the measured cost
 * curve — 4 lights cost ~0.8ms, and the curve "turns sharply nonlinear" only
 * past 16 — while covering "one real-lit vehicle per team" for any match up
 * to 8 teams outright. Matches larger than that (now up to 20 players, see
 * docs/plans/twenty-player-matches.md) fall back to picking the 8 closest
 * candidates to each viewer's own camera each frame (see main.js's
 * candidate-selection code, not this file) — the same graceful "far vehicles
 * keep emissive-only lamps" behavior this pool already had for every vehicle
 * beyond the very first one, just with a wider net.
 *
 * What the player sees. Real beams follow up to RIG_COUNT vehicles at once —
 * their own, plus whichever other currently-piloted, headlights-on vehicles
 * are nearest their camera. Every other vehicle keeps its emissive lamp
 * lenses (built per-vehicle in vehicleFactory), so the fleet still visibly
 * lights up at night — it just doesn't each cast its own cone onto the
 * ground.
 */

import * as THREE from 'three';

/** See the header above for why this number and not some other. */
const RIG_COUNT = 8;

export class HeadlightPool {
  constructor(scene) {
    this.scene = scene;
    /** Index-aligned with `this.rigs` — `attachedTo[i]` is a live instance or `null`. */
    this.attachedTo = new Array(RIG_COUNT).fill(null);

    // Parked on the scene until a vehicle claims them. Positions are
    // meaningless until then; what matters is that they exist and stay
    // visible from here on.
    const makeLight = (penumbra, decay) => {
      const spot = new THREE.SpotLight(0xffffff, 0, 10, 0.5, penumbra, decay);
      spot.castShadow = false; // beams lighting the ground never needed to also cast
      spot.visible = true; // never toggled — see the header note on re-linking
      const aim = new THREE.Object3D();
      spot.target = aim;
      scene.add(spot, aim);
      return { spot, aim };
    };

    // Two driving beams, one brake pool, one reversing lamp per rig — the
    // rig a single vehicle used to carry, matching the old per-vehicle
    // geometry exactly, just multiplied out to RIG_COUNT slots.
    this.rigs = [];
    for (let i = 0; i < RIG_COUNT; i++) {
      const beams = [makeLight(0.55, 1.1), makeLight(0.55, 1.1)];
      const tail = makeLight(0.9, 1.4);
      const reverse = makeLight(0.6, 1.1);
      this.rigs.push({ beams, tail, reverse, all: [...beams, tail, reverse] });
    }

    // Debug flood mode — see setFlood(). Off by default and never persisted.
    this.flood = false;
    this.floodRigs = new Map(); // instance -> [{spot, aim}, {spot, aim}]
  }

  /**
   * **Testing only.** Give every vehicle its own pair of real driving beams.
   *
   * This deliberately recreates the shape of the bug this module exists to
   * fix, because being able to reproduce it on demand is genuinely useful:
   * it shows what per-vehicle lights actually cost on *your* hardware, and
   * it proves the perf HUD's light-count warning fires. It is not a play
   * feature — leaving it on will drag a 60fps match down hard, by design.
   *
   * Two beams per vehicle rather than the historical 4-5, so the number
   * answers the useful question ("could every vehicle afford headlights?")
   * rather than just reproducing the worst case. Expect a stall of a few
   * hundred ms each time this is toggled, and on every spawn/death while it
   * is on: the light count changes, and Three.js re-links every material
   * when it does. That stall is the whole reason the normal path uses a
   * fixed pool.
   */
  setFlood(on) {
    if (on === this.flood) return;
    this.flood = on;
    if (!on) {
      for (const rig of this.floodRigs.values()) this._disposeRig(rig);
      this.floodRigs.clear();
    }
  }

  _makeFloodRig(instance) {
    const { mounts, config } = instance.group.userData.lights;
    const { noseX, lampY, lampZ } = mounts;
    return [-1, 1].map((side) => {
      const spot = new THREE.SpotLight(
        new THREE.Color(config.beamColor), 0, config.beamDistance, config.beamAngle, 0.55, 1.1
      );
      spot.castShadow = false;
      spot.position.set(noseX, lampY, side * lampZ);
      const aim = new THREE.Object3D();
      aim.position.set(
        noseX + config.beamDistance * 0.55,
        lampY - config.beamDistance * 0.16,
        side * lampZ
      );
      spot.target = aim;
      instance.group.add(spot, aim);
      return { spot, aim };
    });
  }

  _disposeRig(rig) {
    // SpotLights own no geometry or material, so removing them from the graph is
    // the whole of the cleanup.
    for (const { spot, aim } of rig) {
      spot.parent?.remove(spot);
      aim.parent?.remove(aim);
    }
  }

  /**
   * Keep flood rigs in step with the live fleet. Cheap no-op when flood is off,
   * and only touches the scene graph when the set of vehicles actually changes —
   * adding or removing a light re-links every material, so doing it per frame
   * would be far worse than the thing being measured.
   */
  syncFlood(instances, headlightsOn) {
    if (!this.flood) return;

    const attached = new Set(this.attachedTo.filter(Boolean));
    const live = new Set();
    for (const inst of instances) {
      // A vehicle already carrying one of the RIG_COUNT real rigs would get a
      // second pair, doubling its light and misreporting the count.
      if (inst.dead || attached.has(inst)) continue;
      const lights = inst.group?.userData?.lights;
      if (!lights?.mounts) continue;

      live.add(inst);
      let rig = this.floodRigs.get(inst);
      if (!rig) {
        rig = this._makeFloodRig(inst);
        this.floodRigs.set(inst, rig);
      }
      for (const { spot } of rig) {
        spot.intensity = headlightsOn ? lights.config.beamIntensity : 0;
      }
    }

    for (const [inst, rig] of this.floodRigs) {
      if (live.has(inst)) continue;
      this._disposeRig(rig); // died, or claimed one of the real rigs
      this.floodRigs.delete(inst);
    }
  }

  /**
   * Point up to RIG_COUNT rigs at `instances` (already sorted by priority —
   * see main.js's candidate selection — and already capped by the caller;
   * anything past `RIG_COUNT` here is silently ignored as a safety net).
   * Extra rigs beyond `instances.length` are parked back on the scene, dark.
   *
   * Re-parenting does not change the light *count*, so this is free of the
   * re-link cost that gates the whole design — the lights simply ride the
   * new group's transform, exactly as the per-vehicle ones used to.
   */
  attach(instances) {
    for (let i = 0; i < RIG_COUNT; i++) {
      const instance = instances[i] ?? null;
      if (instance === this.attachedTo[i]) continue;
      this.attachedTo[i] = instance;
      this._attachRig(this.rigs[i], instance);
    }
  }

  _attachRig(rig, instance) {
    const lights = instance?.group?.userData?.lights;
    if (!lights?.mounts) {
      // No vehicle (or one with no lamp rig): park the lights back on the
      // scene and mute them. Still visible, still counted, still costing
      // their fixed share of the pool's ~0.8ms/rig — that constancy is the
      // point.
      for (const { spot, aim } of rig.all) {
        this.scene.add(spot, aim);
        spot.intensity = 0;
      }
      return;
    }

    const { group } = instance;
    const cfg = lights.config;
    const { noseX, tailX, lampY, lampZ, reverseZ, bar } = lights.mounts;

    for (const { spot, aim } of rig.all) group.add(spot, aim);

    // Driving beams: at the lenses, aimed well ahead and slightly down so the
    // pool lands on the terrain rather than shooting off over the horizon.
    rig.beams.forEach(({ spot, aim }, i) => {
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
    rig.tail.spot.color.set(cfg.tailColor);
    rig.tail.spot.distance = cfg.tailBeamDistance;
    rig.tail.spot.angle = cfg.tailBeamAngle;
    rig.tail.spot.position.set(tailX, lampY, 0);
    rig.tail.aim.position.set(
      tailX - cfg.tailBeamDistance * 0.35,
      lampY - cfg.tailBeamDistance * 0.5,
      0
    );

    // Reversing lamp: centreline on a bar rig, otherwise inboard of the tail
    // lights. One light either way — the old code built two for the non-bar
    // case, but a single centre lamp reads the same against a fixed budget.
    rig.reverse.spot.color.set(cfg.reverseColor);
    rig.reverse.spot.distance = cfg.reverseBeamDistance;
    rig.reverse.spot.angle = cfg.reverseBeamAngle;
    rig.reverse.spot.position.set(tailX, lampY, bar ? 0 : -reverseZ);
    rig.reverse.aim.position.set(
      tailX - cfg.reverseBeamDistance * 0.5,
      lampY - cfg.reverseBeamDistance * 0.22,
      bar ? 0 : -reverseZ
    );
  }

  /**
   * Per-frame intensities for every attached rig. Mirrors the policy the old
   * per-vehicle `updateLights` applied, with the same reasoning behind each:
   * the reversing beam and the tail wash only light up after dark, or they'd
   * wash a coloured patch onto sunlit ground for no visible benefit.
   *
   * Reads each attached instance's *own* `headlightsOn`/`braking`/`reversing`
   * state rather than a single global flag — every vehicle already computes
   * its own `headlightsOn` (vehicleController.js's `updateLights`), so a rig
   * reflects the vehicle it is actually attached to, not whichever vehicle
   * happened to be locally active.
   */
  update() {
    for (let i = 0; i < RIG_COUNT; i++) {
      const rig = this.rigs[i];
      const inst = this.attachedTo[i];
      if (!inst || inst.dead) {
        for (const { spot } of rig.all) spot.intensity = 0;
        continue;
      }

      const cfg = inst.group?.userData?.lights?.config;
      if (!cfg) continue;

      const on = inst.headlightsOn;
      for (const { spot } of rig.beams) {
        spot.intensity = on ? cfg.beamIntensity : 0;
      }

      const tailGlow = on ? (inst.braking ? 1 : 0.3) : 0;
      rig.tail.spot.intensity = cfg.tailBeamIntensity * tailGlow;

      rig.reverse.spot.intensity = inst.reversing && on ? cfg.reverseBeamIntensity : 0;
    }
  }
}
