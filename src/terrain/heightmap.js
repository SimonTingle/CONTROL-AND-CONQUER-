import * as THREE from 'three';
import { SimplexNoise } from './noise.js';
import { heightmapLinearFilterSupported } from '../core/deviceTier.js';

export const DEFAULT_TERRAIN = {
  seed: 20260727,
  size: 1024,       // world units, terrain spans [-size/2, size/2] on X and Z
  resolution: 513,  // heightmap samples per axis (N+1 so segments are a power of two)
  amplitude: 90,    // peak height in world units
  frequency: 1.6,   // base noise frequency across the whole map
  octaves: 7,
  lacunarity: 2.03,
  gain: 0.5,
  ridgeBlend: 0.55, // 0 = rolling hills (fBm), 1 = sharp ridges (ridged multifractal)
  warp: 0.35,       // domain warping strength — breaks up the "noise grid" look
  plateau: 0.0,     // flattens low ground, useful for buildable RTS terrain
  seaLevel: 0.18,   // normalised height of the water plane
};

/**
 * A queryable procedural heightfield.
 *
 * Holds the raw Float32Array so gameplay code can ask "how high is the ground
 * at (x, z)?" without touching the GPU, and exposes the same data as a
 * DataTexture so the vertex shader can displace geometry from the identical
 * source. One field, two consumers — CPU and GPU can never disagree.
 *
 * ## Why the texture is half-float
 *
 * They *did* disagree, totally, on an iPad Air 2: the island never appeared and
 * units deployed hovering over open water. This texture was `FloatType` (R32F)
 * with LINEAR filtering, and R32F is only linear-filterable with
 * `OES_texture_float_linear`. On a GPU without that extension the texture is
 * incomplete, every sample returns 0, and `terrainMaterial.js` — which reads it
 * in the *vertex* stage — flattened the terrain to y = 0, beneath the water
 * plane, while `heightAt()` below went on reporting the true 48.5m of ground
 * that nothing was drawing. three.js only warns about this and then sets the
 * LINEAR filter regardless.
 *
 * `HalfFloatType` (R16F) is linear-filterable in **WebGL2 core**, no extension.
 * Its 11-bit mantissa quantises the normalised [0,1] field to ~1/2048, which at
 * `amplitude: 90` is ~4cm — two orders of magnitude below the 2m vertex spacing
 * of a 513² grid over 1024 world units, so the displaced surface is unchanged.
 * `this.data` stays Float32Array, so gameplay, pathing and determinism are
 * untouched: only the GPU's copy is quantised.
 *
 * The filter still degrades to NEAREST if even half-float linear is missing —
 * a faceted island rather than no island. The failure mode should never again
 * be a blank sea.
 */
export class Heightmap {
  constructor(params = {}) {
    this.params = { ...DEFAULT_TERRAIN, ...params };
    this.data = null;
    this.texture = null;
    this.min = 0;
    this.max = 1;
    // Bumped whenever the heightfield is edited after generation (currently
    // just Terraform's pad flattening). Consumers that cache something
    // derived from terrain shape — NavGrid's flow fields — use this to know
    // their cache is stale, the same way FogTerrain.landVersion works.
    this.terrainVersion = 0;
    this.generate();
  }

  generate(params = {}) {
    Object.assign(this.params, params);
    const p = this.params;
    const n = p.resolution;
    const noise = new SimplexNoise(p.seed);
    const warpNoise = new SimplexNoise(p.seed ^ 0x9e3779b9);

    const data = new Float32Array(n * n);
    let min = Infinity;
    let max = -Infinity;

    for (let j = 0; j < n; j++) {
      const v = j / (n - 1);
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);

        let nx = (u - 0.5) * p.frequency;
        let ny = (v - 0.5) * p.frequency;

        if (p.warp > 0) {
          const wx = warpNoise.fbm(nx + 5.2, ny + 1.3, 4, 2.0, 0.5);
          const wy = warpNoise.fbm(nx + 9.7, ny + 7.1, 4, 2.0, 0.5);
          nx += wx * p.warp;
          ny += wy * p.warp;
        }

        const soft = noise.fbm(nx, ny, p.octaves, p.lacunarity, p.gain);
        const sharp = noise.ridged(nx, ny, p.octaves, p.lacunarity, p.gain);
        let h = soft * (1 - p.ridgeBlend) + sharp * p.ridgeBlend;

        h = h * 0.5 + 0.5; // -> [0, 1]

        // Continental falloff so the map ends in ocean rather than a cliff wall.
        const dx = (u - 0.5) * 2;
        const dy = (v - 0.5) * 2;
        const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 1.05);
        h *= 1 - d * d * d;

