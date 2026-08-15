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

/**
 * Finds a dry-land spawn point on the map's edge, along the angle the camera
 * is currently facing (so a spawned vehicle appears where the player is
 * looking, not on an arbitrary fixed side of the map).
 *
 * The continental falloff in Heightmap means the literal boundary is usually
 * ocean, so this starts at the edge and steps inward until it clears the
 * waterline — the closest-to-edge point that is still land.
 */
export function findEdgeSpawnPoint(heightmap, camera, target = new THREE.Vector3()) {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  let angle = Math.atan2(forward.z, forward.x);
  if (!Number.isFinite(angle)) angle = 0;
  return findEdgeSpawnPointAtAngle(heightmap, angle, target);
}

// Comfortably below the base station's own maxClimbGrade (0.5) — the
// heaviest, least capable thing this ever has to spawn — not right up against
// it: a spot that only just clears the limit still reads as "immediately
// blocked" to the vehicle's own much shorter, sharper probe (2.5 units ahead
// along its current heading, vehicleController.js's GRADE_PROBE) the instant
// local terrain noise the wider average below smoothed over pokes through.
const SPAWN_MAX_GRADE = 0.3;
// Two ranges in eight directions, not the vehicle's own single 2.5-unit
// forward probe: this has no heading to be "ahead" of yet, and needs to know
// whether *some* escape direction exists, not just the one it happens to be
// facing. The short range catches sharp local bumps the long one averages
// away; both must clear the limit for the spot to count as gentle.
const GRADE_PROBE_DISTS = [4, 12];
const GRADE_PROBE_DIRS = 8;

function localGrade(heightmap, x, z) {
  let worst = 0;
  for (let i = 0; i < GRADE_PROBE_DIRS; i++) {
    const angle = (i / GRADE_PROBE_DIRS) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    for (const dist of GRADE_PROBE_DISTS) {
      const h0 = heightmap.heightAt(x, z);
      const h1 = heightmap.heightAt(x + dx * dist, z + dz * dist);
      worst = Math.max(worst, Math.abs(h1 - h0) / dist);
    }
  }
  return worst;
}

/**
 * The same coast-finding march, but along an angle the caller chooses rather
 * than the one the camera happens to face. Multi-team match setup needs to
 * place N bases on N specific bearings; the camera has no say in that.
 */
export function findEdgeSpawnPointAtAngle(heightmap, angle, target = new THREE.Vector3()) {
  const { size } = heightmap.params;

  const dirX = Math.cos(angle);
  const dirZ = Math.sin(angle);
  const maxRadius = size * 0.5 - 2;
  const step = size / 400;

  // Two passes: first insist on gentle ground, so a heavy vehicle spawned
  // here is never stranded on the very first tick. If nothing on this
  // bearing is ever both dry *and* gentle (a genuinely cliff-bound coastline),
  // fall back to the first merely-dry point — landing somewhere a slow
  // vehicle has to fight rather than nowhere at all.
  let firstDry = null;
  for (let r = maxRadius; r > 0; r -= step) {
    const x = dirX * r;
    const z = dirZ * r;
    if (heightmap.heightAt(x, z) <= heightmap.seaLevelY) continue;
    if (!firstDry) firstDry = { x, z };
    if (localGrade(heightmap, x, z) <= SPAWN_MAX_GRADE) {
      return { point: target.set(x, heightmap.heightAt(x, z), z), heading: Math.atan2(-dirZ, -dirX) };
    }
  }
  if (firstDry) {
    return {
      point: target.set(firstDry.x, heightmap.heightAt(firstDry.x, firstDry.z), firstDry.z),
      heading: Math.atan2(-dirZ, -dirX),
    };
  }

  // Degenerate fallback (e.g. a fully-flooded map): spawn at the centre.
  return { point: target.set(0, heightmap.heightAt(0, 0), 0), heading: 0 };
}

/**
 * Coastal start positions for an all-versus-all match, one per team.
 *
 * Equal *compass angles* are not equal *distances* on an irregular coastline:
 * two bearings can both march inland into the same bay and land the teams on
 * top of each other. So each bearing is nudged within its own slice until the
 * point it finds clears everything already placed, and the best candidate is
 * kept if none fully clears — a slightly tight start beats no start at all.
 *
 * @param {number} count how many teams
 * @param {number} [minSeparation] world units teams should be apart
 * @param {number} [phase] rotates the whole ring, so successive matches on one
 *   island do not always start on the same beaches
 */
