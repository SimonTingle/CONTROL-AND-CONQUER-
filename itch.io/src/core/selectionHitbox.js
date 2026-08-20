import * as THREE from 'three';

/**
 * An invisible mesh that exists only to be raycast-hit.
 *
 * Three.js raycasting does not consult `.visible` — `Raycaster.intersectObject`
 * only walks `object.children` and calls each mesh's own `.raycast()` — so a
 * mesh with `visible = false` is fully excluded from rendering (and shadows)
 * while remaining a solid target for pickSelectable's existing convention of
 * walking up from whatever was hit to the nearest `userData.selectable`
 * (main.js's pickSelectable — set once on each instance's `group`, never on
 * the hitbox itself, so this needs no changes there).
 *
 * Exists because vehicles and structures are built from several small
 * decorative sub-meshes with real gaps between them — a click anywhere in
 * that empty local space reported no hit at all before this. See the
 * "invisible selection hitboxes" plan for the specific offenders.
 */
export function addSelectionHitbox(group, geometry) {
  const hitbox = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  hitbox.visible = false;
  group.add(hitbox);
  return hitbox;
}
