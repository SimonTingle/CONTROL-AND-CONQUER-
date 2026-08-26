import * as THREE from 'three';
import { Heightmap } from '../terrain/heightmap.js';
import { TerrainMesh } from '../terrain/terrainMesh.js';
import { Water } from '../terrain/water.js';
import { Atmosphere } from '../sky/atmosphere.js';
import { FogTerrain, FogMask } from './fogOfWar.js';
import { TrackMask } from './trackMask.js';
import { ScorchMask } from '../render/scorchMask.js';
import { Blooms } from '../terrain/blooms.js';

/**
 * Assembles the world and owns the one rule that everything else depends on:
 * the heightmap is the single source of truth. The GPU displaces from it, the
 * water reads its depth from it, and gameplay will query it for placement and
 * pathing. Regenerating it is the only way terrain shape ever changes.
 */
export class World {
  constructor(renderer) {
    this.renderer = renderer;

    this.scene = new THREE.Scene();

    this.heightmap = new Heightmap();
    this.terrain = new TerrainMesh(this.heightmap, { chunks: 8 });
    this.scene.add(this.terrain.group);

    this.water = new Water(this.heightmap);
    this.scene.add(this.water.mesh);

    this.atmosphere = new Atmosphere(this.scene, renderer, {
      mapSize: this.heightmap.params.size,
    });

    // Land data is shared by every team's mask; only what each has *seen*
    // differs. AI teams get their own masks from match setup — this one is the
    // player's, and is the only one that needs a GPU texture.
    this.fogTerrain = new FogTerrain(this.heightmap);
    this.fog = new FogMask(this.fogTerrain, { texture: true });
    // Every mask in play, so a regenerate can wipe them all. Match setup
    // pushes the AI teams' masks here; the player's is always index 0.
    this.fogMasks = [this.fog];

    // One mask, sampled by both surfaces. The texture object is never replaced
    // (unlike the heightmap's), so these two assignments are the only ones
    // ever needed — regeneration rewrites the mask in place.
    this.terrain.uniforms.uFogMask.value = this.fog.texture;
    this.water.uniforms.uFogMask.value = this.fog.texture;

    // Resource scatter. Needs the *player's* fog specifically — a field must
    // not glow through ground the player has not explored, regardless of what
    // an AI team happens to have scouted.
    this.blooms = new Blooms(this.heightmap, this.fog, { seed: this.heightmap.params.seed });
    this.scene.add(this.blooms.mesh);

    // Tire tracks — one shared mask, not per-team; unlike fog there's nothing
    // team-private about where a vehicle has driven.
    this.trackMask = new TrackMask(this.heightmap.params.size);
    this.terrain.uniforms.uTrackMask.value = this.trackMask.texture;

    // Scorch marks — shared for the same reason tracks are, and assigned once
    // for the same reason: the texture object is never replaced, so a
    // regenerate rewrites the mask in place rather than needing a re-point.
    this.scorchMask = new ScorchMask(this.heightmap.params.size);
    this.terrain.uniforms.uScorchMask.value = this.scorchMask.texture;
  }

  /**
   * Rebuild the heightfield. Only shape parameters need this; colour, sun and
   * fog changes are uniform writes and take effect immediately.
   */
  regenerate(params = {}) {
    const t0 = performance.now();
    this.heightmap.generate(params);
    this.terrain.refresh();
    this.water.updateLevel();
    // Resample the shared land data once, then wipe what every team had seen —
    // it described a heightfield that no longer exists.
    this.fogTerrain.refresh();
    for (const mask of this.fogMasks) mask.reset();
    this.trackMask.clear(); // describes ground that no longer has this shape
    this.scorchMask.clear(); // ditto — and the craters under them are gone too
    this.blooms.refresh();
    this.lastGenerateMs = performance.now() - t0;
    return this.lastGenerateMs;
  }

  /**
   * @param {import('./tickProfiler.js').TickProfiler} [profiler] optional —
   *   when given, breaks this call down into its own sub-timings rather than
   *   leaving the caller with just one lump "world" number. Passed in rather
   *   than a module singleton since perfHud follows the same
   *   caller-owns-the-instance pattern.
   */
  update(dt, camera, profiler) {
    const time = profiler ? (name, fn) => profiler.time(name, fn) : (_, fn) => fn();
    // First: blooms below reads the elevation this call just produced, not
    // last frame's.
    time('world.atmosphere', () => this.atmosphere.update(dt));
    time('world.terrain', () => this.terrain.update(camera));
    time('world.water', () => this.water.update(dt));
    // Sun elevation passed in rather than reached for, mirroring how the fleet
    // takes `headlightsOn` from its caller instead of knowing about the sky.
    time('world.blooms', () => this.blooms.update(dt, this.atmosphere.params.elevation));
  }
}