export function findTeamSpawnPoints(heightmap, count, { minSeparation = 260, phase = 0 } = {}) {
  const placed = [];
  const slice = (Math.PI * 2) / count;
  // Odd count so the nudges are symmetric about the slice's own centre.
  const NUDGES = [0, 0.18, -0.18, 0.34, -0.34, 0.48, -0.48];

  for (let i = 0; i < count; i++) {
    const centre = phase + i * slice;
    let best = null;
    let bestClearance = -Infinity;

    for (const nudge of NUDGES) {
      // Never let a nudge cross into a neighbouring slice.
      const angle = centre + nudge * slice;
      const found = findEdgeSpawnPointAtAngle(heightmap, angle, new THREE.Vector3());
      const clearance = placed.length
        ? Math.min(...placed.map((p) => Math.hypot(p.point.x - found.point.x, p.point.z - found.point.z)))
        : Infinity;

      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = found;
      }
      if (clearance >= minSeparation) break; // good enough, stop nudging
    }

    placed.push(best);
  }

  return placed;
}

/**
 * Finds a dry-land spawn point near an existing vehicle, so a newly unlocked
 * vehicle arrives beside the one that unlocked it rather than at the map edge
 * — and, incidentally, on ground the fog of war has already revealed, since
 * `maxRadius` is expected to stay inside the discovering vehicle's sight
 * radius.
 *
 * Searches a ring around `origin`: increasing radius steps from `minRadius`
 * to `maxRadius`, a spread of angles at each radius. Falls back to
 * `findEdgeSpawnPoint` if nothing in the ring is land — the origin vehicle
 * pinned against a cliff or a sliver island is the only realistic case.
 */
export function findSpawnPointNear(
  heightmap,
  origin,
  {
    minRadius,
    maxRadius,
    camera,
    target = new THREE.Vector3(),
    requireGentleGrade = false,
    isValid = null,
    // Rotates the whole sweep. This scan is deterministic — same origin and
    // radii in, same point out — which is what a caller wants right up until
    // the point it returns is one the vehicle cannot actually reach, at which
    // point asking again is pointless. An offset lets such a caller ask for a
    // genuinely different answer. Default 0 leaves every existing caller's
    // result bit-identical.
    angleOffset = 0,
  }
) {
  const radiusStep = Math.max(2, (maxRadius - minRadius) / 6);
  const angleCount = 12;
  // Same two-tier idea as findEdgeSpawnPointAtAngle: prefer a spot that
  // passes the real acceptance test, but remember the first merely-dry one
  // in case nothing in the ring clears it at all.
  let firstDry = null;

  for (let r = minRadius; r <= maxRadius; r += radiusStep) {
    for (let i = 0; i < angleCount; i++) {
      // Offset the angle sweep per ring so successive radii don't all sample
      // the same compass points and miss a valid gap between them.
      const angle = (i / angleCount) * Math.PI * 2 + r * 0.618 + angleOffset;
      const x = origin.x + Math.cos(angle) * r;
      const z = origin.z + Math.sin(angle) * r;
      if (heightmap.heightAt(x, z) <= heightmap.seaLevelY) continue;
      const heading = Math.atan2(-Math.sin(angle), -Math.cos(angle));
      // A caller-supplied predicate is the real acceptance test (e.g.
      // terraform.canDeployAt, which samples water clearance across a whole
      // pad radius — a narrow local-grade probe can pass while the actual
      // pad still doesn't fit). `requireGentleGrade` is the cheaper
      // approximation for callers with no such test of their own.
      const accepted = isValid ? isValid(x, z) : !requireGentleGrade || localGrade(heightmap, x, z) <= SPAWN_MAX_GRADE;
      if (accepted) {
        return { point: target.set(x, heightmap.heightAt(x, z), z), heading };
      }
      if (!firstDry) firstDry = { x, z, heading };
    }
  }

  if ((requireGentleGrade || isValid) && firstDry) {
    return {
      point: target.set(firstDry.x, heightmap.heightAt(firstDry.x, firstDry.z), firstDry.z),
      heading: firstDry.heading,
    };
  }
  return findEdgeSpawnPoint(heightmap, camera, target);
}
