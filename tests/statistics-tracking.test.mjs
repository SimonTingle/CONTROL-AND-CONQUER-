/**
 * The match statistics the Statistics screen reads.
 *
 * Three of these fields exist because a unit's own numbers die with it:
 * `vehicles.remove()` splices a destroyed instance out of the array entirely,
 * so anything computed by walking live instances silently under-counts every
 * match. The tests below are mostly about that — that a tally survives the
 * thing it was counting.
 *
 * The fourth, `harvesterEarningsTotal`, exists because `Team.earn()` is not
 * only called for harvesting: selling a structure back and an AI build refund
 * both go through it too, so `stats.creditsEarned` counts credits that were
 * never produced. That distinction is the first test here, because it is the
 * one a reader is most likely to assume away.
 *
 * Dependency-free, same convention as ai-posture.test.mjs: real classes driven
 * against plain mock objects, no renderer, no heightmap, no network.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Team, createTeams } from '../src/core/team.js';
import { CombatController } from '../src/vehicles/combatController.js';
import { serialize } from '../src/core/snapshot.js';

const GUN = { id: 'gun-platform', maxHealth: 400, turret: { damage: 20, fireInterval: 1.4, range: 90 } };
const TANK = { id: 'heavy-tank', maxHealth: 600, turret: { damage: 35, fireInterval: 2, range: 80 } };
const TURRET = { id: 'gun-turret', maxHealth: 420, turret: { damage: 20, fireInterval: 1.5, range: 74 } };

function makeTeam(id = 0) {
  return new Team(id, { name: `Team ${id}`, color: 0x4fd1c5, isHuman: id === 0 });
}

/** A shooter, shaped the way _fire reads one. */
function makeShooter(def, team, { kills = 0 } = {}) {
  return {
    def,
    teamId: team.id,
    kills,
    dead: false,
    mode: 'armed',
    group: { position: { x: 0, y: 0, z: 0 } },
  };
}

/** A victim that dies on the first hit, so every _fire call is a kill. */
function makeVictim({ survives = false } = {}) {
  return {
    def: GUN,
    teamId: 99,
    dead: false,
    health: survives ? 9999 : 1,
    group: { position: { x: 10, y: 0, z: 0 } },
    takeDamage() {
      if (survives) return false;
      this.dead = true;
      return true;
    },
  };
}

function makeCombat(team, { destroyed = [] } = {}) {
  return new CombatController({
    vehicles: { instances: [] },
    structures: { instances: [] },
    heightmap: { heightAt: () => 0, seaLevelY: 0 },
    entities: { queueDestroy: (inst) => destroyed.push(inst) },
    game: { teamOf: () => team, teams: [team] },
  });
}

// ---- the field that is not creditsEarned ----

test('earn() moves creditsEarned but never the harvest total', () => {
  const team = makeTeam();

  // Stands in for the two non-harvest callers of earn(): selling a structure
  // back (commands.js) and an AI build refund (aiCommander.js).
  team.earn(500);

  assert.equal(team.stats.creditsEarned, 500);
  assert.equal(
    team.stats.harvesterEarningsTotal,
    0,
    'a refund is not production — Score must not move'
  );
});

test('a fresh match starts every team on zeroed stats', () => {
  for (const team of createTeams(3)) {
    assert.equal(team.stats.harvesterEarningsTotal, 0);
    assert.equal(team.stats.topKillsVehicle, null);
    assert.deepEqual(team.stats.killsByDefId, {});
    assert.deepEqual(team.stats.deadHarvesterEarnings, []);
  }
});

test('teams do not share the nested stat containers', () => {
  // A single object literal reused across constructions would alias every
  // team's kills into one map — invisible until two teams are on the board.
  const [a, b] = createTeams(1);
  a.stats.killsByDefId['gun-platform'] = 3;
  a.stats.deadHarvesterEarnings.push(120);

  assert.deepEqual(b.stats.killsByDefId, {});
  assert.deepEqual(b.stats.deadHarvesterEarnings, []);
});

// ---- kills, recorded where the shooter is still known ----

test('a kill lands in killsByDefId for the shooter type', () => {
  const team = makeTeam();
  const combat = makeCombat(team);
  const shooter = makeShooter(GUN, team);

  combat._fire(shooter, makeVictim());

  assert.equal(team.stats.killsByDefId['gun-platform'], 1);
  assert.equal(shooter.kills, 1);
});

test('killsByDefId sums across separate units of the same type', () => {
  const team = makeTeam();
  const combat = makeCombat(team);

  combat._fire(makeShooter(GUN, team), makeVictim());
  combat._fire(makeShooter(GUN, team), makeVictim());
  combat._fire(makeShooter(TANK, team), makeVictim());

  assert.equal(team.stats.killsByDefId['gun-platform'], 2, 'two different platforms, one type');
  assert.equal(team.stats.killsByDefId['heavy-tank'], 1);
});

