import * as THREE from 'three';

/**
 * Fog of war — a coarse mask of "which ground has a vehicle been near".
 *
 * The mask is deliberately its own grid rather than a second channel on the
 * heightmap: it changes every frame while the heightfield changes almost never,
 * and it only needs enough resolution to make a reveal disc look round.
 *
 * Two invariants make everything else cheap:
 *   - the mask is monotonically non-decreasing, so revealing is permanent and
 *     a cell can cross the "explored" threshold at most once per world;
 *   - the texture object is never replaced, only rewritten, so no uniform ever
 *     has to be re-pointed after a terrain regenerate.
 */

/** Byte value at which a cell counts toward the explored percentage. */
const REVEAL_THRESHOLD = 128;

export class FogOfWar {
  /**
   * @param {import('../terrain/heightmap.js').Heightmap} heightmap
   * @param {object} [opts]
   * @param {number} [opts.resolution] mask cells per axis
   * @param {number} [opts.feather] width in world units of the soft reveal edge
   */
  constructor(heightmap, { resolution = 256, feather = 18 } = {}) {
    this.heightmap = heightmap;
    this.res = resolution;
    this.feather = feather;

    this.data = new Uint8Array(resolution * resolution);
    // Normalised terrain height at each cell centre. Sampled once per generate
    // so the live sea-level slider can re-derive the land mask without touching
    // the heightmap again. Normalised, not world-space, so the live *amplitude*
    // slider cannot invalidate it either.
    this.cellH = new Float32Array(resolution * resolution);
    this.landMask = new Uint8Array(resolution * resolution);

    this.totalLand = 0;
    this.revealedLand = 0;
    this.dirty = false;
    this._seaLevelUsed = NaN;
    // Keyed on the vehicle instance, so a parked vehicle costs nothing and the
    // entry dies with it.
    this._last = new WeakMap();

    // UnsignedByte rather than Float: linear filtering of float textures is an
    // extension in WebGL2, not core, and an 8-bit mask has no need of it.
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

    this._sampleTerrain();
    this._syncSeaLevel();
  }

  get mapSize() {
    return this.heightmap.params.size;
  }

  /** World units per mask cell. */
  get cellSize() {
    return this.mapSize / this.res;
  }

  /**
   * Reveal a disc of ground permanently.
   *
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} radius fully-revealed radius in world units
   * @param {object} [source] the vehicle doing the revealing; passing it skips
   *   the stamp entirely until it has crossed a cell boundary
   * @returns {boolean} whether any cell changed
   */
  reveal(x, z, radius, source = null) {
    const res = this.res;
    const cell = this.cellSize;

    if (source) {
      const ci = Math.floor(x / cell);
      const cj = Math.floor(z / cell);
      const last = this._last.get(source);
      if (last && last.i === ci && last.j === cj && last.r === radius) return false;
      this._last.set(source, { i: ci, j: cj, r: radius });
    }

    // Grid space, where one unit is one cell and cell k spans [k, k+1).
    const gx = (x / this.mapSize + 0.5) * res;
    const gz = (z / this.mapSize + 0.5) * res;
    const gInner = radius / cell;
    const gOuter = (radius + this.feather) / cell;

    const i0 = Math.max(0, Math.floor(gx - gOuter));
    const i1 = Math.min(res - 1, Math.ceil(gx + gOuter));
    const j0 = Math.max(0, Math.floor(gz - gOuter));
    const j1 = Math.min(res - 1, Math.ceil(gz + gOuter));

    const inner2 = gInner * gInner;
    const outer2 = gOuter * gOuter;
    const invBand = 1 / Math.max(1e-6, gOuter - gInner);
    let changed = false;

    for (let j = j0; j <= j1; j++) {
      const dz = j + 0.5 - gz;
      const dz2 = dz * dz;
      const row = j * res;

      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - gx;
        const d2 = dx * dx + dz2;
        if (d2 > outer2) continue;

        let v = 255;
        if (d2 > inner2) {
          // Feathering the stamp on the CPU is free — the loop already has d² —
          // and it is what stops the mask's own cell lattice showing through as
          // a staircased reveal edge.
          const t = 1 - (Math.sqrt(d2) - gInner) * invBand;
          v = (t * t * (3 - 2 * t) * 255) | 0;
        }

        const idx = row + i;
        const prev = this.data[idx];
        if (v <= prev) continue; // reveal is permanent: max, never overwrite

        this.data[idx] = v;
        changed = true;

        // Because data[] only ever increases, a cell crosses the threshold at
        // most once — so the count needs no rescan and no "already counted" set.
        if (prev < REVEAL_THRESHOLD && v >= REVEAL_THRESHOLD && this.landMask[idx]) {
          this.revealedLand++;
        }
      }
    }

