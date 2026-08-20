import * as THREE from 'three';

/**
 * Fog of war — a coarse mask of "which ground has a vehicle been near".
 *
 * The mask is deliberately its own grid rather than a second channel on the
 * heightmap: it changes every frame while the heightfield changes almost never,
 * and it only needs enough resolution to make a reveal disc look round.
 *
 * Split in two because every team scouts independently:
 *
 *   - `FogTerrain` is the part that describes the *world* — cached cell
 *     heights, the land/water classification derived from them, and the land
 *     total. One per world, shared by every team, because duplicating it would
 *     mean re-sampling the same heightfield once per team for identical answers.
 *   - `FogMask` is the part that describes what one team has *seen*. One per
 *     team, ~65 KB each. Only the mask the player looks through needs a
 *     DataTexture; an AI's mask is queried on the CPU and never drawn.
 *
 * Two invariants make everything else cheap:
 *   - a mask is monotonically non-decreasing, so revealing is permanent and
 *     a cell can cross the "explored" threshold at most once per world;
 *   - the texture object is never replaced, only rewritten, so no uniform ever
 *     has to be re-pointed after a terrain regenerate.
 */

/** Byte value at which a cell counts toward the explored percentage. */
const REVEAL_THRESHOLD = 128;

/**
 * The shared, world-describing half of the fog: where the land is, and how
 * much of it there is. Knows nothing about who has seen what.
 */
