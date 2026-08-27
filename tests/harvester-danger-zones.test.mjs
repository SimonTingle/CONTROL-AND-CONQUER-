/**
 * Team-shared danger zones: harvesters avoid ground they were shot on.
 *
 * The behaviour this covers, and why it is shaped the way it is, comes from a
 * 41-minute four-AI-team diagnostic in which harvesters drove back to the same
 * contested field until they died there. `combatController` already stamped
 * `threatUntil`/`threatFrom` on any target at *fire* time, and `harvesterAI`
 * already fled on it — what was missing was any memory of the place afterward.
 *
 * Two properties are worth stating up front because they are easy to get
 * backwards, and each has a test below:
 *
 *  - Zones are **team-shared**, not per-harvester. One harvester being shot
 *    teaches the fleet. The per-harvester `s.bans` still exists and means
 *    something different ("this field failed *me*"); both filter the same
 *    picker.
 *  - The most permissive tier of `_idle`'s picker deliberately **ignores**
 *    zones. Zones last 90 seconds across a whole team, so a single well-placed
 *    turret could otherwise mean a team never harvests again. An economy that
 *    starves rather than work dangerous ground has not been made cautious, it
 *    has been switched off.
 *
 * Dependency-free: plain mock blooms/heightmap/vehicles, and `simClock` driven
 * by hand. No THREE, no AudioContext, no browser.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HarvesterAI } from '../src/vehicles/harvesterAI.js';
import { simClock } from '../src/core/simClock.js';

const DRY_HEIGHTMAP = { heightAt: () => 10, seaLevelY: 0 };

function makeField(id, x, z, { stock = 100, capacity = 100 } = {}) {
  return { id, x, z, stock, capacity, radius: 12, dead: false, blockedByTeam: null };
}

/** Minimal blooms with the same `nearestTo` contract the real one has. */
function makeBlooms(fields) {
  return {
    fields,
    nearestTo(x, z, { minStock = 1, reject = null } = {}) {
      let best = null;
      let bestD = Infinity;
      for (const f of this.fields) {
        if (f.dead || f.stock < minStock) continue;
        if (DRY_HEIGHTMAP.heightAt(f.x, f.z) <= DRY_HEIGHTMAP.seaLevelY) continue;
        if (reject?.(f)) continue;
        const d = Math.hypot(f.x - x, f.z - z);
        if (d < bestD) { bestD = d; best = f; }
      }
      return best;
    },
  };
}

function makeAI(fields = []) {
  return new HarvesterAI({
    vehicles: { instances: [] },
    world: { blooms: makeBlooms(fields) },
    heightmap: DRY_HEIGHTMAP,
    structures: { instances: [] },
    game: { teamOf: () => ({ credits: 10000 }) },
    facilityControl: { queueDepth: () => 0 },
  });
}

/** simClock is module state shared across tests — pin it explicitly. */
function atTime(t) {
  simClock.tick = Math.round(t * 60);
  simClock.time = t;
}

// ---------------------------------------------------------------------------
// Recording and expiry
// ---------------------------------------------------------------------------

test('a marked zone is remembered, and only within its radius', () => {
  atTime(100);
  const ai = makeAI();
  ai.markDangerZone(1, 0, 0, { radius: 70 });

  assert.equal(ai.inDangerZone(1, 0, 0), true, 'dead centre');
  assert.equal(ai.inDangerZone(1, 50, 0), true, 'inside the radius');
  assert.equal(ai.inDangerZone(1, 200, 0), false, 'well outside');
});

test('a zone is scoped to the team that learned it', () => {
  atTime(100);
  const ai = makeAI();
  ai.markDangerZone(1, 0, 0);

  assert.equal(ai.inDangerZone(1, 0, 0), true);
  assert.equal(ai.inDangerZone(2, 0, 0), false, 'another team has not been shot here');
});

test('a zone expires on sim time, and is pruned once it has', () => {
  atTime(100);
  const ai = makeAI();
  ai.markDangerZone(1, 0, 0, { seconds: 90 });

  atTime(189);
  assert.equal(ai.inDangerZone(1, 0, 0), true, 'still hot one second before expiry');

  atTime(191);
  assert.equal(ai.inDangerZone(1, 0, 0), false, 'lapsed');
  assert.equal(ai.dangerZonesFor(1).length, 0, 'and dropped rather than accumulating');
});

test('repeat fire on the same ground refreshes one zone instead of stacking', () => {
  // A turret firing for twenty seconds would otherwise mint twenty
  // near-identical zones and evict the memory of everywhere else.
  atTime(100);
  const ai = makeAI();
  ai.markDangerZone(1, 0, 0, { seconds: 90 });
  atTime(140);
  ai.markDangerZone(1, 10, 10, { seconds: 90 });

  assert.equal(ai.dangerZonesFor(1).length, 1, 'merged into the overlapping zone');
  atTime(215);
  assert.equal(ai.inDangerZone(1, 0, 0), true, 'and the refresh extended its life');
});

