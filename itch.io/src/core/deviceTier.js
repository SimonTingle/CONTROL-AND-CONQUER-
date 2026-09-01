/**
 * What this machine can actually do, asked once at startup.
 *
 * This exists because of a bug that was not a performance bug at all. On an
 * iPad Air 2 the island simply did not appear and vehicles deployed hovering
 * over open water. The cause: `heightmap.js` uploaded the heightfield as an
 * R32F float texture with LINEAR filtering, and `R32F` is only linear-filterable
 * with `OES_texture_float_linear`. Without that extension the texture is
 * *incomplete* and every sample returns 0 — so the vertex shader displaced the
 * terrain to y = 0, under the water plane, while the CPU's `heightAt()` kept
 * returning the real heights (48.5 at the island centre) and went on placing
 * units on ground nothing was drawing. three.js does not rescue this: it logs
 * "Unable to use linear filtering with floating point textures" and sets the
 * LINEAR filter anyway.
 *
 * Two lessons are baked in here:
 *
 * 1. **Ask the GL context, never the user-agent string.** The question that
 *    mattered was "is this format filterable", which UA sniffing cannot answer
 *    and a capability query answers exactly. Everything below is a real
 *    capability or a real machine statistic.
 *
 * 2. **A device that is old enough to fail that query is old enough to want
 *    low settings from the first frame.** Before this, the only startup signal
 *    was `IS_MOBILE` (a `(pointer: coarse)` media query), so a 2014 iPad and an
 *    M4 iPad Pro started identically and the old one was dragged down only
 *    afterwards, by `autoQuality`, over several seconds of bad frames.
 *
 * The tier sets *initial* values only. `autoQuality` still owns adaptation from
 * there — this is a starting point, not a ceiling — and neither this module nor
 * its caller ever touches `renderQuality.userForced` or
 * `shadowQuality.userForced`, since the tier is applied before the player can
 * have made any choice to override.
 *
 * The probe runs once, on a throwaway canvas, because the renderer needs
 * `antialias` at construction time and so cannot be the thing we ask.
 */

import { IS_MOBILE } from './platform.js';

/** Below this, treat the GPU as old regardless of what else it reports. */
const MIN_TEXTURE_SIZE = 4096;
/** `navigator.deviceMemory` in GB. Absent in Safari — never required, only used when present. */
const LOW_MEMORY_GB = 2;
const MEDIUM_MEMORY_GB = 4;
const LOW_CORES = 2;
const MEDIUM_CORES = 4;

/**
 * Capabilities in the shape `classify` consumes. Kept separate from the probe so
 * the classification is a pure function of plain data and can be unit-tested
 * without a GL context.
 */
export function defaultCapabilities() {
  return {
    webgl2: true,
    floatLinear: true,
    halfFloatLinear: true,
    maxTextureSize: 16384,
    maxVertexTextureUnits: 16,
    deviceMemory: null,
    hardwareConcurrency: null,
    isMobile: false,
  };
}

/**
 * Read capabilities from a GL context. Pass one in for tests; omitted, a
 * throwaway canvas is used and discarded.
 *
 * Returns `defaultCapabilities()` if there is no WebGL at all — this module must
 * never be the reason the game fails to start, and a machine with no context is
 * about to fail far more loudly on its own.
 */
export function probeCapabilities(gl = null, nav = typeof navigator === 'object' ? navigator : {}) {
  let ctx = gl;
  if (!ctx && typeof document === 'object') {
    const canvas = document.createElement('canvas');
    ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
  }
  const caps = defaultCapabilities();
  caps.deviceMemory = Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null;
  caps.hardwareConcurrency = Number.isFinite(nav.hardwareConcurrency)
    ? nav.hardwareConcurrency
    : null;
  caps.isMobile = IS_MOBILE;
  if (!ctx) return caps;

  const has = (name) => !!ctx.getExtension(name);
  // WebGL2RenderingContext is not defined in every environment this may run in,
  // so detect by a WebGL2-only constant rather than by instanceof.
  caps.webgl2 = typeof ctx.texStorage2D === 'function';
  caps.floatLinear = has('OES_texture_float_linear');
  // R16F is linear-filterable in WebGL2 core; on WebGL1 it needs the extension.
  caps.halfFloatLinear = caps.webgl2 || has('OES_texture_half_float_linear');
  caps.maxTextureSize = ctx.getParameter(ctx.MAX_TEXTURE_SIZE) || 0;
  caps.maxVertexTextureUnits = ctx.getParameter(ctx.MAX_VERTEX_TEXTURE_IMAGE_UNITS) || 0;
  return caps;
}

/**
 * Capabilities → `'low' | 'medium' | 'high'`. Pure.
 *
 * `floatLinear` is treated as decisive on its own. It is not that float
 * filtering is something we still need — Part 1 of this fix moved the heightmap
 * to half-float precisely so we do not — but that a GPU missing it is, without
 * exception, a decade-old part. It is the one signal available on every browser
 * including Safari, where `deviceMemory` is not implemented at all.
 */
export function classify(caps) {
  const c = { ...defaultCapabilities(), ...caps };
  const mem = c.deviceMemory;
  const cores = c.hardwareConcurrency;

  if (
    !c.floatLinear ||
    !c.webgl2 ||
    c.maxVertexTextureUnits < 1 ||
    c.maxTextureSize < MIN_TEXTURE_SIZE ||
    (mem !== null && mem <= LOW_MEMORY_GB) ||
    (cores !== null && cores <= LOW_CORES)
  ) {
    return 'low';
  }
  if (
    c.isMobile ||
    (mem !== null && mem <= MEDIUM_MEMORY_GB) ||
    (cores !== null && cores <= MEDIUM_CORES)
  ) {
    return 'medium';
  }
  return 'high';
}

/**
 * The startup render settings a tier wants.
 *
 * `medium` deliberately keeps a mobile device at pixel ratio 1 — that was the
 * pre-existing `IS_MOBILE` behaviour and it was measured, so introducing tiers
 * must not quietly raise it. Only a non-mobile medium (an older desktop) gets
 * the 1.5 middle step, which did not exist before.
 */
export function tierSettings(tier, caps = defaultCapabilities()) {
  switch (tier) {
    case 'low':
      return { pixelRatioCap: 1, antialias: false, shadowHigh: false };
    case 'medium':
      return { pixelRatioCap: caps.isMobile ? 1 : 1.5, antialias: false, shadowHigh: true };
    default:
      return { pixelRatioCap: 2, antialias: true, shadowHigh: true };
  }
}

/**
 * Whether the heightmap's half-float texture may use LINEAR filtering. Defaults
 * to true before any probe has run, which is both the truth on every WebGL2
 * context and the right default for a unit test with no GL at all.
 */
let halfFloatLinear = true;
export function heightmapLinearFilterSupported() {
  return halfFloatLinear;
}

let detected = null;

/**
 * Probe once and cache. Safe to call again; the second call returns the first
 * result rather than creating another context.
 */
export function initDeviceTier(gl = null, nav = typeof navigator === 'object' ? navigator : {}) {
  if (detected) return detected;
  const caps = probeCapabilities(gl, nav);
  const tier = classify(caps);
  halfFloatLinear = caps.halfFloatLinear;
  detected = { tier, caps, settings: tierSettings(tier, caps) };
  return detected;
}

/** The cached result, or null if `initDeviceTier` has not run. */
export function deviceTier() {
  return detected;
}

/** Tests only — forget the probe so the next `initDeviceTier` runs again. */
export function resetDeviceTier() {
  detected = null;
  halfFloatLinear = true;
}
