/**
 * Craters — permanent terrain damage where a shell hit the ground.
 *
 * This works exactly the way `terraform.js`'s construction pads work, and for
 * exactly the same reason: the heightmap is one field with two consumers, so
 * writing into `heightmap.data` and calling `syncTexture` re-uploads it, and because the terrain shader derives its normals
 * analytically from that same texture — and shares the displacement with the
 * depth material — a fresh crater gets correct shading and correct shadows
 * with no extra work. Every CPU consumer (wheel grounding, line of sight,
 * picking, camera clamps) reads the array directly and follows for free.
 *
 * The two things that do *not* follow are the same two terraform has to patch
 * by hand: the fog of war's cached per-cell heights, and NavGrid's cached flow
 * fields. Both are handled in `dig`.
 *
 * ## Why a list of records rather than a modified heightfield
 *
 * A crater is a runtime edit and is therefore not reproducible from the
 * terrain seed. The alternative to recording it would be saving the whole
 * heightfield — 513², a megabyte of floats, in every save. Instead each crater
 * is four numbers, and `restore` replays the identical arithmetic onto freshly
 * generated terrain. This is exact, because at a given depth the result
 * depends only on the ground underneath and the crater's own geometry.
 *
 * **Records are append-only, in creation order.** Overlapping craters compose
 * additively — a point under two craters is as deep as the sum of both, clamped
 * once at the sea floor rather than per-crater — and replaying them in the
 * order they were dug is what makes a loaded world identical to the one that
 * was saved. Nothing is ever removed from the middle of the list.
 *
 * This also means nothing is ever dropped from the list, which is worth
 * stating plainly because the obvious bound — keep only the most recent N — would silently
 * break that guarantee: a save that had forgotten its oldest craters would
 * replay to a *different heightfield* than the one it was taken from, and in
 * an online match that is a desync rather than a cosmetic difference. Growth
 * is bounded at the source instead, by `MIN_CRATER_DAMAGE`: light weapons
 * never dig at all, so sustained machine-gun fire cannot erode the map or the
 * save. A long match with heavy weapons produces a few thousand records, on
 * the order of a hundred kilobytes — comparable to the track mask, which is
 * already saved.
 */

/**
 * Shells below this damage scuff the ground (a scorch mark, see
 * render/scorchMask.js) but do not move it. Without a floor here every
 * autocannon burst would dig, and a firefight would leave the ground looking
 * like it had been ploughed.
 */
export const MIN_CRATER_DAMAGE = 12;

/** Damage that produces a nominal crater; radius and depth scale from here. */
const REFERENCE_DAMAGE = 20;
const BASE_RADIUS = 3.4; // world units at reference damage
const BASE_DEPTH = 0.85; // world units at reference damage

/**
 * Hard caps. A single very heavy shell should leave a noticeable hole, not a
 * canyon — a crater deep enough to trap a vehicle turns a visual flourish into
 * a movement bug.
 */
const MAX_RADIUS = 9;
const MAX_DEPTH = 2.4;

/**
 * How far above sea level a crater floor must stay, in normalised height.
 * Digging below the water plane would punch a pond into a hillside and, worse,
 * flip ground that vehicles were driving on into ground they cannot enter.
 * Matches terraform.js's `SEA_MARGIN` for the same reason.
 */
const SEA_MARGIN = 0.02;

export class Craters {
  /**
   * @param {object} world the World — for `heightmap`, `fogTerrain` and
   *   `blooms`, the same three things terraform reaches for
   */
  constructor(world) {
    this.world = world;
    /** Append-only, in creation order. Saved and replayed verbatim. */
    this.records = [];
  }

  get heightmap() {
    return this.world.heightmap;
  }

