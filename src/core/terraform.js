/**
 * Runtime terrain edits — currently one thing: flattening a construction pad
 * under a deploying base station.
 *
 * This works because the heightmap's DataTexture wraps its Float32Array *by
 * reference*: writing into `heightmap.data` and flagging `needsUpdate` re-uploads
 * the field, and because the terrain shader derives its normals analytically
 * from that same texture — and shares the displacement with the depth material —
 * the new shape gets correct shading and shadows with no extra work. Every CPU
 * consumer (wheel grounding, the grade probe, picking, camera clamps) reads the
 * array directly and follows for free.
 *
 * The one thing that does *not* follow is the fog of war's cached per-cell
 * heights, which is why completion patches them explicitly.
 */

/** How far above sea level the pad surface must sit, in normalised height. */
const SEA_MARGIN = 0.02;

export class Terraform {
  constructor(world) {
    this.world = world;
    /** Completed and in-progress pads. Stage 2's building placement reads this. */
    this.pads = [];
    this.active = null;
  }

  get heightmap() {
    return this.world.heightmap;
  }

  /**
   * Is this a legal place to deploy?
   *
   * @returns {true|string} true, or a short reason to show on the disabled menu entry
   */
  canDeployAt(x, z, { padRadius, padBlend, maxRelief }) {
    const hm = this.heightmap;
    const outer = padRadius + padBlend;
    const half = hm.params.size / 2;

    if (Math.abs(x) + outer > half || Math.abs(z) + outer > half) return 'Too close to the map edge';

    // Sample a stencil over the pad rather than the single point under the
    // vehicle: what matters is the whole disc, and a base parked on the one
    // flat rock in a boulder field should not qualify.
    //
    // The test is height *spread*, not slope. Averaging slope over a 40-unit
    // disc smooths almost any terrain into acceptability — measured over this
    // map it never once exceeded 0.26, so a slope gate simply never fires.
    // Spread asks the question that actually matters: how much ground would
    // this pad have to move?
    let lo = Infinity;
    let hi = -Infinity;
    for (const [sx, sz] of STENCIL) {
      const h = hm.heightAt(x + sx * padRadius, z + sz * padRadius);
      if (h <= hm.seaLevelY + 2) return 'Too close to water';
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }

    if (hi - lo > maxRelief) return 'Ground too uneven';
    if (this.active) return 'Already deploying';
    return true;
  }

  /**
   * Begin flattening a pad. Returns the pad record, or null if one is already
   * being built.
   */
  deployPad(x, z, { padRadius, padBlend, duration, onComplete, teamId = 0 } = {}) {
    if (this.active) return null;

    const hm = this.heightmap;
    const p = hm.params;
    const n = p.resolution;
    const outer = padRadius + padBlend;

    // The pad settles to the mean of the ground it covers, not the height of
    // the single point under the vehicle — a point sample taken on a local bump
    // would dig the whole pad down to that bump's dip.
    let sum = 0;
    for (const [sx, sz] of STENCIL) {
      sum += hm.sampleNormalized(x + sx * padRadius * 0.6, z + sz * padRadius * 0.6);
    }
    const targetN = Math.max(sum / STENCIL.length, p.seaLevel + SEA_MARGIN);

    // Texel bounds of everything the pad can touch.
    const toIdx = (w) => (w / p.size + 0.5) * (n - 1);
    const i0 = Math.max(0, Math.floor(toIdx(x - outer)));
    const i1 = Math.min(n - 1, Math.ceil(toIdx(x + outer)));
    const j0 = Math.max(0, Math.floor(toIdx(z - outer)));
    const j1 = Math.min(n - 1, Math.ceil(toIdx(z + outer)));

    // Snapshot before touching anything. Every frame lerps from *this*, never
    // from the live array — re-reading mutated data would compound the easing
    // curve into an exponential and make the blend edge crawl outward.
    const w = i1 - i0 + 1;
    const h = j1 - j0 + 1;
    const original = new Float32Array(w * h);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        original[(j - j0) * w + (i - i0)] = hm.data[j * n + i];
      }
    }

    const pad = {
      x,
      z,
      // The team whose base flattened this ground. Everything built here
      // inherits it, so a building can never disagree with its own pad.
      teamId,
      radius: padRadius,
      blend: padBlend,
      targetN,
      progress: 0,
      complete: false,
      buildings: [], // stage 2
    };

    this.pads.push(pad);
    this.active = { pad, original, i0, i1, j0, j1, w, duration: duration ?? 5, onComplete };
    this._applyUniforms(pad, 0);
    return pad;
  }

  update(dt) {
    const job = this.active;
    if (!job) return;

    const { pad, original, i0, i1, j0, j1, w } = job;
    const hm = this.heightmap;
    const n = hm.params.size;
    const res = hm.params.resolution;
    const outer = pad.radius + pad.blend;

    pad.progress = Math.min(1, pad.progress + dt / job.duration);
    const eased = smoothstep01(pad.progress);

    for (let j = j0; j <= j1; j++) {
      const wz = (j / (res - 1) - 0.5) * n;
      for (let i = i0; i <= i1; i++) {
        const wx = (i / (res - 1) - 0.5) * n;
        const d = Math.hypot(wx - pad.x, wz - pad.z);
        if (d >= outer) continue;

        // Flat inside the radius, easing back to untouched ground at the outer
        // edge. A hard cut here would leave a cliff around the pad.
        const spatial = 1 - smoothstep(pad.radius, outer, d);
        const from = original[(j - j0) * w + (i - i0)];
        hm.data[j * res + i] = from + (pad.targetN - from) * spatial * eased;
      }
    }
    hm.texture.needsUpdate = true;
    this._applyUniforms(pad, eased);

    if (pad.progress >= 1) {
      pad.complete = true;
      this.active = null;
      // Order matters: the fog's cached heights have to be right before
      // anything reads the explored fraction off them.
      this.world.fog.patchTerrain(pad.x, pad.z, outer);
      // Same "the world changed shape here" moment: anything growing under the
      // new concrete is gone.
      this.world.blooms.clearUnder(pad.x, pad.z, pad.radius);
      job.onComplete?.(pad);
    }
  }

  /** The pad covering this point, if any. Stage 2's building placement test. */
  padAt(x, z) {
    return this.pads.find((p) => Math.hypot(x - p.x, z - p.z) <= p.radius) ?? null;
  }

  /** Terrain was regenerated: the pads describe a heightfield that no longer exists. */
  clear() {
    this.pads.length = 0;
    this.active = null;
    const u = this.world.terrain.uniforms;
    u.uPadRadius.value = 0;
    u.uPadProgress.value = 0;
  }

  _applyUniforms(pad, progress) {
    const u = this.world.terrain.uniforms;
    u.uPadCenter.value.set(pad.x, pad.z);
    u.uPadRadius.value = pad.radius;
    u.uPadBlend.value = pad.blend;
    u.uPadProgress.value = progress;
  }
}

/** Centre plus eight points on a ring — enough to characterise a disc cheaply. */
const STENCIL = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.707, 0.707],
  [0.707, -0.707],
  [-0.707, 0.707],
  [-0.707, -0.707],
];

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function smoothstep01(t) {
  return t * t * (3 - 2 * t);
}
