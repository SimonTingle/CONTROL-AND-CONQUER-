import * as THREE from 'three';

/**
 * Tire tracks — a CPU-written, GPU-sampled mask, modeled directly on
 * FogMask (fogOfWar.js): same Uint8Array + DataTexture, same feathered-disc
 * stamp math, same dirty/commit upload gating. Two real differences, both
 * because tracks fade and fog never does:
 *
 *   - stamp() writes `max(current, new)` rather than fog's monotone-only
 *     write, so driving back over a fading mark darkens/renews it instead of
 *     being a no-op once it's started fading.
 *   - decay() exists at all. Rather than scanning the whole grid every frame,
 *     a small `_hot` set tracks only cells that have been stamped and not yet
 *     fully faded — bounded by how much track is actually on the ground, not
 *     by grid resolution, the same amortized-cost approach the rest of this
 *     codebase already leans on (fog's own team staggering, etc.).
 */

/** Seconds for a fresh stamp to fade to nothing. One-line tuning knob. */
export const TRACK_FADE_SECONDS = 75;

export class TrackMask {
  constructor(mapSize, { resolution = 256 } = {}) {
    this.mapSize = mapSize;
    this.res = resolution;
    this.data = new Uint8Array(resolution * resolution);
    this.dirty = false;
    // Keyed on the vehicle instance, so a parked vehicle costs nothing and the
    // entry dies with it — same convention as FogMask's `_last`.
    this._last = new WeakMap();
    // Cell indices with nonzero intensity; decay() only ever walks this.
    this._hot = new Set();

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
   * Lay down a feathered disc of track at this point.
   *
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} radius stamp radius in world units — vehicle footprint,
   *   not weight
   * @param {number} intensity 0..1 — how dark the mark is; this is where
   *   weight comes in
   * @param {object} [source] the vehicle laying the track; passing it skips
   *   the stamp until it has moved at least `radius * 0.6` since the last one,
   *   so a stationary vehicle doesn't keep refreshing a mark under itself
   */
  stamp(x, z, radius, intensity, source = null) {
    if (source) {
      const last = this._last.get(source);
      if (last && Math.hypot(x - last.x, z - last.z) < radius * 0.6) return;
      this._last.set(source, { x, z });
    }

    const res = this.res;
    const cell = this.cellSize;
    const gx = (x / this.mapSize + 0.5) * res;
    const gz = (z / this.mapSize + 0.5) * res;
    // Floored at ~1 cell: a narrow vehicle's real-world radius (a scout's is
    // under half a cell at this grid's 4-unit cells) would otherwise miss
    // every texel depending on exactly where it lands relative to the cell
    // lattice — a stamp that silently does nothing most of the time.
    const gRadius = Math.max(radius / cell, 0.9);

    const i0 = Math.max(0, Math.floor(gx - gRadius));
    const i1 = Math.min(res - 1, Math.ceil(gx + gRadius));
    const j0 = Math.max(0, Math.floor(gz - gRadius));
    const j1 = Math.min(res - 1, Math.ceil(gz + gRadius));
    const r2 = gRadius * gRadius;
    const value = Math.round(Math.max(0, Math.min(1, intensity)) * 255);
    if (value <= 0) return;

    let changed = false;
    for (let j = j0; j <= j1; j++) {
      const dz = j + 0.5 - gz;
      const dz2 = dz * dz;
      const row = j * res;
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - gx;
        if (dx * dx + dz2 > r2) continue;
        const idx = row + i;
        if (value > this.data[idx]) {
          this.data[idx] = value;
          this._hot.add(idx);
          changed = true;
        }
      }
    }
    if (changed) this.dirty = true;
  }

  /** Fade every currently-marked cell by this frame's share of the fade window. */
  decay(dt) {
    if (this._hot.size === 0) return;
    const step = Math.max(1, Math.round((255 * dt) / TRACK_FADE_SECONDS));
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

  /** Wipe every mark — the ground they described no longer exists after a regenerate. */
  clear() {
    this.data.fill(0);
    this._hot.clear();
    this.dirty = true;
  }

  /**
   * Replace the mask's contents wholesale, e.g. from a loaded save.
   * Rebuilds `_hot` from the restored bytes so decay() picks every nonzero
   * cell back up — without this, anything loaded from a save would sit at
   * full darkness forever, never fading, since decay() only ever walks `_hot`.
   */
  restoreFromBytes(bytes) {
    this.data.set(bytes);
    this._hot.clear();
    for (let idx = 0; idx < this.data.length; idx++) {
      if (this.data[idx] > 0) this._hot.add(idx);
    }
    this.dirty = true;
  }
}
