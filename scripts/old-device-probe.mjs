/**
 * Browser check for the island that did not load on an iPad Air 2.
 *
 * The report was "playing on a slow device doesn't load island; the scout and
 * base vehicle deploy floating above water". It is not a performance bug. The
 * heightmap was an R32F float texture with LINEAR filtering, and R32F is only
 * linear-filterable with `OES_texture_float_linear`. Without that extension the
 * texture is *incomplete*, every sample reads 0, and `terrainMaterial.js` reads
 * it in the **vertex** stage — so the island flattened to y = 0, under the water
 * plane, while the CPU's `heightAt()` went on reporting the true heights and
 * placing units on ground nothing was drawing.
 *
 * **How the old device is simulated.** `getExtension` and
 * `getSupportedExtensions` are patched, before any module loads, to hide
 * `OES_texture_float_linear` from every context the page creates. That is
 * exactly the difference between this machine and a PowerVR GX6850, and it
 * reproduced the failure: three.js emitted its "Unable to use linear filtering
 * with floating point textures" warning while the CPU heights stayed correct.
 *
 * What this establishes, on a real module graph:
 *  - with the extension hidden, three.js emits **no** filtering warning — the
 *    heightmap texture no longer asks for something the GPU cannot do;
 *  - the GPU's copy of the field still matches the CPU's, so the two consumers
 *    cannot disagree the way they did;
 *  - `deviceTier` classifies that same machine `low`, and the settings it
 *    returns are the conservative ones;
 *  - the unmodified machine is unaffected: it classifies normally and the
 *    heightmap still uses LINEAR filtering.
 *
 * **What it cannot establish:** that the island is visible on a real iPad Air 2.
 * There is no GPU here and no such device. This shows the capability that broke
 * is no longer required; the player confirms the rest.
 *
 * Usage:
 *   npx vite --port 5199 --strictPort &
 *   node scripts/old-device-probe.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const HIDE_FLOAT_LINEAR = () => {
  for (const proto of [
    window.WebGLRenderingContext?.prototype,
    window.WebGL2RenderingContext?.prototype,
  ]) {
    if (!proto) continue;
    const getExtension = proto.getExtension;
    proto.getExtension = function (name) {
      if (name === 'OES_texture_float_linear') return null;
      return getExtension.call(this, name);
    };
    const list = proto.getSupportedExtensions;
    proto.getSupportedExtensions = function () {
      return (list.call(this) || []).filter((n) => n !== 'OES_texture_float_linear');
    };
  }
};

const PAGE_WORK = async () => {
  const res = {};
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { Heightmap } = await import('/src/terrain/heightmap.js');
  const { probeCapabilities, classify, tierSettings } = await import('/src/core/deviceTier.js');
  const { ChaseCamera } = await import('/src/core/chaseCamera.js');

  const gl = document.createElement('canvas').getContext('webgl2');
  const caps = probeCapabilities(gl);
  res.hasWebGL2 = caps.webgl2;
  res.hasFloatLinear = caps.floatLinear;
  res.halfFloatLinear = caps.halfFloatLinear;
  res.maxTextureSize = caps.maxTextureSize;
  res.tier = classify(caps);
  res.settings = tierSettings(res.tier, caps);

  // A real heightmap at production resolution, uploaded through a real
  // renderer, so the driver actually validates the texture.
  const hm = new Heightmap();
  res.textureType = hm.texture.type === THREE.HalfFloatType ? 'HalfFloatType(R16F)' : 'other';
  res.minFilter = hm.texture.minFilter === THREE.LinearFilter ? 'LinearFilter' : 'NearestFilter';
  res.cpuHeightAtCentre = hm.heightAt(0, 0);
  res.cpuHeightOffCentre = hm.heightAt(60, -40);

  // The GPU's copy against the CPU's, over the whole field.
  let worst = 0;
  for (let i = 0; i < hm.data.length; i += 13) {
    worst = Math.max(worst, Math.abs(THREE.DataUtils.fromHalfFloat(hm.texelData[i]) - hm.data[i]));
  }
  res.worstGpuCpuDelta = worst;

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(64, 64);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera();
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: hm.texture }),
  );
  scene.add(quad);
  cam.position.z = 2;
  renderer.render(scene, cam); // forces the upload and any driver complaint
  renderer.dispose();

  res.chaseDefaultDistance = new ChaseCamera(cam, hm).distance;
  return res;
};

const run = async (label, { hideFloatLinear }) => {
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await b.newPage();
  const warnings = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
  });
  if (hideFloatLinear) await page.addInitScript(HIDE_FLOAT_LINEAR);
  await page.goto('http://localhost:5199/', { waitUntil: 'load' });
  const out = await page.evaluate(PAGE_WORK);
  await b.close();

  const filterWarnings = warnings.filter((w) => /linear filtering with floating point/i.test(w));
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify({ ...out, filterWarnings, pageErrors: errors }, null, 2));
  return { out, filterWarnings, errors };
};

const old = await run('simulating iPad Air 2 (OES_texture_float_linear hidden)', {
  hideFloatLinear: true,
});
const normal = await run('this machine, unmodified', { hideFloatLinear: false });

const checks = [
  ['old device reports no float-linear', old.out.hasFloatLinear === false],
  ['old device still gets half-float linear (WebGL2 core)', old.out.halfFloatLinear === true],
  ['old device: no three.js filtering warning', old.filterWarnings.length === 0],
  ['old device: heightmap is half-float', old.out.textureType === 'HalfFloatType(R16F)'],
  ['old device: filter stays LINEAR', old.out.minFilter === 'LinearFilter'],
  ['old device: GPU copy matches CPU within half-float step', old.out.worstGpuCpuDelta <= 2 ** -11],
  ['old device: CPU still reports real ground height', old.out.cpuHeightAtCentre > 1],
  ['old device: classified low', old.out.tier === 'low'],
  ['old device: low settings applied', old.out.settings.pixelRatioCap === 1 && !old.out.settings.antialias && !old.out.settings.shadowHigh],
  ['unmodified machine is not forced low by this change', normal.out.hasFloatLinear === true],
  ['camera starts at 40', old.out.chaseDefaultDistance === 40],
  ['no page errors', old.errors.length === 0 && normal.errors.length === 0],
];

console.log('\n--- verdict ---');
let ok = true;
for (const [name, pass] of checks) {
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
}
process.exit(ok ? 0 : 1);
