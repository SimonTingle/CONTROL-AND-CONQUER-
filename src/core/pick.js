import * as THREE from 'three';

/**
 * Screen point -> ground position.
 *
 * A normal THREE.Raycaster is useless here: the terrain geometry on the CPU is a
 * flat grid, and all the shape lives in the vertex shader. So instead we march
 * the ray against the CPU heightfield — the same data the GPU displaces from —
 * and refine the crossing with a short binary search.
 *
 * This is the hook selection, build placement and unit orders will hang off.
 */
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

export function pickTerrain(clientX, clientY, domElement, camera, heightmap, target = new THREE.Vector3()) {
  const rect = domElement.getBoundingClientRect();
  _ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _ray.setFromCamera(_ndc, camera);
  return raymarchTerrain(_ray.ray, heightmap, target);
}

export function raymarchTerrain(ray, heightmap, target = new THREE.Vector3()) {
  const { size, amplitude } = heightmap.params;
  const maxDist = size * 2;
  const coarse = size / 256;

  let t = 0;
  let prevT = 0;
  let prevAbove = ray.origin.y - heightmap.heightAt(ray.origin.x, ray.origin.z);

  while (t < maxDist) {
    // Step proportional to height above the ground — long strides up high,
    // fine steps as the ray approaches the surface.
    const step = Math.max(coarse, Math.abs(prevAbove) * 0.6);
    t += step;

    const px = ray.origin.x + ray.direction.x * t;
    const py = ray.origin.y + ray.direction.y * t;
    const pz = ray.origin.z + ray.direction.z * t;

    if (Math.abs(px) > size || Math.abs(pz) > size || (py > amplitude * 1.5 && ray.direction.y > 0)) {
      return null;
    }

    const above = py - heightmap.heightAt(px, pz);
    if (above <= 0) {
      // Bisect between the last point above the surface and this one below it.
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) * 0.5;
        const mx = ray.origin.x + ray.direction.x * mid;
        const my = ray.origin.y + ray.direction.y * mid;
        const mz = ray.origin.z + ray.direction.z * mid;
        if (my - heightmap.heightAt(mx, mz) > 0) lo = mid;
        else hi = mid;
      }
      const hit = (lo + hi) * 0.5;
      return target.set(
        ray.origin.x + ray.direction.x * hit,
        ray.origin.y + ray.direction.y * hit,
        ray.origin.z + ray.direction.z * hit
      );
    }

    prevT = t;
    prevAbove = above;
  }

  return null;
}

/** Can a structure sit here? The rule the RTS placement grid will use. */
export function isBuildable(heightmap, x, z, maxSlope = 0.35) {
  if (Math.abs(x) > heightmap.params.size / 2 || Math.abs(z) > heightmap.params.size / 2) return false;
  if (heightmap.heightAt(x, z) <= heightmap.seaLevelY) return false;
  return heightmap.slopeAt(x, z) <= maxSlope;
}