test('topKillsVehicle only yields to a strictly better run', () => {
  const team = makeTeam();
  const combat = makeCombat(team);

  // A reaches one kill and takes the record.
  combat._fire(makeShooter(GUN, team), makeVictim());
  assert.deepEqual(team.stats.topKillsVehicle, { defId: 'gun-platform', kills: 1 });

  // B also reaches one. A tie must not displace the incumbent, or the record
  // would just track whoever fired most recently.
  combat._fire(makeShooter(TANK, team), makeVictim());
  assert.deepEqual(
    team.stats.topKillsVehicle,
    { defId: 'gun-platform', kills: 1 },
    'a tie leaves the record where it was'
  );

  // B reaching two is a genuinely better run and does take it.
  combat._fire(makeShooter(TANK, team, { kills: 1 }), makeVictim());
  assert.deepEqual(team.stats.topKillsVehicle, { defId: 'heavy-tank', kills: 2 });
});

test('the record survives the unit that set it', () => {
  // The whole reason this is a team-level tally: the instance is gone.
  const team = makeTeam();
  const combat = makeCombat(team);
  let ace = makeShooter(GUN, team, { kills: 4 });

  combat._fire(ace, makeVictim());
  ace = null; // destroyed, spliced out of vehicles.instances

  assert.deepEqual(team.stats.topKillsVehicle, { defId: 'gun-platform', kills: 5 });
});

test('a turret structure can hold the record too', () => {
  // _shooters() includes emplacements, and they carry def.id/kills under the
  // same names — so they fold into the same tallies rather than being skipped.
  const team = makeTeam();
  const combat = makeCombat(team);

  combat._fire(makeShooter(TURRET, team), makeVictim());

  assert.equal(team.stats.killsByDefId['gun-turret'], 1);
  assert.deepEqual(team.stats.topKillsVehicle, { defId: 'gun-turret', kills: 1 });
});

test('a shot that does not kill records nothing', () => {
  const team = makeTeam();
  const combat = makeCombat(team);

  combat._fire(makeShooter(GUN, team), makeVictim({ survives: true }));

  assert.deepEqual(team.stats.killsByDefId, {});
  assert.equal(team.stats.topKillsVehicle, null);
});

test('a kill is queued for destruction, not spliced at the kill site', () => {
  // Guards the ordering the deadHarvesterEarnings capture depends on: the
  // destroy pipeline runs later, with the instance still readable.
  const team = makeTeam();
  const destroyed = [];
  const combat = makeCombat(team, { destroyed });
  const victim = makeVictim();

  combat._fire(makeShooter(GUN, team), victim);

  assert.deepEqual(destroyed, [victim]);
});

// ---- surviving a save ----

test('serialize copies the nested stat containers instead of aliasing them', () => {
  // team.stats held nothing but flat numbers until these fields arrived, so
  // snapshot.js's `{ ...team.stats }` was a complete copy. A map and a list
  // copy by reference under a spread, which would hand the caller a snapshot
  // that keeps changing after it was taken. Every caller today stringifies
  // immediately so nothing is broken — but view.snapshot() hands this object
  // out raw, and that is not a property worth depending on.
  const team = makeTeam();
  team.stats.killsByDefId['gun-platform'] = 2;
  team.stats.deadHarvesterEarnings.push(310);
  team.stats.harvesterEarningsTotal = 640;

  const snap = serialize({
    world: { trackMask: null },
    heightmap: { params: {} },
    terraform: { pads: [] },
    vehicles: { instances: [], active: null },
    structures: { instances: [] },
    game: { mode: 'sandbox', teams: [team], aiCommanders: [] },
  });
  const saved = snap.teams[0].stats;

  assert.equal(saved.harvesterEarningsTotal, 640);
  assert.deepEqual(saved.killsByDefId, { 'gun-platform': 2 });
  assert.deepEqual(saved.deadHarvesterEarnings, [310]);

  // The match plays on after the save is taken.
  team.stats.killsByDefId['gun-platform'] = 9;
  team.stats.deadHarvesterEarnings.push(999);

  assert.deepEqual(saved.killsByDefId, { 'gun-platform': 2 }, 'the snapshot froze');
  assert.deepEqual(saved.deadHarvesterEarnings, [310]);
});

test('restoring an older save leaves the new fields at their defaults', () => {
  // Object.assign only writes the keys a save actually carries, so a match
  // saved before these fields existed loads with zeroes rather than undefined
  // — which is what keeps the screen from rendering NaN over an old save.
  const team = makeTeam();
  Object.assign(team.stats, { creditsEarned: 400, unitsBuilt: 3 });

  assert.equal(team.stats.harvesterEarningsTotal, 0);
  assert.equal(team.stats.topKillsVehicle, null);
  assert.deepEqual(team.stats.killsByDefId, {});
  assert.deepEqual(team.stats.deadHarvesterEarnings, []);
});
