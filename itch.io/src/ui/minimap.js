/**
 * Bottom-right minimap: explored terrain, unit blips, and the camera's
 * footprint on the ground.
 *
 * Presentation only. It reads simulation state and never writes it — drawn
 * from `renderTick`, which is documented as never mutating the sim, so this
 * file may use wall-clock time and skipped frames freely (see CLAUDE.md's
 * render-only carve-out). A minimap *click* moves the camera, which is also
 * presentation; if this ever grows "click to order a move", that order must go
 * through `src/net/intents.js` at a tick boundary instead.
 *
 * Two layers on two cadences, mirroring how main.js already separates its
 * half-second stats poll from per-frame work:
 *
 * - The terrain+fog raster is a single fused pass over the fog's own 256²
 *   grid. `FogTerrain.cellH` (normalised height) and `FogMask.data` (0..255
 *   reveal) share that grid exactly, so one loop produces both colour and
 *   darkness with no resampling. 65 K cells is cheap but not free, so it is
 *   rebuilt on the slow tick, not every frame.
 * - Blips and the view rectangle are per-frame, because they move every frame.
 *
 * The fog check on blips is not decoration: without it the minimap would
 * reveal every enemy position on the map, which is the one thing fog of war
 * exists to prevent.
 */

/** A mask value at or above this counts as explored (matches fogOfWar.js). */
export const REVEAL_THRESHOLD = 128;

/**
 * World X/Z to normalised 0..1 minimap space.
 *
 * The world is centred on the origin and spans ±size/2, so this is the same
 * `(w / size + 0.5)` expression fogOfWar.js and heightmap.js already inline.
 * Clamped rather than wrapped: a coordinate off the edge of the map should
 * pin to the edge, never reappear on the far side.
 */
export function worldToMap(x, z, size) {
  return {
    u: clamp01(x / size + 0.5),
    v: clamp01(z / size + 0.5),
  };
}

/**
 * The inverse, for turning a click back into a world position.
 *
 * `worldToMap` clamps, so this only round-trips exactly for points inside the
 * map — which is all a click can produce, since the canvas *is* the map.
 */
export function mapToWorld(u, v, size) {
  return {
    x: (clamp01(u) - 0.5) * size,
    z: (clamp01(v) - 0.5) * size,
  };
}

