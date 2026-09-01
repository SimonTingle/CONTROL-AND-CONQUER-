/**
 * The island that did not load on an iPad Air 2.
 *
 * Two separate things are pinned here, both from the same bug.
 *
 * **The texture format.** The heightmap was an R32F float texture with LINEAR
 * filtering. R32F is only linear-filterable with `OES_texture_float_linear`;
 * without it the texture is incomplete, every sample reads 0, and since
 * `terrainMaterial.js` samples it in the *vertex* stage the terrain flattened to
 * y = 0 — under the water — while the CPU's `heightAt()` kept returning the real
 * heights and placing units on ground nothing was drawing. The assertion is not
 * "the type is HalfFloatType" as a spelling check: it is that the type is one
 * that is filterable **without an extension**, which is the property that was
 * violated.
 *
 * **The tier.** A device old enough to fail that query should start on low
 * settings rather than be dragged there by `autoQuality` over several seconds of
 * bad frames. `classify` is deliberately a pure function of a plain capability
 * object so this runs with no GL context at all.
 *
 * Dependency-free: no browser, no renderer, no network.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Heightmap } from '../src/terrain/heightmap.js';
import { ChaseCamera } from '../src/core/chaseCamera.js';
import {
  classify,
  defaultCapabilities,
  tierSettings,
  probeCapabilities,
} from '../src/core/deviceTier.js';

// --- the texture format ----------------------------------------------------

/**
 * Texture types that WebGL2 can filter with no extension. FloatType is
 * deliberately absent: that is the whole bug.
 */
const FILTERABLE_WITHOUT_EXTENSION = new Set([
  THREE.HalfFloatType,
  THREE.UnsignedByteType,
  THREE.UnsignedShort4444Type,
  THREE.UnsignedShort5551Type,
]);

test('the heightmap texture uses a type that filters without an extension', () => {
  const hm = new Heightmap({ resolution: 65, size: 256 });
  assert.equal(hm.texture.magFilter, THREE.LinearFilter, 'it is filtered linearly');
  assert.ok(
    FILTERABLE_WITHOUT_EXTENSION.has(hm.texture.type),
    'a linearly-filtered heightmap must use a type that is filterable in WebGL2 ' +
      'core — FloatType needs OES_texture_float_linear, which the iPad Air 2 lacks',
  );
});

test('the GPU copy of the heightfield agrees with the CPU copy', () => {
  // The failure was a total CPU/GPU divergence, so the fix must not introduce a
  // small one. Half-float has an 11-bit mantissa, so over the normalised [0,1]
  // field the worst-case step is 2^-11 — about 4cm at amplitude 90, two orders
  // of magnitude under the 2m vertex spacing.
  const hm = new Heightmap({ resolution: 129, size: 512 });
  const tolerance = 2 ** -11;
  let worst = 0;
  for (let i = 0; i < hm.data.length; i += 7) {
    worst = Math.max(worst, Math.abs(THREE.DataUtils.fromHalfFloat(hm.texelData[i]) - hm.data[i]));
  }
  assert.ok(worst <= tolerance, `GPU/CPU heights diverge by ${worst}, over ${tolerance}`);
  assert.ok(worst > 0, 'the mirror should really be quantised, not secretly the same array');
});

test('editing the field in place reaches the texture', () => {
  // terraform.js and craters.js write straight into `data`. They used to just
  // set needsUpdate, which worked only while the texture wrapped that same
  // Float32Array. It no longer does, so a missed syncTexture would upload stale
  // ground — the same class of divergence, reintroduced quietly.
  const hm = new Heightmap({ resolution: 65, size: 256 });
  const n = hm.params.resolution;
  const idx = 20 * n + 20;
  hm.data[idx] = 0.75;
  hm.syncTexture(20, 20, 20, 20);
  assert.ok(Math.abs(THREE.DataUtils.fromHalfFloat(hm.texelData[idx]) - 0.75) < 2 ** -11);
});

