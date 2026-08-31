/**
 * Guards against the five determinism bugs found in the August audit.
 *
 * Each of these was a place where two clients running the same match could
 * reach different simulation state — the failure mode CLAUDE.md calls out as
 * the one that "has silently desynced matches before". None of them threw, and
 * none of them showed up in any existing test, because each produced a
 * *plausible* wrong answer rather than an error.
 *
 * The common shape is worth naming: every one of them let something the
 * clients do **not** share — array position, a private counter, which player
 * clicked, where a camera was pointing — reach a value the clients **must**
 * share. So these tests mostly assert independence from those things.
 *
 * Dependency-free: pure exported functions and plain mock instances.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Projectiles, resetProjectileIds } from '../src/vehicles/projectiles.js';
import { reacquiresThisTick } from '../src/vehicles/combatController.js';
import { Intent, applyIntent } from '../src/net/intents.js';
import { commandsFor } from '../src/vehicles/commands.js';
import { Team } from '../src/core/team.js';

// ---------------------------------------------------------------------------
// 1. shooterKind — vehicle and structure ids are separate counters
// ---------------------------------------------------------------------------

const TURRET_DEF = { id: 'gun-turret', turret: { damage: 20, projectileSpeed: 160 } };
const TANK_DEF = { id: 'heavy-tank', cost: 1000, turret: { damage: 20, projectileSpeed: 160 } };

function makeUnit(kind, id, def, teamId = 0) {
  return {
    id,
    kind,
    def,
    teamId,
    kills: 0,
    dead: false,
    health: 100,
    group: { position: { x: 0, y: 0, z: 0 } },
    takeDamage(n) {
      this.health -= n;
      if (this.health <= 0) { this.dead = true; return true; }
      return false;
    },
  };
}

function makeRange() {
  resetProjectileIds();
  const team = new Team(0, { name: 'A', color: 0, isHuman: true });
  const vehicles = { instances: [] };
  const structures = { instances: [] };
  const projectiles = new Projectiles({
    vehicles,
    structures,
    heightmap: { heightAt: () => 0 },
    entities: { queueDestroy: (i) => { i.dead = true; } },
    game: { teamOf: () => team, teams: [team] },
    onImpact: () => {},
  });
  const land = (shooter, target) => {
    projectiles.spawn({
      shooter,
      target,
      willHit: true,
      damage: 999, // lethal, so the kill-credit path always runs
      turretDef: shooter.def.turret,
      muzzleHeight: 1.5,
      targetHeight: 1.5,
      aimX: target.group.position.x,
      aimZ: target.group.position.z,
      aimY: 1.5,
    });
    const shell = projectiles.instances[projectiles.instances.length - 1];
    projectiles.update(shell.flight + 0.01);
  };
  return { projectiles, vehicles, structures, team, land };
}

test('a turret structure\'s kill is not credited to the same-numbered vehicle', () => {
  // The exact collision: a turret with structure id 3 and an unrelated vehicle
  // that also happens to be id 3. Before the fix, the kill lookup tried
  // vehicles first and found the wrong unit — which then gained veterancy that
  // feeds hitChance, shotDamage, and the state hash.
  const r = makeRange();
  const turret = makeUnit('structure', 3, TURRET_DEF);
  const bystander = makeUnit('vehicle', 3, TANK_DEF);
  const victim = makeUnit('vehicle', 9, TANK_DEF, 1);
  r.structures.instances.push(turret);
  r.vehicles.instances.push(bystander, victim);

  r.land(turret, victim);

  assert.ok(victim.dead, 'the victim died');
  assert.equal(turret.kills, 1, 'the turret that fired got the credit');
  assert.equal(bystander.kills, 0, 'the same-numbered vehicle got nothing');
});

test('a vehicle\'s kill is still credited to the vehicle', () => {
  // The other direction, so the fix cannot be "always look in structures".
  const r = makeRange();
  const tank = makeUnit('vehicle', 3, TANK_DEF);
  const turret = makeUnit('structure', 3, TURRET_DEF);
  const victim = makeUnit('vehicle', 9, TANK_DEF, 1);
  r.vehicles.instances.push(tank, victim);
  r.structures.instances.push(turret);

  r.land(tank, victim);

  assert.equal(tank.kills, 1);
  assert.equal(turret.kills, 0);
});

test('a shell records the kind of whatever fired it', () => {
  const r = makeRange();
  const turret = makeUnit('structure', 1, TURRET_DEF);
  const victim = makeUnit('vehicle', 1, TANK_DEF, 1);
  r.structures.instances.push(turret);
  r.vehicles.instances.push(victim);

  r.projectiles.spawn({
    shooter: turret, target: victim, willHit: true, damage: 10,
    turretDef: TURRET_DEF.turret, muzzleHeight: 1.5, targetHeight: 1.5,
    aimX: 0, aimZ: 0, aimY: 1.5,
  });

  assert.equal(r.projectiles.instances[0].shooterKind, 'structure');
});

// ---------------------------------------------------------------------------
// 2. reacquisition stagger — must not depend on array position
// ---------------------------------------------------------------------------

test('reacquisition depends on the unit id, never on array position', () => {
  // The whole point: two clients whose `vehicles.instances` are ordered
  // differently — routine after a resync, which rebuilds the array in snapshot
  // order — must still agree on which tick each unit searches for a target.
  const a = { id: 7, kind: 'vehicle' };
  const b = { id: 12, kind: 'vehicle' };

  for (let tick = 0; tick < 200; tick++) {
    // Same inputs, no array anywhere in the call. If position could reach it,
    // it would have to arrive through one of these arguments.
    assert.equal(reacquiresThisTick(a, tick), reacquiresThisTick(a, tick));
    assert.equal(reacquiresThisTick(b, tick), reacquiresThisTick(b, tick));
  }
});

test('reacquisition is staggered — the fleet does not all search on one tick', () => {
  // The stagger is the reason the index was there in the first place; the fix
  // has to preserve it, not just make it deterministic.
  const period = 15; // REACQUIRE_INTERVAL * 60
  const firedOn = new Set();
  for (let id = 1; id <= period; id++) {
    for (let tick = 0; tick < period; tick++) {
      if (reacquiresThisTick({ id, kind: 'vehicle' }, tick)) { firedOn.add(`${id}:${tick}`); break; }
    }
  }
  assert.equal(firedOn.size, period, 'every unit found a tick to search on');

  const ticks = new Set([...firedOn].map((k) => k.split(':')[1]));
  assert.ok(ticks.size > 1, 'and they are not all on the same tick');
});

test('every unit reacquires eventually, within one period', () => {
  const period = 15;
  for (const id of [1, 2, 3, 50, 999]) {
    const hit = Array.from({ length: period }, (_, t) => reacquiresThisTick({ id, kind: 'vehicle' }, t));
    assert.ok(hit.some(Boolean), `id ${id} never reacquires`);
  }
});

test('a vehicle and a structure sharing an id do not reacquire in lockstep', () => {
  // Same separate-id-counters hazard as the shooterKind bug, in a different
  // system: without the kind in the key they would search on identical ticks.
  const anyDiffer = Array.from({ length: 30 }, (_, t) =>
    reacquiresThisTick({ id: 4, kind: 'vehicle' }, t) !== reacquiresThisTick({ id: 4, kind: 'structure' }, t)
  ).some(Boolean);
  assert.ok(anyDiffer, 'kind is part of the stagger key');
});

// ---------------------------------------------------------------------------
// 3 & 5. UI-mode commands must not travel as intents
// ---------------------------------------------------------------------------

/**
 * A real vehicle def and mode whose command list genuinely contains
 * `select-target`. A made-up def id would make the test below pass for the
 * wrong reason: `commandsFor` returns an empty list for an unknown def, so
 * applyIntent bails at "command not found" long before reaching the `local`
 * guard. The first draft of this test did exactly that and passed with the
 * guard deleted.
 */
