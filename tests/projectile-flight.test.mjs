/**
 * Shells in flight: `Projectiles` (src/vehicles/projectiles.js).
 *
 * The cases that matter here are the ones hitscan resolution never had to
 * face, because it never spanned two ticks. A shell exists in the gap between
 * a trigger pull and an impact, and in that gap either participant can die.
 * `combatController.js`'s old header named this as the reason not to build
 * travelling projectiles at all; these are the tests that say the reason no
 * longer applies.
 *
 * Dependency-free: the real controller against plain mock instances, driven by
 * explicit `update(dt)` calls. No renderer, no heightmap, no clock.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Projectiles, resetProjectileIds, shotDamage } from '../src/vehicles/projectiles.js';
import { Team } from '../src/core/team.js';

const TANK = { id: 'heavy-tank', maxHealth: 600, cost: 1200, turret: { damage: 35, fireInterval: 2, range: 80, projectileSpeed: 160 } };

let nextId = 1;

function makeUnit(def, teamId, x = 0, z = 0, { health = 100, kills = 0 } = {}) {
  return {
    id: nextId++,
    kind: 'vehicle',
    def,
    teamId,
    kills,
    dead: false,
    health,
    group: { position: { x, y: 0, z } },
    takeDamage(n) {
      this.health -= n;
      if (this.health <= 0) {
        this.dead = true;
        return true;
      }
      return false;
    },
  };
}

function makeRange() {
  resetProjectileIds();
  nextId = 1;
  const team = new Team(0, { name: 'A', color: 0, isHuman: true });
  const vehicles = { instances: [] };
  const structures = { instances: [] };
  const destroyed = [];
  const impacts = [];
  const projectiles = new Projectiles({
    vehicles,
    structures,
    // Flat ground at zero, so every height in these tests is the one the test
    // set rather than one the terrain invented.
    heightmap: { heightAt: () => 0 },
    entities: { queueDestroy: (inst) => { inst.dead = true; destroyed.push(inst); } },
    game: { teamOf: () => team, teams: [team] },
    onImpact: (i) => impacts.push(i),
  });
  return { projectiles, vehicles, structures, destroyed, impacts, team };
}

function fire(range, shooter, target, willHit = true, { damage } = {}) {
  range.projectiles.spawn({
    shooter,
    target,
    willHit,
    damage: damage ?? shooter.def.turret.damage,
    turretDef: shooter.def.turret,
    muzzleHeight: 1.5,
    targetHeight: 1.5,
    aimX: target.group.position.x,
    aimZ: target.group.position.z,
    aimY: 1.5,
  });
  return range.projectiles.instances[range.projectiles.instances.length - 1];
}

// ---- the shot takes time ----

test('damage lands on arrival, not on the tick the shell was fired', () => {
  // The single most load-bearing property of the change. If this ever
  // regresses to applying damage at launch, everything else here is theatre.
  const r = makeRange();
  const shooter = makeUnit(TANK, 0, 0, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);

  const shell = fire(r, shooter, victim);
  assert.equal(victim.health, 100, 'nothing has happened yet');
  assert.ok(shell.flight > 1 / 60, 'and the flight is longer than a single tick');

  r.projectiles.update(shell.flight / 2);
  assert.equal(victim.health, 100, 'still in the air, still unharmed');

  r.projectiles.update(shell.flight);
  assert.equal(victim.health, 100 - TANK.turret.damage, 'and now it lands');
});

test('a shell is removed from the array once it resolves', () => {
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);
  const shell = fire(r, shooter, victim);

  assert.equal(r.projectiles.instances.length, 1);
  r.projectiles.update(shell.flight + 0.01);
  assert.equal(r.projectiles.instances.length, 0, 'nothing is left in flight');
});

// ---- the shooter dies mid-flight ----

test('a shell outlives its shooter and still deals its damage', () => {
  // This is the case the old hitscan design existed to avoid. The shell copies
  // everything it needs at launch, so losing the shooter costs it nothing.
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);
  const shell = fire(r, shooter, victim);

  // The shooter is destroyed and spliced out, exactly as vehicles.remove does.
  r.vehicles.instances.splice(r.vehicles.instances.indexOf(shooter), 1);

  r.projectiles.update(shell.flight + 0.01);
  assert.equal(victim.health, 100 - TANK.turret.damage, 'the shot still landed');
});

test('a kill by a dead shooter still reaches the team tally', () => {
  // The per-instance `kills` is genuinely gone with the instance, so the
  // credit falls back to the def id the shell copied at launch. Without that
  // fallback a trade — both units dying in the same exchange — would silently
  // lose a kill from the Statistics screen.
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0, { health: 10 });
  r.vehicles.instances.push(shooter, victim);
  const shell = fire(r, shooter, victim);

  r.vehicles.instances.splice(r.vehicles.instances.indexOf(shooter), 1);
  r.projectiles.update(shell.flight + 0.01);

  assert.ok(victim.dead, 'the victim died');
  assert.equal(r.team.stats.killsByDefId['heavy-tank'], 1, 'and the team was credited');
});

// ---- the target dies mid-flight ----

test('a shell whose target dies first becomes a ground impact', () => {
  // Not silently deleted: the honest outcome is that the shell lands where the
  // target used to be, and the readable one is a crater beside the wreck.
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);
  const shell = fire(r, shooter, victim);

  // Killed by something else, and removed.
  victim.dead = true;
  r.vehicles.instances.splice(r.vehicles.instances.indexOf(victim), 1);

  r.projectiles.update(shell.flight + 0.01);

  assert.equal(r.impacts.length, 1);
  assert.equal(r.impacts[0].ground, true, 'it hit the ground, not a hull');
  assert.equal(r.impacts[0].killed, false);
});

test('a shell whose target is merely dead-but-not-removed does not hit it again', () => {
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);
  const shell = fire(r, shooter, victim);

  victim.dead = true; // queued for destroy, flush hasn't run yet
  const healthBefore = victim.health;
  r.projectiles.update(shell.flight + 0.01);

  assert.equal(victim.health, healthBefore, 'a corpse takes no damage');
  assert.equal(r.impacts[0].ground, true);
});

// ---- misses ----

test('a miss never touches its target and always impacts the ground', () => {
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);

  const shell = fire(r, shooter, victim, false);
  assert.equal(shell.targetId, null, 'a miss carries no target to resolve');

  r.projectiles.update(shell.flight + 0.01);
  assert.equal(victim.health, 100, 'untouched');
  assert.equal(r.impacts[0].ground, true);
});

// ---- damage and rank ----

test('shotDamage applies the shooter rank bonus', () => {
  const green = makeUnit(TANK, 0, 0, 0, { kills: 0 });
  const elite = makeUnit(TANK, 0, 0, 0, { kills: 50 });
  assert.equal(shotDamage(green), TANK.turret.damage);
  assert.ok(shotDamage(elite) > shotDamage(green), 'rank hits harder');
});

test('damage is fixed at launch, not re-read on arrival', () => {
  // A crew promoted while its shell is in the air must not retroactively
  // strengthen it — the shell carries a number, not a reference to a def.
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);
  const shell = fire(r, shooter, victim, true, { damage: 35 });

  shooter.kills = 100; // promoted mid-flight
  r.projectiles.update(shell.flight + 0.01);

  assert.equal(victim.health, 100 - 35, 'the shell landed for what it was fired with');
});

// ---- housekeeping ----

test('a shell that can never arrive is eventually reaped', () => {
  // Guards against an unbounded array if an arrival test ever stops tripping.
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);
  const shell = fire(r, shooter, victim);
  shell.flight = Infinity; // it will never arrive on time

  r.projectiles.update(60);
  assert.equal(r.projectiles.instances.length, 0, 'reaped by the flight-time cap');
});

test('several shells resolving on the same tick all resolve', () => {
  // The resolve loop splices out of the array it is walking. Walking it
  // forwards would skip whichever shell shuffled into the vacated index.
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victims = [1, 2, 3].map((i) => makeUnit(TANK, 1, 80, i * 4));
  r.vehicles.instances.push(shooter, ...victims);

  let longest = 0;
  for (const v of victims) longest = Math.max(longest, fire(r, shooter, v).flight);
  r.projectiles.update(longest + 0.01);

  assert.equal(r.projectiles.instances.length, 0);
  for (const v of victims) {
    assert.equal(v.health, 100 - TANK.turret.damage, 'every shell landed');
  }
});

test('a restored shell resumes rather than relaunching', () => {
  const r = makeRange();
  const shooter = makeUnit(TANK, 0);
  const victim = makeUnit(TANK, 1, 80, 0);
  r.vehicles.instances.push(shooter, victim);
  const shell = fire(r, shooter, victim);
  const saved = { ...shell };
  // Most of the way there when the save was taken.
  saved.elapsed = saved.flight - 0.02;

  r.projectiles.clear();
  r.projectiles.restore(saved);
  r.projectiles.update(0.03);

  assert.equal(victim.health, 100 - TANK.turret.damage, 'it landed on schedule, not restarted');
});