    if (changed) this.dirty = true;
    return changed;
  }

  /** Upload the mask if anything changed. Call once per frame after reveals. */
  commit() {
    if (!this.dirty) return;
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  /** Revealed land as a fraction of all land, 0..1. */
  get exploredFraction() {
    this._syncSeaLevel();
    return this.totalLand > 0 ? this.revealedLand / this.totalLand : 0;
  }

  /** Terrain changed shape: resample heights and clear everything revealed. */
  refresh() {
    this._sampleTerrain();
    this.reset();
    this._seaLevelUsed = NaN;
    this._syncSeaLevel();
  }

  /**
   * Terrain changed shape in one spot — re-derive the cached heights there.
   *
   * `refresh()` would also do this, but it wipes the revealed mask, which is
   * unacceptable for an edit made mid-game. Re-sampling only the affected cells
   * and then rescanning keeps everything the player has explored while healing
   * the land/water classification the counts are built on.
   */
  patchTerrain(x, z, radius) {
    const res = this.res;
    const size = this.mapSize;
    const toCell = (w) => ((w / size + 0.5) * res - 0.5);

    const i0 = Math.max(0, Math.floor(toCell(x - radius)));
    const i1 = Math.min(res - 1, Math.ceil(toCell(x + radius)));
    const j0 = Math.max(0, Math.floor(toCell(z - radius)));
    const j1 = Math.min(res - 1, Math.ceil(toCell(z + radius)));

    for (let j = j0; j <= j1; j++) {
      const wz = ((j + 0.5) / res - 0.5) * size;
      const row = j * res;
      for (let i = i0; i <= i1; i++) {
        const wx = ((i + 0.5) / res - 0.5) * size;
        this.cellH[row + i] = this.heightmap.sampleNormalized(wx, wz);
      }
    }

    // Both counts come out of one pass, so they cannot disagree — the same
    // reason _syncSeaLevel rescans rather than adjusting a single total.
    this._rescan();
  }

  /** Clear the mask, keeping the sampled terrain heights. */
  reset() {
    this.data.fill(0);
    this.revealedLand = 0;
    this.dirty = true;
    this.texture.needsUpdate = true;
    // Otherwise a vehicle that has not moved keeps its early-out entry and
    // never re-stamps the ground it is standing on.
    this._last = new WeakMap();
  }

  dispose() {
    this.texture.dispose();
  }

  /** Cache the normalised terrain height at every cell centre. */
  _sampleTerrain() {
    const res = this.res;
    const size = this.mapSize;
    for (let j = 0; j < res; j++) {
      const wz = ((j + 0.5) / res - 0.5) * size;
      const row = j * res;
      for (let i = 0; i < res; i++) {
        const wx = ((i + 0.5) / res - 0.5) * size;
        this.cellH[row + i] = this.heightmap.sampleNormalized(wx, wz);
      }
    }
  }

  /**
   * Sea level is a live slider mutated without regenerating, so the land mask
   * can go stale at any moment. Rather than hooking the UI, notice on read.
   */
  _syncSeaLevel() {
    const s = this.heightmap.params.seaLevel;
    if (s === this._seaLevelUsed) return;
    this._seaLevelUsed = s;
    this._rescan();
  }

  /**
   * Rebuild the land mask and *both* counts together.
   *
   * Recounting only the denominator would be wrong: reveal discs cover water
   * too, so lowering the sea level turns already-revealed water cells into
   * revealed land. Deriving both from the same pass keeps them consistent by
   * construction and heals any drift from any source.
   */
  _rescan() {
    const s = this._seaLevelUsed;
    let total = 0;
    let revealed = 0;
    for (let k = 0; k < this.cellH.length; k++) {
      const land = this.cellH[k] > s ? 1 : 0;
      this.landMask[k] = land;
      if (land) {
        total++;
        if (this.data[k] >= REVEAL_THRESHOLD) revealed++;
      }
    }
    this.totalLand = total;
    this.revealedLand = revealed;
  }
}
