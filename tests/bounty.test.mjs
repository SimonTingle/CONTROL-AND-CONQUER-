/**
 * Salvage coins: `Bounties` and `bountyValue` (src/vehicles/bounty.js).
 *
 * The interesting property to defend here is that a coin belongs to whoever
 * gets there first, on *either* team — not to the killer. `update` scans every
 * living vehicle regardless of team and awards the nearest, which is what the
 * tests around ownership exercise.
 *
 * Dependency-free: the real controller against a plain vehicle list, `Team`
 * from core/team.js so `earn()` is exercised for real rather than mocked.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { simClock, resetSimClock, advanceSimClock } from '../src/core/simClock.js';
import { Team } from '../src/core/team.js';
import { Bounties, bountyValue, resetCoinIds, PICKUP_RADIUS, COIN_LIFETIME } from '../src/vehicles/bounty.js';

let nextId = 1;
function makeVehicle(teamId, x, z) {
  return { id: nextId++, kind: 'vehicle', teamId, dead: false, group: { position: { x, y: 0, z } } };
}

function makeRange() {
  resetSimClock(0);
  resetCoinIds();
  nextId = 1;
  const teams = [
    new Team(0, { name: 'A', color: 0, isHuman: true }),
    new Team(1, { name: 'B', color: 1, isHuman: false }),
  ];
  const vehicles = { instances: [] };
  const collected = [];
  const bounties = new Bounties({
    vehicles,
    game: { teamOf: (v) => teams[v.teamId] },
    onCollected: (coin, team, collector) => collected.push({ coin, team, collector }),
  });
  return { bounties, vehicles, teams, collected };
}

// ---- value ----

test('bounty is a quarter of build cost for a green vehicle', () => {
  assert.equal(bountyValue({ def: { cost: 1000 }, kills: 0 }), 250);
});

test('bounty scales up with the dead vehicle\'s rank', () => {
  const green = bountyValue({ def: { cost: 1000 }, kills: 0 });
  const veteran = bountyValue({ def: { cost: 1000 }, kills: 5 }); // rank 2
  assert.ok(veteran > green, 'a veteran kill pays more');
});

test('a free or costless vehicle drops nothing', () => {
  assert.equal(bountyValue({ def: { cost: 0 }, kills: 3 }), 0);
});

// ---- dropping ----

test('a structure drops no coin', () => {
  const { bounties } = makeRange();
  const structure = { kind: 'structure', def: { cost: 2000 }, kills: 0, group: { position: { x: 0, y: 0, z: 0 } } };
  const coin = bounties.drop(structure);
  assert.equal(coin, null);
  assert.equal(bounties.instances.length, 0);
});

test('a destroyed vehicle drops a coin at its own position', () => {
  const { bounties } = makeRange();
  const dead = { kind: 'vehicle', def: { cost: 800 }, kills: 0, group: { position: { x: 12, y: 0, z: -4 } } };
  const coin = bounties.drop(dead);
  assert.equal(coin.value, 200);
  assert.equal(coin.x, 12);
  assert.equal(coin.z, -4);
  assert.equal(bounties.instances.length, 1);
});

// ---- claiming: either team, nearest wins ----

test('a coin is claimed by a unit that drives within pickup radius', () => {
  const { bounties, vehicles, teams } = makeRange();
  bounties.drop({ kind: 'vehicle', def: { cost: 1000 }, kills: 0, group: { position: { x: 0, y: 0, z: 0 } } });
  const collector = makeVehicle(0, 1, 0); // well inside PICKUP_RADIUS
  vehicles.instances.push(collector);

  bounties.update();

  assert.equal(bounties.instances.length, 0, 'the coin is gone');
  assert.equal(teams[0].credits, 250);
});

test('the enemy team can claim a coin dropped by its own kill', () => {
  // This is the entire point: the killer has a head start, not an entitlement.
  const { bounties, vehicles, teams } = makeRange();
  bounties.drop({
    kind: 'vehicle',
    def: { cost: 1000 },
    kills: 0,
    teamId: 0,
    group: { position: { x: 0, y: 0, z: 0 } },
  });
  const enemy = makeVehicle(1, 0, 1); // team 1, standing on the coin
  vehicles.instances.push(enemy);

  bounties.update();

  assert.equal(teams[1].credits, 250, 'team 1 collected it');
  assert.equal(teams[0].credits, 0, 'not the dead vehicle\'s own team');
});

test('nearest eligible vehicle wins, not array order', () => {
  const { bounties, vehicles, teams } = makeRange();
  bounties.drop({ kind: 'vehicle', def: { cost: 1000 }, kills: 0, group: { position: { x: 0, y: 0, z: 0 } } });
  const far = makeVehicle(1, 4, 0);
  const near = makeVehicle(0, 1, 0);
  vehicles.instances.push(far, near); // far pushed first

  bounties.update();

  assert.equal(teams[0].credits, 250, 'the nearer vehicle claimed it');
  assert.equal(teams[1].credits, 0);
});

test('a vehicle outside the pickup radius does not claim it', () => {
  const { bounties, vehicles, teams } = makeRange();
  bounties.drop({ kind: 'vehicle', def: { cost: 1000 }, kills: 0, group: { position: { x: 0, y: 0, z: 0 } } });
  vehicles.instances.push(makeVehicle(0, PICKUP_RADIUS + 5, 0));

  bounties.update();

  assert.equal(bounties.instances.length, 1, 'still sitting there');
  assert.equal(teams[0].credits, 0);
});

test('a dead vehicle cannot claim a coin', () => {
  const { bounties, vehicles, teams } = makeRange();
  bounties.drop({ kind: 'vehicle', def: { cost: 1000 }, kills: 0, group: { position: { x: 0, y: 0, z: 0 } } });
  const corpse = makeVehicle(0, 0, 0);
  corpse.dead = true;
  vehicles.instances.push(corpse);

  bounties.update();

  assert.equal(bounties.instances.length, 1);
  assert.equal(teams[0].credits, 0);
});

test('a coin cannot be claimed twice', () => {
  const { bounties, vehicles, teams } = makeRange();
  bounties.drop({ kind: 'vehicle', def: { cost: 1000 }, kills: 0, group: { position: { x: 0, y: 0, z: 0 } } });
  vehicles.instances.push(makeVehicle(0, 0, 0));

  bounties.update();
  bounties.update(); // same collector is still parked right there

  assert.equal(teams[0].credits, 250, 'only paid once');
});

test('onCollected fires once per claim, with the coin, team and collector', () => {
  const { bounties, vehicles, collected } = makeRange();
  bounties.drop({ kind: 'vehicle', def: { cost: 400 }, kills: 0, group: { position: { x: 0, y: 0, z: 0 } } });
  const collector = makeVehicle(1, 0, 0);
  vehicles.instances.push(collector);

  bounties.update();

  assert.equal(collected.length, 1);
  assert.equal(collected[0].coin.value, 100);
  assert.equal(collected[0].team.id, 1);
  assert.equal(collected[0].collector, collector);
});

// ---- expiry ----

test('an unclaimed coin disperses after its lifetime', () => {
  const { bounties, teams } = makeRange();
  bounties.drop({ kind: 'vehicle', def: { cost: 1000 }, kills: 0, group: { position: { x: 0, y: 0, z: 0 } } });

  // Advance the sim clock well past COIN_LIFETIME with nobody nearby.
  const ticks = Math.ceil(COIN_LIFETIME * 60) + 2;
  for (let i = 0; i < ticks; i++) {
    advanceSimClock();
    bounties.update();
  }

  assert.equal(bounties.instances.length, 0, 'gone');
  assert.equal(teams[0].credits, 0, 'and nobody was paid for it');
});

// ---- restore ----

test('a restored coin keeps its id and stays claimable', () => {
  const { bounties, vehicles, teams } = makeRange();
  bounties.restore({ id: 99, x: 0, z: 0, value: 300, expiresAtTick: 100000, defId: 'heavy-tank', teamId: 0 });

  vehicles.instances.push(makeVehicle(1, 0, 0));
  bounties.update();

  assert.equal(teams[1].credits, 300);
});