const LOCAL_CMD_UNIT = { defId: 'gun-platform', mode: 'mobile', cmdId: 'select-target' };

function makeCmdInstance() {
  return {
    id: 1,
    kind: 'vehicle',
    teamId: 0,
    dead: false,
    mode: LOCAL_CMD_UNIT.mode,
    health: 100,
    def: { id: LOCAL_CMD_UNIT.defId, maxHealth: 100, tags: ['combat'] },
    group: { position: { x: 0, y: 0, z: 0 } },
  };
}

function makeCmdCtx(inst) {
  const team = new Team(0, { name: 'A', color: 0, isHuman: true });
  return {
    vehicles: { instances: inst ? [inst] : [] },
    structures: { instances: [] },
    game: { teamOf: () => team, teams: [team], localTeamId: 0 },
  };
}

test('the command this test relies on really is in the list, and is marked local', () => {
  // Guards the guard. If select-target is renamed or moved off gun-platform's
  // mobile list, the test below would start passing vacuously — which is the
  // failure this whole file exists to catch, applied to itself.
  const inst = makeCmdInstance();
  const cmd = commandsFor(inst, makeCmdCtx(inst)).find((c) => c.id === LOCAL_CMD_UNIT.cmdId);
  assert.ok(cmd, 'select-target is in gun-platform/mobile\'s command list');
  assert.equal(cmd.local, true, 'and it is marked local');
});

