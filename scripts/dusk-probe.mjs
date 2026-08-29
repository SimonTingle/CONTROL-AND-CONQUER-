/**
 * Browser check for the dusk/dawn visual fixes.
 *
 * Constructs a **real** `Atmosphere` against a real THREE scene and renderer and
 * sweeps the sun through a full cycle, rather than re-deriving the arithmetic —
 * a check that recomputes the formula itself would keep passing if the
 * production code drifted away from it, which is the one thing it exists to
 * catch. `tests/auto-quality-damping.test.mjs` covers the same ground
 * dependency-free; this covers the parts only a live module graph can.
 *
 * What it establishes:
 *  - the shadow-casting light never reaches or passes the ground plane, across
 *    the whole -70..+70 elevation range;
 *  - the pin is invisible in daylight — above it, the shadow light still tracks
 *    the true sun exactly;
 *  - the *sky's* sun still sets. The pin applies to the shadow direction only,
 *    and a sunset that stopped setting would be a worse bug than the one being
 *    fixed;
 *  - fog moves gradually rather than stepping.
 *
 * **What it cannot establish: the flashing itself.** There is no GPU here, so
 * framerate is pinned far below the unstable band and the controller simply
 * settles low. The oscillation is only demonstrable through the injected-fps
 * closed-loop model in the unit tests.
 *
 * Usage:
 *   npx vite --port 5199 --strictPort &
 *   node scripts/dusk-probe.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await b.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5199/', { waitUntil: 'load' });

const out = await page.evaluate(async () => {
  const res = {};
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { Atmosphere } = await import('/src/sky/atmosphere.js');

  // A real Atmosphere on a real (headless) renderer + scene.
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer();
  const atmo = new Atmosphere(scene, renderer, { mapSize: 1024 });

  // Sweep the true sun through a full cycle and watch the SHADOW light.
  let minY = Infinity, minAt = null;
  const daylightMatches = [];
  for (let e = -70; e <= 70; e += 0.5) {
    atmo.set({ elevation: e });
    const y = atmo.sunLight.position.y;
    if (y < minY) { minY = y; minAt = e; }
    // Above the pin, the shadow light must still track the true sun exactly.
    if (e >= 6) {
      const expected = Math.cos((90 - e) * (Math.PI / 180)) * 1024 * 0.9;
      daylightMatches.push(Math.abs(y - expected) < 1e-6);
    }
  }
  res.minShadowLightY = Number(minY.toFixed(2));
  res.minShadowLightAtElevation = minAt;
  res.shadowLightAlwaysAboveGround = minY > 0;
  res.daylightUnchanged = daylightMatches.every(Boolean);
  res.minShadowElevation = Atmosphere.MIN_SHADOW_ELEVATION;

  // The sky's own sun must still go below the horizon — the pin is for shadows
  // only, and a sunset that stopped setting would be a worse bug.
  atmo.set({ elevation: -30 });
  res.skySunGoesBelowHorizon = atmo.sky.material.uniforms.sunPosition.value.y < 0;
  res.skySunY = Number(atmo.sky.material.uniforms.sunPosition.value.y.toFixed(3));

  // Fog ramp in a live loop.
  const { AutoQuality } = await import('/src/core/autoQuality.js');
  const aq = new AutoQuality();
  const fogSeen = [];
  for (let i = 0; i < 400; i++) {
    const dt = 1 / (aq.low ? 28 : 15);
    aq.record(dt);
    aq.update({
      dt, userForcedPixelRatio: false, setPixelRatio: () => {},
      basePixelRatio: 2, baseFogDensity: 0.0016,
      setFogDensity: (d) => fogSeen.push(d),
    });
  }
  let maxStep = 0;
  for (let i = 1; i < fogSeen.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(fogSeen[i] - fogSeen[i - 1]));
  }
  res.fogUpdates = fogSeen.length;
  res.maxFogStepPerFrame = Number(maxStep.toExponential(2));
  res.instantStepWouldHaveBeen = Number((0.0016 * 2.2 - 0.0016).toExponential(2));
  res.fogRampedNotStepped = maxStep < (0.0016 * 2.2 - 0.0016) / 4;

  renderer.dispose();
  return res;
});

out.pageErrors = errors;
const ok = out.shadowLightAlwaysAboveGround && out.daylightUnchanged
  && out.skySunGoesBelowHorizon && out.fogRampedNotStepped && errors.length === 0;
console.log(JSON.stringify(out, null, 2));
console.log(ok ? 'PASS' : 'FAIL');
await b.close();
process.exit(ok ? 0 : 1);
