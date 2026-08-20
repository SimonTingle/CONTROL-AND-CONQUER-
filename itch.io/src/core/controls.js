import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';

/**
 * RTS-style camera: drag to pan, wheel to zoom, right-drag to orbit.
 *
 * MapControls already implements exactly that gesture set, so this wraps it and
 * adds the two things a terrain game needs on top: the target is kept inside the
 * map bounds, and the camera is never allowed to sink below the ground.
 */
export function createCameraControls(camera, domElement, heightmap) {
  const controls = new MapControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minDistance = 12;
  controls.maxDistance = heightmap.params.size * 0.9;
  controls.maxPolarAngle = Math.PI * 0.49; // stop just short of the horizon
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 1.0;

  const bound = heightmap.params.size * 0.5;

  controls.addEventListener('change', () => {
    const t = controls.target;
    t.x = THREE.MathUtils.clamp(t.x, -bound, bound);
    t.z = THREE.MathUtils.clamp(t.z, -bound, bound);
    t.y = heightmap.heightAt(t.x, t.z);

    // Keep a little air under the camera so it never clips through a ridge.
    const groundY = heightmap.heightAt(camera.position.x, camera.position.z);
    const minY = Math.max(groundY, heightmap.seaLevelY) + 6;
    if (camera.position.y < minY) camera.position.y = minY;
  });

  return controls;
}
