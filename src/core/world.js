import * as THREE from 'three';
import { Heightmap } from '../terrain/heightmap.js';
import { TerrainMesh } from '../terrain/terrainMesh.js';
import { Water } from '../terrain/water.js';
import { Atmosphere } from '../sky/atmosphere.js';

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
    this.lastGenerateMs = performance.now() - t0;
    return this.lastGenerateMs;
  }

  update(dt, camera) {
    this.terrain.update(camera);
    this.water.update(dt);
  }
}
