import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export const DEFAULT_ATMOSPHERE = {
  elevation: 22,      // degrees above the horizon
  azimuth: 135,       // degrees
  turbidity: 4.5,     // haze / particulate load
  rayleigh: 2.2,      // blue scattering — higher is a deeper sky
  mieCoefficient: 0.006,
  mieDirectionalG: 0.82,
  exposure: 0.62,
  fogDensity: 0.0016,
  fogTint: 0.0,       // -1 cool, +1 warm — artistic nudge on the derived colour
  sunIntensity: 2.6,
  ambientIntensity: 0.45,
};

// Sky palette keyed by sun elevation. The fog and lights are sampled from these
// so that dusk actually reddens the whole scene rather than just the skybox.
const NIGHT = new THREE.Color('#0a0f1c');
const DUSK = new THREE.Color('#e8814a');
const DAY_HORIZON = new THREE.Color('#b9cee0');

const SUN_NIGHT = new THREE.Color('#243352');
const SUN_DUSK = new THREE.Color('#ff9b52');
const SUN_DAY = new THREE.Color('#fff4e0');

/**
 * Sky dome, sun, and everything the sun's position implies: light colour and
 * intensity, ambient fill, and fog. Driving all of them from one elevation value
 * is what makes the time-of-day slider feel like weather instead of a toggle.
 */
export class Atmosphere {
  // Sun elevation in degrees at solar noon, when the day/night cycle is running.
  static CYCLE_MAX_ELEVATION = 70;

  constructor(scene, renderer, { mapSize = 1024 } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.params = { ...DEFAULT_ATMOSPHERE };

    this.sky = new Sky();
    this.sky.scale.setScalar(mapSize * 20);
    this.sky.name = 'sky';
    scene.add(this.sky);

    this.sunPosition = new THREE.Vector3();

    this.sunLight = new THREE.DirectionalLight(0xffffff, this.params.sunIntensity);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0008;
    this.sunLight.shadow.normalBias = 0.6;

    const shadowExtent = mapSize * 0.42;
    const cam = this.sunLight.shadow.camera;
    cam.left = -shadowExtent;
    cam.right = shadowExtent;
    cam.top = shadowExtent;
    cam.bottom = -shadowExtent;
    cam.near = 1;
    cam.far = mapSize * 3;
    cam.updateProjectionMatrix();

    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    // Hemisphere fill stands in for bounced skylight — without it, shadowed
    // slopes read as flat black and the terrain loses all its shape.
    this.hemiLight = new THREE.HemisphereLight(0x9fc0e8, 0x4a4034, this.params.ambientIntensity);
    scene.add(this.hemiLight);

    scene.fog = new THREE.FogExp2(0x9fb6cc, this.params.fogDensity);

    this.mapSize = mapSize;

    // A stylized cycle, not real solar geometry: elevation follows a sine wave
    // (0° and rising at sunrise, CYCLE_MAX_ELEVATION at solar noon, 0° and
    // falling at sunset, -CYCLE_MAX_ELEVATION at midnight) and azimuth sweeps
    // a full circle over the same period, so the sun visibly arcs across the
    // sky rather than just dimming in place. periodSeconds is real (wall-clock)
    // time for one full day+night. phase/azimuthOffset are seeded so the very
    // first frame lands close to DEFAULT_ATMOSPHERE's elevation/azimuth rather
    // than jumping — the toggle in the settings drawer starts this enabled.
    const initialRatio = THREE.MathUtils.clamp(
      DEFAULT_ATMOSPHERE.elevation / Atmosphere.CYCLE_MAX_ELEVATION,
      -1,
      1
    );
    const initialPhase = Math.asin(initialRatio) / (Math.PI * 2); // rising branch, in [-0.25, 0.25]
    this.cycle = {
      enabled: true,
      periodSeconds: 1800,
      phase: initialPhase < 0 ? initialPhase + 1 : initialPhase,
      azimuthOffset: (DEFAULT_ATMOSPHERE.azimuth - initialPhase * 360 + 360) % 360,
    };

    this.apply();
  }

