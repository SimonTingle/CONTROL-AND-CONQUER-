import * as THREE from 'three';

/**
 * Tire tracks — a persistent "splat" mask the terrain shader samples, the same
 * shape as FogMask (Uint8Array + DataTexture + dirty/commit upload gating).
 *
 * Three things here are deliberately unlike fog, and each one was a measured
 * bug in the first version of this file rather than a preference:
 *
 *  - **Resolution is one world unit per texel.** Fog can afford 4 units/texel
 *    because it only ever needs to say "seen / not seen" over big areas. A
 *    track is 0.5-0.7 units wide on a 2.6-3.4 unit vehicle, so at fog's
 *    resolution a single texel is wider than the whole vehicle and the mark
 *    can only ever be a square blob — no intensity or tint tuning can rescue
 *    that, which is exactly the trap the first version fell into.
 *
 *  - **Marks are stamped as a swept segment, not a dot per frame.** The brush
 *    is dragged from where each wheel was last frame to where it is now, which
 *    is the standard way this is done (the tyre is the brush). Stamping only
 *    at the current position leaves a dotted line as soon as a vehicle moves
 *    more than a texel per frame — which every vehicle here does.
 *
 *  - **Decay carries its fractional remainder.** The obvious
 *    `round(255 * dt / FADE)` is 0 for any sane frame time, so the original
 *    `Math.max(1, ...)` guard silently turned a 75-second fade into a
 *    ~4-second one (measured: 1 unit per *frame*, i.e. 60/s at 60fps) and made
 *    it frame-rate dependent on top. Accumulating the remainder keeps the fade
 *    exact and identical at any frame rate.
 */

/** Seconds for a fresh, full-intensity mark to fade to nothing. */
export const TRACK_FADE_SECONDS = 75;

/**
 * Longest gap we'll join with a swept mark, in world units. Anything further
 * is a teleport (load, respawn, base relocate), not driving — joining those
 * would paint a stripe clean across the island.
 */
const MAX_SWEEP = 12;

export class TrackMask {
  constructor(mapSize, { resolution = 1024 } = {}) {
    this.mapSize = mapSize;
    this.res = resolution;
    this.data = new Uint8Array(resolution * resolution);
    this.dirty = false;
    // Per-vehicle last wheel contact points, so each frame sweeps from where
    // the wheels actually were. Keyed on the instance, so a destroyed vehicle's
    // entry dies with it — same convention as FogMask's `_last`.
    this._last = new WeakMap();
    // Cell indices with nonzero intensity; decay() only ever walks this.
    this._hot = new Set();
    // Sub-unit fade remainder, see the class comment.
    this._fadeCarry = 0;

    this.texture = new THREE.DataTexture(
      this.data,
      resolution,
      resolution,
      THREE.RedFormat,
      THREE.UnsignedByteType
    );
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;
  }

  /** World units per mask cell. */
  get cellSize() {
    return this.mapSize / this.res;
  }

  /**
   * Lay down one frame of track for a vehicle: two ruts, one per wheel line,
   * each swept from last frame's position to this one.
   *
   * @param {number} x world X of the vehicle centre
   * @param {number} z world Z of the vehicle centre
   * @param {number} heading radians; forward is (cos, sin) in XZ, matching
   *   vehicleController's own integration
   * @param {number} halfTrack half the distance between the wheel lines
   * @param {number} rutRadius rut half-width in world units
   * @param {number} intensity 0..1 — how dark; this is where weight comes in
   * @param {object} source the vehicle, used to remember its last wheel points
   */
  stampVehicle(x, z, heading, halfTrack, rutRadius, intensity, source) {
    // Lateral axis: perpendicular to forward (cos, sin).
    const lx = -Math.sin(heading);
    const lz = Math.cos(heading);
    const left = { x: x + lx * halfTrack, z: z + lz * halfTrack };
    const right = { x: x - lx * halfTrack, z: z - lz * halfTrack };

    const prev = this._last.get(source);
    this._last.set(source, { left, right });
    if (!prev) return; // first frame seen: no sweep to draw yet

    this._sweep(prev.left, left, rutRadius, intensity);
    this._sweep(prev.right, right, rutRadius, intensity);
  }