// --- the tier --------------------------------------------------------------

const modern = () => defaultCapabilities();
const ipadAir2 = () => ({
  ...defaultCapabilities(),
  // The decisive signal, and the only one available on Safari, where
  // navigator.deviceMemory does not exist.
  floatLinear: false,
  maxTextureSize: 8192,
  isMobile: true,
  deviceMemory: null,
  hardwareConcurrency: 3,
});

test('a GPU without float-linear filtering is classified low', () => {
  assert.equal(classify(ipadAir2()), 'low');
});

test('a modern desktop is classified high', () => {
  assert.equal(classify({ ...modern(), hardwareConcurrency: 10, deviceMemory: 8 }), 'high');
});

test('a modern phone or a thin desktop is classified medium', () => {
  assert.equal(classify({ ...modern(), isMobile: true, hardwareConcurrency: 8 }), 'medium');
  assert.equal(classify({ ...modern(), hardwareConcurrency: 4, deviceMemory: 8 }), 'medium');
});

test('missing deviceMemory never drags a capable machine down', () => {
  // Safari does not implement it. A signal that is simply absent must not read
  // as a signal that is bad.
  assert.equal(classify({ ...modern(), deviceMemory: null, hardwareConcurrency: 12 }), 'high');
});

test('a low tier starts conservatively and a high tier does not', () => {
  const low = tierSettings('low', ipadAir2());
  assert.equal(low.pixelRatioCap, 1);
  assert.equal(low.antialias, false);
  assert.equal(low.shadowHigh, false);

  const high = tierSettings('high', modern());
  assert.equal(high.pixelRatioCap, 2, 'a Retina desktop must still get DPR 2');
  assert.equal(high.antialias, true);
  assert.equal(high.shadowHigh, true);
});

test('a mobile device keeps the pixel ratio 1 it had before tiers existed', () => {
  // The old behaviour was `IS_MOBILE ? 1 : 2` and it was measured. Introducing a
  // middle tier must not quietly raise mobile to 1.5.
  assert.equal(tierSettings('medium', { ...modern(), isMobile: true }).pixelRatioCap, 1);
  assert.equal(tierSettings('medium', { ...modern(), isMobile: false }).pixelRatioCap, 1.5);
});

test('the tier never claims to be a player choice', () => {
  // renderQuality.userForced / shadowQuality.userForced mean "the player set
  // this themselves", after which autoQuality backs off. The tier applies before
  // any choice can exist and must not set them.
  for (const tier of ['low', 'medium', 'high']) {
    const s = tierSettings(tier, modern());
    assert.equal(s.userForced, undefined, `${tier} must not carry a userForced flag`);
  }
});

test('probing a fake GL context reads the real capability, not a guess', () => {
  const gl = {
    MAX_TEXTURE_SIZE: 1,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 2,
    texStorage2D() {},
    getExtension: (name) => (name === 'OES_texture_float_linear' ? null : {}),
    getParameter: (p) => (p === 1 ? 8192 : 16),
  };
  const caps = probeCapabilities(gl, { hardwareConcurrency: 3 });
  assert.equal(caps.floatLinear, false);
  assert.equal(caps.webgl2, true);
  assert.equal(caps.halfFloatLinear, true, 'R16F is filterable in WebGL2 core');
  assert.equal(caps.maxTextureSize, 8192);
  assert.equal(classify(caps), 'low');
});

// --- the camera ------------------------------------------------------------

test('the chase camera starts further out, within the unchanged zoom range', () => {
  const camera = new THREE.PerspectiveCamera();
  const chase = new ChaseCamera(camera, new Heightmap({ resolution: 33, size: 256 }));
  assert.equal(chase.distance, 40);
  chase.zoom(-1000);
  assert.equal(chase.distance, 8, 'minimum zoom is unchanged');
  chase.zoom(1000);
  assert.equal(chase.distance, 160, 'maximum zoom is unchanged');
});
