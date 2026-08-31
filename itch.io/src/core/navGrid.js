/**
 * Coarse global routing for AI army movement and harvesters alike.
 *
 * `vehicleController`'s `driveToTarget` and `aiCommander`'s `ADVANCE_DETOURS`
 * fan are both purely *local*: they know how to fail a straight line and try
 * a slightly different heading, but have no notion of "go around the
 * mountain." On an irregular island that means armies converge on a shared
 * blocked pocket and never actually meet — verified directly against a live
 * match before this existed.
 *
 * This adds the missing *global* layer without touching the local one: a
 * flow field over a coarse passability grid, queried one step at a time.
 * Nothing here drives a vehicle — `nextWaypoint` just answers "which way
 * from here", and the caller still hands that off to the ordinary
 * `setTarget`/`driveToTarget` machinery, which keeps doing exactly what it
 * already does (grade checks, steering, yielding to traffic) for that one
 * short leg.
 *
 * Passability is terrain grade first, then (when a `structures` reference is
 * supplied) every standing structure's footprint on top — a harvester driving
 * straight through the armed factory on its way to a crystal field was the
 * same "no notion of what's in the way" gap the army-movement case above
 * describes, just for buildings instead of mountains.
 *
 * One exemption this needs, applied in `_solve` rather than at build time: a
 * structure's footprint must never make its own cell unreachable as a *goal*,
 * or a harvester ordered to dock there could never solve a route to its own
 * destination — exactly the "to and from the depot" half of the problem this
 * exists to fix. It still blocks that same cell for anyone routing *through*
 * it toward somewhere else. Two separate passability arrays carry this:
 * `_terrainPassable` (dry land only, used solely to reject an underwater
 * goal) and `_passable` (terrain and structures both, used for every edge
 * during solving) — folding the goal-cell exemption into `_passable` itself
 * would have let a genuinely underwater goal slip through as "reachable"
 * too, which is a different failure than the one this is fixing.
 */

// World units per grid cell. ~1024/24 ≈ 43 cells per axis, ~1,850 cells
// total — cheap enough to solve with a fresh Dijkstra per unique goal.
const CELL_SIZE = 24;

// One shared threshold for every ground vehicle, rather than a grid per
// vehicle class. The catalog's four maxClimbGrade values run 0.5-0.8; using
// the most conservative (base-station's 0.5) means the grid is always safe
// to drive, at the cost of occasionally routing a more capable vehicle (the
// gun platform, 0.58) around a slope it could technically have climbed.
// Correct-but-conservative beats four caches for one grid this coarse.
const MAX_CLIMB_GRADE = 0.5;

// 8 directions: the four axis neighbors plus diagonals, so a path can cut
// corners instead of stair-stepping. Distances are cell-size multiples,
// pre-scaled by CELL_SIZE where the graph is actually built.
const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

// _attackTarget() can shift goal cells tick to tick as scouting reveals more
// of the enemy, and each distinct goal cell is its own Dijkstra solve. Most
// callers share a handful of stable goals (the advance point, a couple of
// live targets), so this is a generous ceiling, not a tight budget — it
// exists so a fast-moving fight can't grow the cache without bound, not to
// pinch the common case.
const MAX_CACHED_FIELDS = 24;

export class NavGrid {
  /**
   * @param {import('../terrain/heightmap.js').Heightmap} heightmap
   * @param {import('../structures/structures.js').StructureController} [structures]
   *   Optional — callers with no notion of structures (none exist today, but
   *   nothing requires one) get the original terrain-only grid.
   */
  constructor(heightmap, structures = null) {
    this.heightmap = heightmap;
    this.structures = structures;
    this.cols = 0;
    this.rows = 0;
    this.originX = 0;
    this.originZ = 0;
    /** Cached flow fields, keyed by goal cell index. Cleared on terrainVersion/structuresVersion change. */
    this._cache = new Map();
    this._builtForVersion = -1;
    this._builtForStructuresVersion = -1;
    this._build();
  }