  /** Advance the day/night cycle, if enabled. No-op (and cheap) when it's off. */
  update(dt) {
    if (!this.cycle.enabled) return this;
    this.cycle.phase = (this.cycle.phase + dt / this.cycle.periodSeconds) % 1;
    this.params.elevation = Atmosphere.CYCLE_MAX_ELEVATION * Math.sin(this.cycle.phase * Math.PI * 2);
    this.params.azimuth = (this.cycle.azimuthOffset + this.cycle.phase * 360) % 360;
    return this.apply();
  }

  /**
   * Move the cycle to whatever time of day produces this sun elevation.
   *
   * Exists because setting `params.elevation` directly does nothing while the
   * cycle is running — `update()` above recomputes it from `phase` on the very
   * next frame, so the Sun elevation slider used to flicker and snap back. This
   * inverts `elevation = CYCLE_MAX_ELEVATION * sin(2π·phase)` and moves `phase`
   * itself, which is what the slider was always meant to do: scrub time of day.
   *
   * Note the sun only ever reaches ±CYCLE_MAX_ELEVATION (70°), so a slider that
   * ranges higher clamps here. That's the sun's actual arc, not a bug to fix.
   */
  scrubToElevation(elev) {
    const ratio = THREE.MathUtils.clamp(elev / Atmosphere.CYCLE_MAX_ELEVATION, -1, 1);
    const base = Math.asin(ratio) / (Math.PI * 2); // [-0.25, 0.25]
    // asin can't tell morning from afternoon, so keep the half of the day we're
    // already in: dragging the sun down at noon should set into evening, not
    // jump backwards to dawn. Tested off `phase` rather than cos(2π·phase),
    // which is exactly 0 at *both* noon (0.25) and midnight (0.75) and so can't
    // distinguish them — that ambiguity sent a drag down from noon to morning.
    const p = this.cycle.phase;
    const rising = p < 0.25 || p >= 0.75;
    const phase = rising ? base : 0.5 - base;
    this.cycle.phase = ((phase % 1) + 1) % 1;
    // dt 0: recompute elevation/azimuth from the new phase and apply now, so the
    // change is visible on this frame rather than the next.
    return this.update(0);
  }

  /** Push the current params into the sky shader, lights and fog. */
  apply() {
    const p = this.params;
    const u = this.sky.material.uniforms;

    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mieCoefficient;
    u.mieDirectionalG.value = p.mieDirectionalG;

    const phi = THREE.MathUtils.degToRad(90 - p.elevation);
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    this.sunPosition.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunPosition);

    this.renderer.toneMappingExposure = p.exposure;

    // Distance chosen so the shadow camera still covers the map at low sun.
    this.sunLight.position.copy(this.sunPosition).multiplyScalar(this.mapSize * 0.9);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.target.updateMatrixWorld();

    // day = 1 with the sun high, 0 once it is below the horizon.
    const day = THREE.MathUtils.smoothstep(p.elevation, -6, 12);
    // dusk peaks as the sun grazes the horizon.
    const dusk = 1 - Math.min(1, Math.abs(p.elevation - 3) / 14);

    const sunColor = SUN_NIGHT.clone().lerp(SUN_DAY, day).lerp(SUN_DUSK, dusk * 0.75);
    this.sunLight.color.copy(sunColor);
    this.sunLight.intensity = p.sunIntensity * (0.04 + 0.96 * day);

    this.hemiLight.intensity = p.ambientIntensity * (0.25 + 0.75 * day);
    this.hemiLight.color.setHex(0x9fc0e8).lerp(sunColor, dusk * 0.5);

    const fogColor = NIGHT.clone().lerp(DAY_HORIZON, day).lerp(DUSK, dusk * 0.6);
    if (p.fogTint !== 0) {
      const warm = new THREE.Color('#e0a070');
      const cool = new THREE.Color('#7fa8d8');
      fogColor.lerp(p.fogTint > 0 ? warm : cool, Math.abs(p.fogTint) * 0.5);
    }
    // Haze thickens the fog, matching what turbidity does to the sky.
    this.scene.fog.color.copy(fogColor);
    this.scene.fog.density = p.fogDensity * (0.6 + p.turbidity * 0.12);

    this.fogColor = fogColor;
    this.dayFactor = day;
    return this;
  }

  set(partial) {
    Object.assign(this.params, partial);
    return this.apply();
  }
}
