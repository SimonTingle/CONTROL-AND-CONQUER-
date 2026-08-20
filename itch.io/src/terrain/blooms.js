import * as THREE from 'three';
import { mulberry32 } from './noise.js';

/**
 * Crystal blooms — the harvestable resource.
 *
 * Fields grow in the island's *drivable* mid band: above the beach, below the
 * rock and snow. That is not decoration — siting a resource where the harvester
 * cannot reach it is the classic way this mechanic fails, so the growth rule and
 * the traversability rule are deliberately the same rule.
 *
 * Every stored height is normalised, never a world Y. The amplitude slider is
 * live, and a cached world position would leave a whole field hanging in the air
 * the moment it moved — the same reasoning that made FogOfWar cache normalised
 * cell heights.
 */

// The splat's own bands, inset. Grass runs from uSeaLevel + uSandBand (0.215) to
// uSnowLine - uSnowBlend (0.50), and stops being rock below uRockSlope -
// uRockBlend (0.23). Sitting inside those means a modest slider nudge cannot
// strand a field in sand or snow. Deliberately constants rather than live
// uniform reads: placement is a rule applied once at generation, and wiring it
// to the sliders would mean dragging "snow line" silently relocating fields.
const BAND_MIN_N = 0.24;
const BAND_MAX_N = 0.46;
const MAX_SLOPE = 0.2;

const FIELD_TARGET = 26;
const FIELD_RADIUS = 14;
/**
 * How far past a field's own radius a `requireOnField` query still counts as
 * having hit it. Generous enough that aiming at the edge of a visible cluster
 * lands, tight enough that a click on bare ground finds nothing rather than
 * silently snapping to whichever field happens to be nearest on the map.
 */
const PICK_MAX_FACTOR = 1.6;
const MIN_SEPARATION = 90;
const CRYSTALS_PER_FIELD = 28;

const FIELD_CAPACITY = 900;
/** Units/second at full stock. Scaled down hard when depleted — see update(). */
const REGEN_RATE = 6;

const REVEAL_EASE = 0.8; // seconds for a newly-seen field to grow in
const FOG_POLL = 0.25; // seconds between fog checks

/** Whole disc must qualify, not just the centre — no fields half off a cliff. */
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

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _euler = new THREE.Euler();