  _build() {
    const p = this.heightmap.params;
    this.cols = Math.max(2, Math.round(p.size / CELL_SIZE));
    this.rows = this.cols;
    this.originX = -p.size / 2;
    this.originZ = -p.size / 2;

    const n = this.cols * this.rows;
    const height = new Float32Array(n);
    const terrainPassable = new Uint8Array(n); // above sea level; edge climbability is checked per-edge, not stored here
    const seaLevelY = this.heightmap.seaLevelY;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const { x, z } = this._cellCenter(col, row);
        const h = this.heightmap.heightAt(x, z);
        const idx = row * this.cols + col;
        height[idx] = h;
        terrainPassable[idx] = h > seaLevelY ? 1 : 0;
      }
    }

    // Structures block routing on top of terrain — every cell whose center
    // falls inside a standing structure's footprint radius is marked
    // impassable here, including that structure's own home cell. Reaching a
    // structure as a *destination* is handled separately, in `_solve` — see
    // this file's header for why that exemption belongs there and not here.
    const passable = terrainPassable.slice();
    if (this.structures) {
      for (const inst of this.structures.instances) {
        if (inst.dead) continue;
        const footprint = inst.def.footprint ?? 0;
        if (footprint <= 0) continue;
        const cellRadius = Math.ceil(footprint / CELL_SIZE);
        const homeCol = Math.floor((inst.x - this.originX) / CELL_SIZE);
        const homeRow = Math.floor((inst.z - this.originZ) / CELL_SIZE);
        for (let dr = -cellRadius; dr <= cellRadius; dr++) {
          for (let dc = -cellRadius; dc <= cellRadius; dc++) {
            const col = homeCol + dc;
            const row = homeRow + dr;
            if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) continue;
            const { x, z } = this._cellCenter(col, row);
            if (Math.hypot(x - inst.x, z - inst.z) <= footprint) {
              passable[row * this.cols + col] = 0;
            }
          }
        }
      }
    }

    this._height = height;
    this._terrainPassable = terrainPassable;
    this._passable = passable;
    this._cache.clear();
    this._builtForVersion = this.heightmap.terrainVersion;
    this._builtForStructuresVersion = this.structures?.version ?? -1;
  }

  _cellCenter(col, row) {
    return {
      x: this.originX + (col + 0.5) * CELL_SIZE,
      z: this.originZ + (row + 0.5) * CELL_SIZE,
    };
  }

  _cellOf(x, z) {
    const col = Math.floor((x - this.originX) / CELL_SIZE);
    const row = Math.floor((z - this.originZ) / CELL_SIZE);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  /** Rebuild if the terrain has been edited (heightmap.terrainVersion) or a
   * structure has been built/destroyed (structures.version) since the grid
   * was solved. Cheap to call every query; almost always a no-op. */
  _refreshIfStale() {
    if (
      this.heightmap.terrainVersion !== this._builtForVersion ||
      (this.structures?.version ?? -1) !== this._builtForStructuresVersion
    ) {
      this._build();
    }
  }

  /**
   * Cost to travel from cell `from` to its neighbor `to`, or `Infinity` if
   * the edge cannot be driven. Downhill and flat are always passable —
   * matches `readGrade`'s own uphill-only cap in vehicleController.js.
   *
   * `goalCell` is `to`'s passability exemption: entering the solve's own goal
   * is always allowed regardless of `_passable`, which is what lets a route
   * end at a structure's dock without that same structure blocking anyone
   * routing *through* the same cell on the way to somewhere else. See this
   * file's header.
   */
  _edgeCost(from, to, dist, goalCell) {
    if (to !== goalCell && !this._passable[to]) return Infinity;
    const rise = this._height[to] - this._height[from];
    if (rise <= 0) return dist;
    const grade = rise / (dist * CELL_SIZE);
    return grade <= MAX_CLIMB_GRADE ? dist : Infinity;
  }

  /**
   * Reverse Dijkstra from the goal cell, over edges run backwards — so the
   * result answers "what's the best *next* cell" for every reachable cell in
   * one pass, which is exactly what an entire army converging on the same
   * point needs. One solve serves every unit heading there, not one per unit.
   */
  _solve(goalCell) {
    const n = this.cols * this.rows;
    const dist = new Float32Array(n).fill(Infinity);
    const next = new Int32Array(n).fill(-1); // best neighbor to step to, per cell
    dist[goalCell] = 0;

    // A small binary-heap-free approach is fine at ~1,850 nodes: a sorted
    // insert queue would be worse, but a plain array scan is simplest and
    // this runs once per unique goal, not per frame.
    const visited = new Uint8Array(n);
    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
      }
      if (u === -1) break; // everything left is unreachable
      visited[u] = 1;

      const urow = Math.floor(u / this.cols);
      const ucol = u % this.cols;
      for (const [dc, dr, dm] of NEIGHBORS) {
        const vcol = ucol + dc;
        const vrow = urow + dr;
        if (vcol < 0 || vrow < 0 || vcol >= this.cols || vrow >= this.rows) continue;
        const v = vrow * this.cols + vcol;
        if (visited[v]) continue;
        // Edge direction is v -> u (we're walking the graph backwards from
        // the goal), so climbability is checked in that direction.
        const cost = this._edgeCost(v, u, dm, goalCell);
        if (cost === Infinity) continue;
        const nd = dist[u] + cost;
        if (nd < dist[v]) {
          dist[v] = nd;
          next[v] = u; // stepping from v toward the goal means stepping to u
        }
      }
    }

    return { dist, next };
  }

  /**
   * The next waypoint to drive toward on the route from (x, z) to (goalX,
   * goalZ), or `null` if there is no route (goal unreachable, off the map,
   * or underwater) — callers fall back to their own local logic in that case.
   */
  nextWaypoint(x, z, goalX, goalZ) {
    this._refreshIfStale();

    const goalCell = this._cellOf(goalX, goalZ);
    const fromCell = this._cellOf(x, z);
    if (goalCell === -1 || fromCell === -1) return null;
    // Terrain-only check, deliberately not `_passable`: a structure sitting
    // on dry land is a valid destination (that's the whole point of the
    // goal-cell exemption in `_edgeCost`) — only a genuinely underwater goal
    // is rejected here.
    if (!this._terrainPassable[goalCell]) return null;

    let field = this._cache.get(goalCell);
    if (!field) {
      field = this._solve(goalCell);
      // Evict oldest first — Map iterates insertion order, so this is a
      // plain FIFO with no extra bookkeeping.
      if (this._cache.size >= MAX_CACHED_FIELDS) {
        this._cache.delete(this._cache.keys().next().value);
      }
      this._cache.set(goalCell, field);
    }

    if (fromCell === goalCell || field.dist[fromCell] === Infinity) {
      return fromCell === goalCell ? { x: goalX, z: goalZ } : null;
    }

    const stepCell = field.next[fromCell];
    if (stepCell === -1) return null;
    const row = Math.floor(stepCell / this.cols);
    const col = stepCell % this.cols;
    return this._cellCenter(col, row);
  }
}