        // Optional plateau: compress low ground into flat, buildable land.
        if (p.plateau > 0) {
          const flat = Math.max(h, p.seaLevel + 0.06);
          h = h * (1 - p.plateau) + flat * p.plateau;
        }

        data[j * n + i] = h;
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }

    this.data = data;
    this.min = min;
    this.max = max;

    if (this.texture) this.texture.dispose();
    // Half-float, not float — see the class header. `texelData` is a separate
    // array from `this.data` because a half-float texture cannot share the
    // Float32Array; `syncTexture` is what keeps the two in step, and every
    // in-place editor of `data` (terraform, craters) must call it.
    this.texelData = new Uint16Array(n * n);
    this.texture = new THREE.DataTexture(this.texelData, n, n, THREE.RedFormat, THREE.HalfFloatType);
    const filter = heightmapLinearFilterSupported() ? THREE.LinearFilter : THREE.NearestFilter;
    this.texture.magFilter = filter;
    this.texture.minFilter = filter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.syncTexture();

    return this;
  }

  /**
   * Re-encode `data` into the texture's half-float mirror and flag an upload.
   *
   * Callers that edit `this.data` in place used to just set
   * `texture.needsUpdate = true`, which worked only because the texture wrapped
   * the very same Float32Array. It no longer does, so that shortcut would
   * silently upload stale ground — exactly the CPU/GPU divergence this whole
   * change exists to remove. Bounds are inclusive and optional; they limit the
   * conversion work, not the upload, since a DataTexture re-uploads whole.
   */
  syncTexture(i0 = 0, j0 = 0, i1 = this.params.resolution - 1, j1 = this.params.resolution - 1) {
    const n = this.params.resolution;
    const lo = Math.max(0, Math.min(n - 1, i0));
    const hi = Math.max(0, Math.min(n - 1, i1));
    const top = Math.max(0, Math.min(n - 1, j0));
    const bottom = Math.max(0, Math.min(n - 1, j1));
    for (let j = top; j <= bottom; j++) {
      const row = j * n;
      for (let i = lo; i <= hi; i++) {
        this.texelData[row + i] = THREE.DataUtils.toHalfFloat(this.data[row + i]);
      }
    }
    if (this.texture) this.texture.needsUpdate = true;
  }

  /** Normalised height [0,1] at world position, bilinearly filtered. */
  sampleNormalized(x, z) {
    const p = this.params;
    const n = p.resolution;
    const u = (x / p.size + 0.5) * (n - 1);
    const v = (z / p.size + 0.5) * (n - 1);

    const i0 = Math.max(0, Math.min(n - 1, Math.floor(u)));
    const j0 = Math.max(0, Math.min(n - 1, Math.floor(v)));
    const i1 = Math.min(n - 1, i0 + 1);
    const j1 = Math.min(n - 1, j0 + 1);
    const fx = u - i0;
    const fz = v - j0;

    const h00 = this.data[j0 * n + i0];
    const h10 = this.data[j0 * n + i1];
    const h01 = this.data[j1 * n + i0];
    const h11 = this.data[j1 * n + i1];

    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  /** World-space Y of the ground at (x, z). */
  heightAt(x, z) {
    return this.sampleNormalized(x, z) * this.params.amplitude;
  }

  /** Surface normal at (x, z), from central differences on the heightfield. */
  normalAt(x, z, target = new THREE.Vector3()) {
    const step = this.params.size / (this.params.resolution - 1);
    const hl = this.heightAt(x - step, z);
    const hr = this.heightAt(x + step, z);
    const hd = this.heightAt(x, z - step);
    const hu = this.heightAt(x, z + step);
    return target.set(hl - hr, 2 * step, hd - hu).normalize();
  }

  /** 0 = flat ground, 1 = vertical. Useful for buildability / movement cost. */
  slopeAt(x, z) {
    const n = this.normalAt(x, z, _tmpNormal);
    return 1 - Math.max(0, Math.min(1, n.y));
  }

  get seaLevelY() {
    return this.params.seaLevel * this.params.amplitude;
  }
}

const _tmpNormal = new THREE.Vector3();
