/**
 * Free the GPU resources under a mesh group before it's dropped for good.
 *
 * Every vehicle and structure mesh is built fresh per instance (see
 * buildVehicleMesh/buildStructureMesh — no module-level cache), so nothing is
 * shared *across* instances and disposing one can never blank another. Within
 * one instance's own group, though, a single geometry is often reused several
 * times (four wheels sharing one `wheelGeo`) — the Sets here dedupe so that
 * doesn't double-dispose.
 */
export function disposeObject3D(root) {
  const seenGeometries = new Set();
  const seenMaterials = new Set();

  root.traverse((node) => {
    if (node.geometry && !seenGeometries.has(node.geometry)) {
      seenGeometries.add(node.geometry);
      node.geometry.dispose();
    }

    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const mat of materials) {
      if (seenMaterials.has(mat)) continue;
      seenMaterials.add(mat);
      // Any texture the material holds dies with it too, or a destroyed unit
      // leaks GPU texture memory even after its geometry and material are gone.
      for (const key in mat) {
        const value = mat[key];
        if (value && value.isTexture) value.dispose();
      }
      mat.dispose();
    }
  });
}