test('distinct places are remembered separately', () => {
  atTime(100);
  const ai = makeAI();
  ai.markDangerZone(1, 0, 0, { radius: 70 });
  ai.markDangerZone(1, 500, 500, { radius: 70 });
  assert.equal(ai.dangerZonesFor(1).length, 2);
});

test('the zone list is capped, evicting the stalest first', () => {
  atTime(100);
  const ai = makeAI();
  // Spaced well beyond the default radius so none of them merge.
  for (let i = 0; i < 20; i++) ai.markDangerZone(1, i * 500, 0, { radius: 70 });

  const zones = ai.dangerZonesFor(1);
  assert.ok(zones.length <= 12, `capped, got ${zones.length}`);
  assert.equal(ai.inDangerZone(1, 0, 0), false, 'the first lesson was evicted');
  assert.equal(ai.inDangerZone(1, 19 * 500, 0), true, 'the newest was kept');
});

test('a zone with a non-finite centre is refused rather than poisoning the list', () => {
  atTime(100);
  const ai = makeAI();
  assert.equal(ai.markDangerZone(1, NaN, 0), null);
  assert.equal(ai.dangerZonesFor(1).length, 0);
});

// ---------------------------------------------------------------------------
// The picker actually consults them
// ---------------------------------------------------------------------------

/** Drive `_idle` once for a harvester at the origin and report the field chosen. */
function pickFor(ai, teamId = 1) {
  const inst = {
    id: 1, teamId, dead: false, def: { capacity: 100, maxHealth: 200 }, health: 200,
    group: { position: { x: 0, y: 0, z: 0 } },
    targetField: null, threatUntil: null, threatFrom: null,
    setTarget: () => true, arrive: () => {}, hasOrder: true, speed: 0,
  };
  const s = ai._stateFor(inst);
  s.state = 'idle';
  s.load = 0;
  ai._idle(inst, s, 0.016);
  return s.field;
}

test('a harvester picks a nearer field when nothing is contested', () => {
  atTime(100);
  const near = makeField(1, 50, 0);
  const far = makeField(2, 400, 0);
  const ai = makeAI([near, far]);
  assert.equal(pickFor(ai)?.id, 1, 'the control: nearest wins');
});

test('a contested field is passed over for a safe one further away', () => {
  atTime(100);
  const near = makeField(1, 50, 0);
  const far = makeField(2, 400, 0);
  const ai = makeAI([near, far]);
  ai.markDangerZone(1, 50, 0, { radius: 70 });

  assert.equal(pickFor(ai)?.id, 2, 'drove past the ambush to the safe field');
});

test('one harvester being shot redirects the whole team, not just itself', () => {
  // The team-shared property. A per-harvester ban could not do this.
  atTime(100);
  const near = makeField(1, 50, 0);
  const far = makeField(2, 400, 0);
  const ai = makeAI([near, far]);
  ai.markDangerZone(1, 50, 0, { radius: 70 });

  // A second, previously-uninvolved harvester of the same team.
  const other = {
    id: 99, teamId: 1, dead: false, def: { capacity: 100, maxHealth: 200 }, health: 200,
    group: { position: { x: 0, y: 0, z: 0 } },
    targetField: null, threatUntil: null, threatFrom: null,
    setTarget: () => true, arrive: () => {}, hasOrder: true, speed: 0,
  };
  const s = ai._stateFor(other);
  s.state = 'idle';
  s.load = 0;
  ai._idle(other, s, 0.016);

  assert.equal(s.field?.id, 2, 'it never went near the field it had not been shot at');
});

test('an enemy team is unaffected by our danger zones', () => {
  atTime(100);
  const near = makeField(1, 50, 0);
  const far = makeField(2, 400, 0);
  const ai = makeAI([near, far]);
  ai.markDangerZone(1, 50, 0, { radius: 70 });

  assert.equal(pickFor(ai, 2)?.id, 1, 'team 2 still takes the nearest field');
});

test('once the zone lapses, the field is used again', () => {
  atTime(100);
  const near = makeField(1, 50, 0);
  const far = makeField(2, 400, 0);
  const ai = makeAI([near, far]);
  ai.markDangerZone(1, 50, 0, { radius: 70, seconds: 90 });

  assert.equal(pickFor(ai)?.id, 2, 'avoided while hot');
  atTime(200);
  assert.equal(pickFor(ai)?.id, 1, 'and returned once it cooled');
});

test('a harvester still works contested ground when there is nowhere else', () => {
  // The release valve, and the single most important test here. Zones are
  // team-wide and last 90s; without this, one turret beside the only field on
  // the map would end a team's economy permanently.
  atTime(100);
  const only = makeField(1, 50, 0);
  const ai = makeAI([only]);
  ai.markDangerZone(1, 50, 0, { radius: 70 });

  assert.equal(pickFor(ai)?.id, 1, 'took the risk rather than idling forever');
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('regenerating the world forgets every zone', () => {
  atTime(100);
  const ai = makeAI();
  ai.markDangerZone(1, 0, 0);
  ai.reset();
  assert.equal(ai.inDangerZone(1, 0, 0), false, 'the ground it describes no longer exists');
});