function clamp01(v) {
  // Not `Math.min(1, Math.max(0, v))` alone: NaN survives that unchanged and
  // would silently place a blip at canvas position NaN, drawing nothing and
  // reporting no error.
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Should something at this world point be drawn?
 *
 * Everything on the minimap is gated on this, including the player's own
 * units — a unit standing somewhere its team has not revealed is not
 * something the team can see.
 */
/**
 * Accept a colour as either a CSS string or a packed 0xRRGGBB number.
 *
 * `Team.color` is a number (three.js takes them directly), and assigning a
 * number to a canvas `fillStyle` is silently ignored — the previous style
 * stays in effect. That failure draws *something*, in the wrong colour or not
 * at all, with no error, so it is converted here rather than trusted.
 */
export function cssColor(c) {
  if (typeof c === 'number') return `#${(c >>> 0).toString(16).padStart(6, '0')}`;
  return c ?? '#8ea3b6';
}

export function isRevealed(fogMask, x, z) {
  if (!fogMask) return true; // no fog in play (sandbox with fog disabled)
  return fogMask.seenAt(x, z) >= REVEAL_THRESHOLD;
}

// Terrain palette. Deliberately flatter and cooler than the 3D terrain
// shader's sand/grass/rock/snow ramp: this is a 200px readout whose job is
// "where is land, where have I been", and reproducing the full ramp at this
// size turns into noise that blips cannot be picked out of.
const WATER = [14, 26, 40];
const LAND_LOW = [42, 58, 46];
const LAND_HIGH = [122, 132, 112];
const UNEXPLORED = [6, 8, 11];

export class Minimap {
  /**
   * @param {object} opts
   * @param {(x: number, z: number) => void} opts.onJump called with a world
   *   position when the player clicks the map.
   */
  constructor({ onJump } = {}) {
    this.root = document.getElementById('minimap');
    this.onJump = onJump;
    this.res = 0;
    this.raster = null; // ImageData at the fog's resolution
    this.rasterCanvas = null; // offscreen, blitted and scaled onto the visible one
    this.build();
  }

  build() {
    if (!this.root) return;
    this.canvas = document.createElement('canvas');
    // Backing-store size is fixed; CSS scales it to the panel. Independent of
    // devicePixelRatio on purpose — the raster's real resolution is the fog's
    // 256², so a 2x backing store would upscale the same data and cost twice
    // the fill for no extra detail.
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d');
    // Nearest-neighbour: the raster is genuinely 256² data, and smoothing it
    // blurs the fog edge into a gradient that reads as "partly explored".
    this.ctx.imageSmoothingEnabled = false;
    this.root.replaceChildren(this.canvas);

    this.canvas.addEventListener('pointerdown', (e) => this.handleClick(e));
  }

  handleClick(e) {
    if (!this.onJump || !this.size) return;
    const rect = this.canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    const { x, z } = mapToWorld(u, v, this.size);
    this.onJump(x, z);
  }

  /**
   * Rebuild the terrain+fog raster. Slow tick only — see the file header.
   *
   * @param {object} fogTerrain shared FogTerrain (cellH, landMask, res)
   * @param {object} fogMask the local player's FogMask
   */
  rebuildRaster(fogTerrain, fogMask) {
    if (!this.ctx || !fogTerrain) return;
    const res = fogTerrain.res;
    if (this.res !== res || !this.raster) {
      this.res = res;
      this.rasterCanvas = document.createElement('canvas');
      this.rasterCanvas.width = res;
      this.rasterCanvas.height = res;
      this.rasterCtx = this.rasterCanvas.getContext('2d');
      this.raster = this.rasterCtx.createImageData(res, res);
    }

    const { cellH, landMask } = fogTerrain;
    const fog = fogMask?.data;
    const px = this.raster.data;

    // Height range for the land ramp, computed from the land actually present
    // rather than assumed 0..1 — a mostly-flat island would otherwise render
    // as one uniform colour.
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < landMask.length; k++) {
      if (!landMask[k]) continue;
      const h = cellH[k];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const span = hi > lo ? hi - lo : 1;

    for (let k = 0; k < cellH.length; k++) {
      const o = k * 4;
      const seen = fog ? fog[k] : 255;
      if (seen < REVEAL_THRESHOLD) {
        px[o] = UNEXPLORED[0];
        px[o + 1] = UNEXPLORED[1];
        px[o + 2] = UNEXPLORED[2];
        px[o + 3] = 255;
        continue;
      }
      let c;
      if (!landMask[k]) {
        c = WATER;
      } else {
        const t = (cellH[k] - lo) / span;
        c = [
          LAND_LOW[0] + (LAND_HIGH[0] - LAND_LOW[0]) * t,
          LAND_LOW[1] + (LAND_HIGH[1] - LAND_LOW[1]) * t,
          LAND_LOW[2] + (LAND_HIGH[2] - LAND_LOW[2]) * t,
        ];
      }
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 255;
    }

    this.rasterCtx.putImageData(this.raster, 0, 0);
  }

  /**
   * Per-frame draw: blit the cached raster, then blips and the view rectangle.
   *
   * @param {object} opts
   * @param {number} opts.size world size (heightmap.params.size)
   * @param {object} opts.fogMask the local player's FogMask
   * @param {Array} opts.vehicles live vehicle instances
   * @param {Array} opts.structures live structure instances
   * @param {(teamId: number) => string} opts.colorOf team colour lookup
   * @param {Array<{x: number, z: number}>} [opts.viewCorners] ground-projected
   *   camera corners, in order; omitted when the camera looks at the horizon
   *   and no ground quad exists.
   */
  draw({ size, fogMask, vehicles = [], structures = [], colorOf, viewCorners }) {
    if (!this.ctx) return;
    this.size = size;
    const c = this.ctx;
    const n = this.canvas.width;

    if (this.rasterCanvas) c.drawImage(this.rasterCanvas, 0, 0, n, n);
    else {
      c.fillStyle = '#06080b';
      c.fillRect(0, 0, n, n);
    }

    // Structures first, so a unit parked on one is not hidden by it.
    for (const s of structures) {
      const p = s.group?.position;
      if (!p || s.dead) continue;
      if (!isRevealed(fogMask, p.x, p.z)) continue;
      const { u, v } = worldToMap(p.x, p.z, size);
      c.fillStyle = cssColor(colorOf(s.teamId));
      c.fillRect(u * n - 2.5, v * n - 2.5, 5, 5);
    }

    for (const veh of vehicles) {
      const p = veh.group?.position;
      if (!p || veh.dead) continue;
      if (!isRevealed(fogMask, p.x, p.z)) continue;
      const { u, v } = worldToMap(p.x, p.z, size);
      c.fillStyle = cssColor(colorOf(veh.teamId));
      c.fillRect(u * n - 1.5, v * n - 1.5, 3, 3);
    }

    if (viewCorners?.length >= 3) {
      c.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      c.lineWidth = 1;
      c.beginPath();
      viewCorners.forEach((corner, i) => {
        const { u, v } = worldToMap(corner.x, corner.z, size);
        if (i === 0) c.moveTo(u * n, v * n);
        else c.lineTo(u * n, v * n);
      });
      c.closePath();
      c.stroke();
    }
  }
}