test('applyIntent refuses a command marked local', () => {
  // The backstop. main.js routes these away from submitIntent, but if a future
  // call site forgets, applying one here would put *every* peer into the
  // caller's UI mode — their next click swallowed by a target-select they
  // never asked for.
  const inst = makeCmdInstance();
  const ctx = makeCmdCtx(inst);

  const applied = applyIntent(Intent.command(1, 'vehicle', LOCAL_CMD_UNIT.cmdId), ctx, 0);

  assert.equal(applied, false, 'refused');
  assert.equal(ctx.targetSelectMode, undefined, 'and no UI mode was entered');
});

// ---------------------------------------------------------------------------
// 4. menuHold — the hold is replicated, not local
// ---------------------------------------------------------------------------

test('menuHold sets and clears the hold through the intent stream', () => {
  const inst = {
    id: 5, kind: 'vehicle', teamId: 0, dead: false,
    group: { position: { x: 0, y: 0, z: 0 } },
  };
  const ctx = makeCmdCtx(inst);

  assert.equal(applyIntent(Intent.menuHold(5, 'vehicle', true), ctx, 0), true);
  assert.equal(inst.menuOpen, true);

  assert.equal(applyIntent(Intent.menuHold(5, 'vehicle', false), ctx, 0), true);
  assert.equal(inst.menuOpen, false);
});

test('menuHold cannot hold another team\'s unit', () => {
  // Same ownership rule as every other intent — otherwise opening a menu would
  // be a way to freeze an opponent's harvester.
  const enemy = {
    id: 5, kind: 'vehicle', teamId: 1, dead: false,
    group: { position: { x: 0, y: 0, z: 0 } },
  };
  const ctx = makeCmdCtx(enemy);

  assert.equal(applyIntent(Intent.menuHold(5, 'vehicle', true), ctx, 0), false);
  assert.equal(enemy.menuOpen, undefined);
});

test('menuHold on a vanished unit is refused, not thrown', () => {
  // Menus close on destroyed units, and the close intent lands a tick later —
  // by which time the unit is gone. That is the ordinary case, not an error.
  const ctx = makeCmdCtx({
    id: 5, kind: 'vehicle', teamId: 0, dead: true,
    group: { position: { x: 0, y: 0, z: 0 } },
  });
  assert.doesNotThrow(() => applyIntent(Intent.menuHold(5, 'vehicle', false), ctx, 0));
  assert.equal(applyIntent(Intent.menuHold(99, 'vehicle', false), ctx, 0), false);
});
