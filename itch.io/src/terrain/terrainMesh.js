import * as THREE from 'three';
import { createTerrainMaterial, createTerrainDepthMaterial, createTerrainUniforms } from './terrainMaterial.js';

/**
 * Flat XZ grid centred on the origin, with a skirt ring around the border.
 *
 * The grid is authored in world orientation (y = 0, +Y is up) rather than a
 * rotated PlaneGeometry, so the vertex shader can treat object XZ as world XZ
 * and displace along +Y directly.
 *
 * Skirt vertices sit at the same XZ as the border vertices and carry aSkirt = 1;
 * the shader pushes them down after displacement, forming a curtain that hides
 * the cracks where a chunk meets a neighbour at a different LOD.
 */
function createGridGeometry(size, segments) {
  const n = segments + 1;
  const half = size / 2;
  const step = size / segments;

  const vertCount = n * n + 4 * n;
  const positions = new Float32Array(vertCount * 3);
  const skirt = new Float32Array(vertCount);
  const uvs = new Float32Array(vertCount * 2);

  let v = 0;
  const setVertex = (i, j, isSkirt) => {
    positions[v * 3] = -half + i * step;
    positions[v * 3 + 1] = 0;
    positions[v * 3 + 2] = -half + j * step;
    uvs[v * 2] = i / segments;
    uvs[v * 2 + 1] = j / segments;
    skirt[v] = isSkirt;
    return v++;
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) setVertex(i, j, 0);
  }

  const indices = [];
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Perimeter walked counter-clockwise seen from above, so a single winding
  // rule gives every skirt quad an outward-facing normal.
  const perimeter = [];
  for (let i = 0; i < segments; i++) perimeter.push([i, 0]);
  for (let j = 0; j < segments; j++) perimeter.push([segments, j]);
  for (let i = segments; i > 0; i--) perimeter.push([i, segments]);
  for (let j = segments; j > 0; j--) perimeter.push([0, j]);
  perimeter.push(perimeter[0]);

  const gridIndex = ([i, j]) => j * n + i;
  const skirtStart = v;
  for (const p of perimeter) setVertex(p[0], p[1], 1);

  for (let k = 0; k < perimeter.length - 1; k++) {
    const g = gridIndex(perimeter[k]);
    const gNext = gridIndex(perimeter[k + 1]);
    const s = skirtStart + k;
    const sNext = skirtStart + k + 1;
    indices.push(g, sNext, s, g, gNext, sNext);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, v * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs.subarray(0, v * 2), 2));
  geometry.setAttribute('aSkirt', new THREE.BufferAttribute(skirt.subarray(0, v), 1));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(v * 3), 3));
  geometry.setIndex(indices);
  return geometry;
}

export const LOD_SEGMENTS = [64, 32, 16, 8];

/**
 * The terrain: a fixed-size map split into a grid of chunks that share one
 * material. Chunks give the renderer something to frustum-cull, and let distant
 * ground drop to a coarser mesh without touching the near ground.
 */
export class TerrainMesh {
  constructor(heightmap, { chunks = 8, lodDistance = 260 } = {}) {
    this.heightmap = heightmap;
    this.chunkCount = chunks;
    this.lodDistance = lodDistance;

    this.uniforms = createTerrainUniforms(heightmap);
    this.material = createTerrainMaterial(heightmap, this.uniforms);
    this.depthMaterial = createTerrainDepthMaterial(this.uniforms);

    this.group = new THREE.Group();
    this.group.name = 'terrain';

    const size = heightmap.params.size;
    const chunkSize = size / chunks;
    this.chunkSize = chunkSize;

    // One geometry per LOD level, shared by every chunk at that level.
    this.geometries = LOD_SEGMENTS.map((segs) => {
      const g = createGridGeometry(chunkSize, segs);
      // Geometry is flat until the vertex shader displaces it, so the computed
      // bounds would be a zero-height slab and chunks would pop out of view.
      // Expand manually to cover the full displacement range.
      const amp = heightmap.params.amplitude;
      g.boundingBox = new THREE.Box3(
        new THREE.Vector3(-chunkSize / 2, -amp * 0.3, -chunkSize / 2),
        new THREE.Vector3(chunkSize / 2, amp * 1.1, chunkSize / 2)
      );
      g.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(0, amp * 0.4, 0),
        Math.hypot(chunkSize, amp) * 0.75
      );
      return g;
    });

    this.chunks = [];
    for (let j = 0; j < chunks; j++) {
      for (let i = 0; i < chunks; i++) {
        const mesh = new THREE.Mesh(this.geometries[0], this.material);
        mesh.position.set(
          -size / 2 + chunkSize * (i + 0.5),
          0,
          -size / 2 + chunkSize * (j + 0.5)
        );
        mesh.customDepthMaterial = this.depthMaterial;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.userData.lod = 0;
        this.group.add(mesh);
        this.chunks.push(mesh);
      }
    }
  }

  /** Pick a LOD level per chunk from camera distance. Called once per frame. */
  update(camera) {
    const camPos = camera.position;
    for (const chunk of this.chunks) {
      const dx = camPos.x - chunk.position.x;
      const dz = camPos.z - chunk.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      let level = 0;
      while (level < LOD_SEGMENTS.length - 1 && dist > this.lodDistance * (level + 1)) level++;

      if (chunk.userData.lod !== level) {
        chunk.userData.lod = level;
        chunk.geometry = this.geometries[level];
      }
    }
  }

  /**
   * Rebuild after the heightmap changes shape. The DataTexture is recreated by
   * Heightmap.generate(), so the uniform has to be repointed at the new one.
   */
  refresh() {
    this.uniforms.uHeightmap.value = this.heightmap.texture;
    this.uniforms.uAmplitude.value = this.heightmap.params.amplitude;
    this.uniforms.uSeaLevel.value = this.heightmap.params.seaLevel;
    this.uniforms.uTexel.value = 1 / this.heightmap.params.resolution;
  }

  get triangleCount() {
    return this.chunks.reduce((sum, c) => sum + c.geometry.index.count / 3, 0);
  }

  dispose() {
    this.geometries.forEach((g) => g.dispose());
    this.material.dispose();
    this.depthMaterial.dispose();
  }
}