export class FogTerrain {
  constructor(heightmap, { resolution = 256, feather = 18 } = {}) {
    this.heightmap = heightmap;
    this.res = resolution;
    this.feather = feather;

    // Normalised terrain height at each cell centre. Sampled once per generate
    // so the live sea-level slider can re-derive the land mask without touching
    // the heightmap again. Normalised, not world-space, so the live *amplitude*
    // slider cannot invalidate it either.
    this.cellH = new Float32Array(resolution * resolution);
    this.landMask = new Uint8Array(resolution * resolution);
    this.totalLand = 0;

    /**
     * Bumped whenever `landMask` changes shape. Masks compare their own copy
     * of it and recount their revealed total when they differ — which is how
     * per-team counts stay correct without rescanning the land once per team.
     */
    this.landVersion = 0;
    this._seaLevelUsed = NaN;

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

  get revealThreshold() {
    return REVEAL_THRESHOLD;
  }

  /** Terrain changed shape: resample every cached height. */
  refresh() {
    this._sampleTerrain();
    this._seaLevelUsed = NaN;
    this._syncSeaLevel();
  }

  /**
   * Terrain changed shape in one spot — re-derive the cached heights there.
   *
   * `refresh()` would also do this, but callers pair it with wiping the masks,
   * which is unacceptable for an edit made mid-game. Re-sampling only the
   * affected cells keeps everything explored while healing the land/water
   * classification the counts are built on.
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

    this._rescan();
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
   * Rebuild the land mask and the land total.
   *
   * The revealed counts are *not* recomputed here — each mask owns its own and
   * refreshes it lazily off `landVersion`. Recounting only the denominator
   * would be wrong for a mask (reveal discs cover water too, so lowering the
   * sea level turns already-revealed water cells into revealed land), which is
   * exactly why the version bump forces each mask to redo its own pass.
   */
  _rescan() {
    const s = this._seaLevelUsed;
    let total = 0;
    for (let k = 0; k < this.cellH.length; k++) {
      const land = this.cellH[k] > s ? 1 : 0;
      this.landMask[k] = land;
      if (land) total++;
    }
    this.totalLand = total;
    this.landVersion++;
  }
}

/** One team's view of the world: which ground *they* have revealed. */
export class FogMask {
  /**
   * @param {FogTerrain} terrain shared land data
   * @param {object} [opts]
   * @param {boolean} [opts.texture] allocate a GPU texture. Only the mask the
   *   player looks through needs one; an AI's is CPU-only.
   */
  constructor(terrain, { texture = false } = {}) {
    this.terrain = terrain;
    const n = terrain.res * terrain.res;

    this.data = new Uint8Array(n);
    this.revealedLand = 0;
    this.dirty = false;
    this._landVersion = terrain.landVersion;
    // Keyed on the vehicle instance, so a parked vehicle costs nothing and the
    // entry dies with it.
    this._last = new WeakMap();

    // UnsignedByte rather than Float: linear filtering of float textures is an
    // extension in WebGL2, not core, and an 8-bit mask has no need of it.
    this.texture = null;
    if (texture) {
      this.texture = new THREE.DataTexture(
        this.data,
        terrain.res,
        terrain.res,
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
  }

  get revealThreshold() {
    return REVEAL_THRESHOLD;
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
    const terrain = this.terrain;
    const res = terrain.res;
    const cell = terrain.cellSize;

    if (source) {
      const ci = Math.floor(x / cell);
      const cj = Math.floor(z / cell);
      const last = this._last.get(source);
      if (last && last.i === ci && last.j === cj && last.r === radius) return false;
      this._last.set(source, { i: ci, j: cj, r: radius });
    }

    // Grid space, where one unit is one cell and cell k spans [k, k+1).
    const gx = (x / terrain.mapSize + 0.5) * res;
    const gz = (z / terrain.mapSize + 0.5) * res;
    const gInner = radius / cell;
    const gOuter = (radius + terrain.feather) / cell;

    const i0 = Math.max(0, Math.floor(gx - gOuter));
    const i1 = Math.min(res - 1, Math.ceil(gx + gOuter));
    const j0 = Math.max(0, Math.floor(gz - gOuter));
    const j1 = Math.min(res - 1, Math.ceil(gz + gOuter));

    const inner2 = gInner * gInner;
    const outer2 = gOuter * gOuter;
    const invBand = 1 / Math.max(1e-6, gOuter - gInner);
    const landMask = terrain.landMask;
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
        if (prev < REVEAL_THRESHOLD && v >= REVEAL_THRESHOLD && landMask[idx]) {
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
    if (this.texture) this.texture.needsUpdate = true;
    this.dirty = false;
  }

  /**
   * Mask value 0..255 at a world point, for things that need to know whether
   * somewhere has been seen. Read-only: it does not disturb the monotone
   * reveal invariant the counting depends on.
   */
  seenAt(x, z) {
    const terrain = this.terrain;
    const res = terrain.res;
    const i = Math.round((x / terrain.mapSize + 0.5) * res - 0.5);
    const j = Math.round((z / terrain.mapSize + 0.5) * res - 0.5);
    if (i < 0 || j < 0 || i >= res || j >= res) return 0;
    return this.data[j * res + i];
  }

  /** Revealed land as a fraction of all land, 0..1. */
  get exploredFraction() {
    this.terrain._syncSeaLevel();
    this._syncLand();
    return this.terrain.totalLand > 0 ? this.revealedLand / this.terrain.totalLand : 0;
  }

  /** Clear the mask, keeping the shared terrain sampling. */
  reset() {
    this.data.fill(0);
    this.revealedLand = 0;
    this.dirty = true;
    if (this.texture) this.texture.needsUpdate = true;
    // Otherwise a vehicle that has not moved keeps its early-out entry and
    // never re-stamps the ground it is standing on.
    this._last = new WeakMap();
    this._landVersion = this.terrain.landVersion;
  }

  dispose() {
    this.texture?.dispose();
  }

  /**
   * The land classification moved under us (sea level, or a terraform patch).
   * Recount what *this* mask has revealed against the new mask — one pass over
   * 64 KB, and only when the version actually changed.
   */
  _syncLand() {
    if (this._landVersion === this.terrain.landVersion) return;
    this._landVersion = this.terrain.landVersion;

    const landMask = this.terrain.landMask;
    const data = this.data;
    let revealed = 0;
    for (let k = 0; k < data.length; k++) {
      if (landMask[k] && data[k] >= REVEAL_THRESHOLD) revealed++;
    }
    this.revealedLand = revealed;
  }
}