export class Blooms {
  constructor(heightmap, fog, { seed = 1 } = {}) {
    this.heightmap = heightmap;
    this.fog = fog;
    this.seed = seed;

    this.fields = [];
    this._unrevealed = new Set();
    this._fogTimer = 0;
    this._amplitudeUsed = NaN;
    this._matrixDirty = false;

    const geo = new THREE.ConeGeometry(0.5, 1, 5, 1);
    // Base at local y=0 so an instance sits *on* the ground and its Y scale is
    // simply the crystal's height.
    geo.translate(0, 0.5, 0);

    this.material = new THREE.MeshStandardMaterial({
      color: '#6fd8f2',
      emissive: new THREE.Color('#2ad9ff'),
      emissiveIntensity: 0.45,
      roughness: 0.22,
      metalness: 0.35,
      flatShading: true,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, FIELD_TARGET * CRYSTALS_PER_FIELD);
    this.mesh.name = 'blooms';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    // One draw call for every crystal on the island, so culling buys nothing —
    // and skipping it avoids recomputing instance bounds every time a field's
    // matrices change.
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.generate();
  }

  /** Seed the fields and fill the instance buffer. */
  generate() {
    const hm = this.heightmap;
    const rand = mulberry32((this.seed ^ 0xb1000001) >>> 0);
    const half = hm.params.size / 2 - FIELD_RADIUS - 4;

    this.fields = [];
    this._unrevealed = new Set();

    const maxTries = FIELD_TARGET * 400;
    for (let t = 0; t < maxTries && this.fields.length < FIELD_TARGET; t++) {
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;

      if (!this._siteQualifies(x, z)) continue;
      if (this.fields.some((f) => Math.hypot(f.x - x, f.z - z) < MIN_SEPARATION)) continue;

      this.fields.push(this._makeField(this.fields.length, x, z, rand));
    }

    // Anything past the fields we actually placed stays scaled to zero.
    for (let i = this.fields.length * CRYSTALS_PER_FIELD; i < this.mesh.count; i++) {
      this._zeroInstance(i);
    }

    for (const f of this.fields) this._unrevealed.add(f);
    this._amplitudeUsed = hm.params.amplitude;
    for (const f of this.fields) this._writeField(f);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Terrain regenerated: the old fields describe a heightfield that is gone. */
  refresh() {
    this.generate();
  }

  update(dt, sunElevation = 90) {
    this._syncAmplitude();

    // Fog is polled rather than checked per field per frame, and only over the
    // fields still waiting to be found.
    this._fogTimer -= dt;
    if (this._fogTimer <= 0) {
      this._fogTimer = FOG_POLL;
      const threshold = this.fog.revealThreshold;
      for (const f of [...this._unrevealed]) {
        if (this.fog.seenAt(f.x, f.z) >= threshold) {
          // One-way: the reveal mask only ever increases, so this never reverses.
          f.revealed = true;
          this._unrevealed.delete(f);
        }
      }
    }

    for (const f of this.fields) {
      if (f.dead) continue;

      if (f.revealed && f.reveal01 < 1) {
        f.reveal01 = Math.min(1, f.reveal01 + dt / REVEAL_EASE);
        this._markDirty(f);
      }

      if (f.stock < f.capacity) {
        // Logistic-ish: a stripped field comes back disproportionately slowly,
        // which is exactly what makes rotating between two fields better than
        // working one to death. Never zero, though — a field that could never
        // recover would eventually strand a base with nothing in reach.
        const fill = f.stock / f.capacity;
        f.stock = Math.min(f.capacity, f.stock + REGEN_RATE * (0.35 + 0.65 * fill) * dt);
        this._markDirty(f);
      }
    }

    if (this._amplitudeDirty) {
      for (const f of this.fields) this._writeField(f);
      this._amplitudeDirty = false;
      this._matrixDirty = true;
    }

    if (this._matrixDirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this._matrixDirty = false;
    }

    // Crystals glow harder as the light fails, so a night haul reads.
    this.material.emissiveIntensity = sunElevation <= 8 ? 1.35 : 0.45;
  }

  /**
   * The closest field worth driving to.
   *
   * @param {object} [opts]
   * @param {number} [opts.minStock] ignore fields thinner than this
   * @param {(field) => boolean} [opts.reject] e.g. a harvester's ban list
   * @param {boolean} [opts.requireOnField] only match a field the point is
   *   actually on. For picking by click, where "nearest anywhere" would accept
   *   a click on empty ground. The autonomous driver wants the opposite — the
   *   nearest field at any distance — so this defaults off.
   */
  nearestTo(x, z, { minStock = 1, reject = null, requireOnField = false } = {}) {
    const seaY = this.heightmap.seaLevelY;
    let best = null;
    let bestD = Infinity;

    for (const f of this.fields) {
      if (f.dead || f.stock < minStock) continue;
      // A drowned field would make setTarget refuse silently and leave the AI
      // looping on somewhere it can never reach.
      if (this.heightmap.heightAt(f.x, f.z) <= seaY) continue;
      if (reject?.(f)) continue;

      const d = Math.hypot(f.x - x, f.z - z);
      if (requireOnField && d > f.radius * PICK_MAX_FACTOR) continue;
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  /** Take up to `amount` from a field. Returns what was actually there. */
  harvest(field, amount) {
    if (!field || field.dead) return 0;
    const took = Math.min(amount, field.stock);
    if (took <= 0) return 0;
    field.stock -= took;
    this._markDirty(field);
    return took;
  }

  /**
   * A pad was poured here. Fields under it are destroyed rather than re-grounded:
   * crystals poking through concrete would read as a bug, and a field the base
   * parks on trivialises the economy this exists to create.
   */
  clearUnder(x, z, radius) {
    for (const f of this.fields) {
      if (f.dead) continue;
      const d = Math.hypot(f.x - x, f.z - z);

      if (d <= radius) {
        f.dead = true;
        f.stock = 0;
        this._markDirty(f);
        this._unrevealed.delete(f);
        continue;
      }
      if (d > radius + f.radius) continue;

      // Clipped at the edge: keeps its stock, loses the crystals that would
      // otherwise stick up through the pad.
      for (const c of f.crystals) {
        if (Math.hypot(f.x + c.lx - x, f.z + c.lz - z) <= radius) c.paved = true;
      }
      this._markDirty(f);
    }
  }

  get totalStock() {
    return this.fields.reduce((sum, f) => sum + (f.dead ? 0 : f.stock), 0);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  // ---- internals ----

  _siteQualifies(x, z) {
    const hm = this.heightmap;
    for (const [sx, sz] of STENCIL) {
      const px = x + sx * FIELD_RADIUS;
      const pz = z + sz * FIELD_RADIUS;
      const n = hm.sampleNormalized(px, pz);
      if (n < BAND_MIN_N || n > BAND_MAX_N) return false;
      if (hm.slopeAt(px, pz) > MAX_SLOPE) return false;
    }
    return true;
  }

  _makeField(id, x, z, rand) {
    const hm = this.heightmap;
    const crystals = [];

    for (let k = 0; k < CRYSTALS_PER_FIELD; k++) {
      // sqrt keeps the scatter even rather than clumping at the centre.
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * FIELD_RADIUS;
      const lx = Math.cos(a) * r;
      const lz = Math.sin(a) * r;
      crystals.push({
        lx,
        lz,
        hN: hm.sampleNormalized(x + lx, z + lz),
        scale: 1.6 + rand() * 2.4,
        girth: 0.5 + rand() * 0.45,
        yaw: rand() * Math.PI * 2,
        tilt: (rand() - 0.5) * 0.35,
        paved: false,
      });
    }

    return {
      id,
      x,
      z,
      hN: hm.sampleNormalized(x, z),
      radius: FIELD_RADIUS,
      stock: FIELD_CAPACITY,
      capacity: FIELD_CAPACITY,
      dead: false,
      revealed: false,
      reveal01: 0,
      first: id * CRYSTALS_PER_FIELD,
      count: CRYSTALS_PER_FIELD,
      crystals,
      _fillQ: -1,
    };
  }

  _syncAmplitude() {
    const a = this.heightmap.params.amplitude;
    if (a === this._amplitudeUsed) return;
    this._amplitudeUsed = a;
    this._amplitudeDirty = true;
  }

  /** Rewrite a field's slice only when its appearance has actually changed. */
  _markDirty(field) {
    const q = Math.round((field.stock / field.capacity) * 64);
    if (q === field._fillQ && field.reveal01 >= 1) return;
    field._fillQ = q;
    this._writeField(field);
    this._matrixDirty = true;
  }

  _writeField(field) {
    const amplitude = this.heightmap.params.amplitude;
    const fill = field.dead ? 0 : field.stock / field.capacity;
    const ease = field.reveal01;

    // Two coupled channels: how many crystals are left standing at all, and how
    // big the survivors are. A field visibly thins *and* shrinks as it drains.
    const live = fill > 0 ? Math.ceil(field.count * fill) : 0;
    const bulk = (0.55 + 0.45 * fill) * ease;

    for (let k = 0; k < field.count; k++) {
      const idx = field.first + k;
      const c = field.crystals[k];

      if (k >= live || c.paved || bulk <= 0) {
        this._zeroInstance(idx);
        continue;
      }

      _pos.set(field.x + c.lx, c.hN * amplitude, field.z + c.lz);
      _euler.set(c.tilt, c.yaw, c.tilt * 0.6);
      _q.setFromEuler(_euler);
      _scl.set(c.girth * bulk, c.scale * bulk, c.girth * bulk);
      _m.compose(_pos, _q, _scl);
      this.mesh.setMatrixAt(idx, _m);
    }

    this.mesh.instanceMatrix.addUpdateRange(field.first * 16, field.count * 16);
  }

  _zeroInstance(idx) {
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(idx, _m);
  }
}