  /** Drag the brush from `a` to `b`, stamping every half texel along the way. */
  _sweep(a, b, radius, intensity) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist > MAX_SWEEP) return; // teleport, not a drive — see MAX_SWEEP
    const cell = this.cellSize;
    const steps = Math.max(1, Math.ceil((dist / cell) * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this._disc(a.x + dx * t, a.z + dz * t, radius, intensity);
    }
  }

  /** One soft-edged disc, in world units. Writes max(current, new). */
  _disc(x, z, radius, intensity) {
    const res = this.res;
    const cell = this.cellSize;
    const gx = (x / this.mapSize + 0.5) * res;
    const gz = (z / this.mapSize + 0.5) * res;
    const gRadius = radius / cell;
    const value = Math.max(0, Math.min(1, intensity)) * 255;
    if (value <= 0) return;

    // The soft edge is a texel wide either side, so a rut narrower than one
    // texel still lands on something instead of falling between texel centres.
    const inner = gRadius - 0.5;
    const outer = gRadius + 0.5;
    const i0 = Math.max(0, Math.floor(gx - outer));
    const i1 = Math.min(res - 1, Math.ceil(gx + outer));
    const j0 = Math.max(0, Math.floor(gz - outer));
    const j1 = Math.min(res - 1, Math.ceil(gz + outer));

    let changed = false;
    for (let j = j0; j <= j1; j++) {
      const dz = j + 0.5 - gz;
      const row = j * res;
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - gx;
        const d = Math.hypot(dx, dz);
        if (d >= outer) continue;
        // smoothstep falloff from solid centre to nothing at the outer edge
        let cover = 1;
        if (d > inner) {
          const t = (d - inner) / (outer - inner);
          cover = 1 - t * t * (3 - 2 * t);
        }
        const v = Math.round(value * cover);
        const idx = row + i;
        if (v > this.data[idx]) {
          this.data[idx] = v;
          this._hot.add(idx);
          changed = true;
        }
      }
    }
    if (changed) this.dirty = true;
  }

  /**
   * Fade every marked cell. The per-frame drop is well under one 0-255 step,
   * so the remainder is carried between frames rather than rounded — rounding
   * it is what turned a 75s fade into ~4s and made it frame-rate dependent.
   */
  decay(dt) {
    if (this._hot.size === 0) return;
    this._fadeCarry += (255 * dt) / TRACK_FADE_SECONDS;
    const step = Math.floor(this._fadeCarry);
    if (step <= 0) return;
    this._fadeCarry -= step;
    for (const idx of this._hot) {
      const v = this.data[idx] - step;
      if (v <= 0) {
        this.data[idx] = 0;
        this._hot.delete(idx);
      } else {
        this.data[idx] = v;
      }
    }
    this.dirty = true;
  }

  /** Upload the mask if anything changed. Call once per frame after stamp/decay. */
  commit() {
    if (!this.dirty) return;
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  /** Wipe every mark — the ground they described no longer exists. */
  clear() {
    this.data.fill(0);
    this._hot.clear();
    this._fadeCarry = 0;
    this.dirty = true;
  }

  /**
   * Run-length encode for saving. The mask is a megabyte and almost entirely
   * zero, so raw base64 would add ~1.4MB to every save and threaten the
   * localStorage quota; run-lengths bring an empty mask down to ~8KB.
   */
  toRLE() {
    const d = this.data;
    const out = [];
    let i = 0;
    while (i < d.length) {
      const v = d[i];
      let n = 1;
      while (i + n < d.length && d[i + n] === v && n < 255) n++;
      out.push(v, n);
      i += n;
    }
    return Uint8Array.from(out);
  }

  /**
   * Restore from toRLE(). Rebuilds `_hot` as it goes so restored marks resume
   * fading — decay() only ever walks `_hot`, so without this they would sit
   * frozen at full darkness forever.
   */
  fromRLE(bytes) {
    this.data.fill(0);
    this._hot.clear();
    this._fadeCarry = 0;
    let p = 0;
    let idx = 0;
    while (p + 1 < bytes.length && idx < this.data.length) {
      const v = bytes[p];
      const n = bytes[p + 1];
      p += 2;
      if (v !== 0) {
        const end = Math.min(idx + n, this.data.length);
        for (let k = idx; k < end; k++) {
          this.data[k] = v;
          this._hot.add(k);
        }
      }
      idx += n;
    }
    this.dirty = true;
  }
}