  /**
   * Crater geometry for a shell of a given damage, or null if it is too light
   * to move any ground.
   *
   * Split out and exported so the tests can assert the scaling curve without
   * constructing a world, and so the scorch mask can size itself off the same
   * numbers rather than inventing a second scale that drifts from this one.
   */
  static shapeFor(damage, weaponTier = 0) {
    if (!(damage >= MIN_CRATER_DAMAGE)) return null;
    // Square root, not linear: doubling damage should widen the hole
    // noticeably without quadrupling the area it removes.
    const scale = Math.sqrt(damage / REFERENCE_DAMAGE);
    // The team's weapon upgrade shows up in the ground it tears up, not just
    // in the damage number — a small, deliberate bit of visible feedback for
    // an upgrade that is otherwise invisible outside the numbers.
    const tierBoost = 1 + 0.12 * weaponTier;
    return {
      radius: Math.min(MAX_RADIUS, BASE_RADIUS * scale * tierBoost),
      depth: Math.min(MAX_DEPTH, BASE_DEPTH * scale * tierBoost),
    };
  }

  /**
   * Dig a crater and record it.
   *
   * @returns {object|null} the record, or null if nothing was dug
   */
  dig(x, z, damage, weaponTier = 0) {
    const shape = Craters.shapeFor(damage, weaponTier);
    if (!shape) return null;
    const record = { x, z, radius: shape.radius, depth: shape.depth };
    this.records.push(record);
    this._apply(record);

    // The same "the world changed shape here" housekeeping terraform does on
    // pad completion. Both are cheap and both are wrong to skip: without the
    // fog patch the explored-percentage readout drifts, and without the
    // version bump a cached flow field routes vehicles through a hole that
    // is now too steep to climb.
    this.world.fogTerrain?.patchTerrain(x, z, record.radius);
    this.heightmap.terrainVersion++;
    return record;
  }

  /**
   * Replay a saved crater onto freshly generated terrain. Deliberately does
   * *not* patch fog or bump the terrain version: `deserialize` regenerates the
   * world wholesale afterwards, so doing it per crater would be thousands of
   * redundant patches on a load.
   */
  restore(saved) {
    const record = {
      x: saved.x,
      z: saved.z,
      radius: saved.radius,
      depth: saved.depth,
    };
    this.records.push(record);
    this._apply(record);
    return record;
  }

  /**
   * Lower the heightfield inside one crater.
   *
   * The profile is a smooth bowl rather than a cylinder: full depth at the
   * centre easing to nothing at the rim, so the edge blends into the terrain
   * instead of leaving a circular cliff — the same shape, and the same reason,
   * as terraform's pad blend.
   */
  _apply(record) {
    const hm = this.heightmap;
    const p = hm.params;
    const res = p.resolution;
    const size = p.size;
    // Depth is authored in world units because that is the only scale a reader
    // can reason about; the heightfield is normalised, so convert once here.
    const depthN = record.depth / p.amplitude;
    const floorN = p.seaLevel + SEA_MARGIN;

    const toIdx = (w) => (w / size + 0.5) * (res - 1);
    const i0 = Math.max(0, Math.floor(toIdx(record.x - record.radius)));
    const i1 = Math.min(res - 1, Math.ceil(toIdx(record.x + record.radius)));
    const j0 = Math.max(0, Math.floor(toIdx(record.z - record.radius)));
    const j1 = Math.min(res - 1, Math.ceil(toIdx(record.z + record.radius)));

    for (let j = j0; j <= j1; j++) {
      const wz = (j / (res - 1) - 0.5) * size;
      for (let i = i0; i <= i1; i++) {
        const wx = (i / (res - 1) - 0.5) * size;
        const d = Math.hypot(wx - record.x, wz - record.z);
        if (d >= record.radius) continue;
        // 1 at the centre, 0 at the rim, with zero gradient at both ends.
        const t = d / record.radius;
        const bowl = 1 - t * t * (3 - 2 * t);
        const idx = j * res + i;
        // Never below the water margin — see SEA_MARGIN. This clamp is what
        // makes crater application order-dependent, which is why the record
        // list preserves order.
        hm.data[idx] = Math.max(floorN, hm.data[idx] - depthN * bowl);
      }
    }
    hm.syncTexture(i0, j0, i1, j1);
  }

  /** Terrain regenerated or a new match started: these describe ground that is gone. */
  clear() {
    this.records.length = 0;
  }
}
