/**
 * The universal vehicle sell command: `vehicleSellRefund` (src/vehicles/
 * commands.js), which extends the existing structure SELL_COMMAND's
 * condition-scaled refund with an age decay and a kill bonus for combat
 * vehicles.
 *
 * Dependency-free: exercises the exported pure function directly against
 * plain mock instances, driving `simClock.tick` explicitly (never
 * Date.now/performance.now — see CLAUDE.md) since the age term reads it.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { vehicleSellRefund } from '../src/vehicles/commands.js';
import { simClock, resetSimClock } from '../src/core/simClock.js';

function makeInstance({ cost = 1000, maxHealth = 200, health = 200, tags = ['economy'], kills = 0, createdAt = 0 } = {}) {
  return { def: { cost, maxHealth, tags }, health, kills, createdAt };
}

test('full health, freshly spawned: refund is exactly half of cost', () => {
  resetSimClock(0);
  const inst = makeInstance({ cost: 1000, health: 200, maxHealth: 200, createdAt: 0 });
  assert.equal(vehicleSellRefund(inst), 500);
});

test('half health, freshly spawned: refund halves again', () => {
  resetSimClock(0);
  const inst = makeInstance({ cost: 1000, health: 100, maxHealth: 200, createdAt: 0 });
  assert.equal(vehicleSellRefund(inst), 250);
});

test('a very old vehicle floors at the age fraction rather than continuing toward zero', () => {
  resetSimClock(0);
  const fresh = makeInstance({ cost: 1000, createdAt: 0 });
  const freshRefund = vehicleSellRefund(fresh); // tick still 0 here: age 0
  simClock.tick = 1_000_000; // far past several halflives
  const ancient = makeInstance({ cost: 1000, createdAt: 0 });
  const ancientRefund = vehicleSellRefund(ancient);
  assert.ok(ancientRefund < freshRefund, 'still decays with age');
  // Floor is 0.6 of the condition-scaled value: base fraction 0.5, so the
  // asymptote is cost * 0.5 * 0.6 = 300 for a 1000-cost, full-health vehicle.
  assert.ok(ancientRefund >= 299 && ancientRefund <= 301, `floors near 300, got ${ancientRefund}`);
  resetSimClock(0);
});

test('a combat vehicle gets a flat bonus per confirmed kill', () => {
  resetSimClock(0);
  const noKills = makeInstance({ cost: 1000, tags: ['combat'], kills: 0, createdAt: 0 });
  const threeKills = makeInstance({ cost: 1000, tags: ['combat'], kills: 3, createdAt: 0 });
  assert.equal(vehicleSellRefund(threeKills) - vehicleSellRefund(noKills), 45, '15cr per kill, 3 kills');
});

test('negative control: an economy vehicle with a kills count on it gets no bonus', () => {
  resetSimClock(0);
  const noKills = makeInstance({ cost: 1000, tags: ['economy'], kills: 0, createdAt: 0 });
  // A harvester never actually accumulates kills, but if the field were ever
  // nonzero on one, the tag gate — not the field's mere presence — must be
  // what decides the bonus.
  const withKillsField = makeInstance({ cost: 1000, tags: ['economy'], kills: 5, createdAt: 0 });
  assert.equal(vehicleSellRefund(withKillsField), vehicleSellRefund(noKills), 'tag gate, not field presence, decides the bonus');
});
