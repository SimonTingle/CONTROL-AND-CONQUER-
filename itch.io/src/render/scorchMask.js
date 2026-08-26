import * as THREE from 'three';

/**
 * Scorch marks — the burn an impact leaves on the ground.
 *
 * Structurally this is `core/trackMask.js`: a Uint8Array the terrain shader
 * samples, a DataTexture over it, a hot-cell set so decay only walks what is
 * actually marked, and a fractional fade remainder. That file's header
 * documents three bugs the naive version of this shape had, and all three
 * apply here unchanged — in particular the remainder-carrying decay, since a
 * ten-minute fade drops far less than one 0-255 step per frame and rounding it
 * would collapse the fade to seconds and make it frame-rate dependent.
 *
 * Two things differ from tracks, both deliberate:
 *
 *  - **It fades far more slowly.** A tyre mark is a trace of passage and
 *    should be gone within a minute or two. A scorch is the record of an
 *    explosion, and a battlefield that forgets where it was fought reads as
 *    though nothing happened there.
 *
 *  - **Marks are stamped as single discs, not swept segments.** The sweep in
 *    trackMask exists because a *moving* brush leaves a dotted line if you
 *    only stamp its current position. An impact does not move.
 *
 * **Render-only, and not serialized.** Unlike the craters underneath them
 * (`core/craters.js`), scorch marks change nothing a simulation reads — no
 * height, no passability, no line of sight. They are therefore left out of the
 * save entirely rather than run-length encoded like tracks: a loaded world
 * shows fresh ground under old craters, which is a small cosmetic loss against
 * not having to keep a second megabyte-scale array in agreement across a
 * lockstep match.
 */

/** Seconds for a fresh, full-intensity scorch to fade to nothing. */
export const SCORCH_FADE_SECONDS = 600;

export class ScorchMask {
  constructor(mapSize, { resolution = 1024 } = {}) {
    this.mapSize = mapSize;
    this.res = resolution;
    this.data = new Uint8Array(resolution * resolution);
    this.dirty = false;
    /** Cell indices with nonzero intensity; decay() only ever walks this. */
    this._hot = new Set();
    /** Sub-unit fade remainder — see the class comment. */
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
   * Burn a mark into the ground.
   *
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} radius world units — sized off the same damage curve the
   *   crater uses, so the burn and the hole agree
   * @param {number} intensity 0..1
   */
  stamp(x, z, radius, intensity = 1) {
    const res = this.res;
    const cell = this.cellSize;
    const gx = (x / this.mapSize + 0.5) * res;
    const gz = (z / this.mapSize + 0.5) * res;
    const gRadius = radius / cell;
    const value = Math.max(0, Math.min(1, intensity)) * 255;
    if (value <= 0) return;

    // Scorch has no hard edge — an explosion's soot thins out rather than
    // stopping — so the falloff starts at the centre instead of at a solid
    // core with a one-texel feather like a tyre rut.
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
        const t = Math.min(1, d / outer);
        // Darkest at the centre, thinning to nothing at the rim.
        const cover = 1 - t * t * (3 - 2 * t);
        const v = Math.round(value * cover);
        const idx = row + i;
        // max, not add: overlapping impacts darken to the deepest of them
        // rather than saturating a whole area to solid black after a few
        // shells land near each other.
        if (v > this.data[idx]) {
          this.data[idx] = v;
          this._hot.add(idx);
          changed = true;
        }
      }
    }
    if (changed) this.dirty = true;
  }

  /** Fade every marked cell. See trackMask.js on why the remainder is carried. */
  decay(dt) {
    if (this._hot.size === 0) return;
    this._fadeCarry += (255 * dt) / SCORCH_FADE_SECONDS;
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

  /** Upload if anything changed. Call once per frame after stamp/decay. */
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
}
