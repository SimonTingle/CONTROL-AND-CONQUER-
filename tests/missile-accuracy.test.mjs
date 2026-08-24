/**
 * The accuracy model: `hitChance` (src/vehicles/combatController.js), the
 * `rankOf` table behind it (src/vehicles/veterancy.js), and the stateless
 * `shotRoll` that turns a chance into a verdict (src/vehicles/projectiles.js).
 *
 * The roll deserves special attention here. There is no seeded PRNG in this
 * simulation, so `shotRoll` derives its number by hashing the shooter id,
 * target id and tick — which means it must be a *pure function of those three
 * things*, with no hidden state that could advance differently on two clients.
 * "Called twice, same answer" is the property that whole design rests on, and
 * it is the kind of property that quietly stops holding the moment someone
 * adds a counter, so it is asserted directly rather than inferred.
 *
 * Dependency-free: exported pure functions against plain mock instances.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hitChance } from '../src/vehicles/combatController.js';
import { shotRoll } from '../src/vehicles/projectiles.js';
import { rankOf, rankDamageMultiplier, RANK_THRESHOLDS, MAX_RANK } from '../src/vehicles/veterancy.js';

const shooter = (kills = 0, range = 100) => ({ id: 1, kills, def: { turret: { range } } });
const team = (weaponTier = 0) => ({ weaponTier });

// ---- rank ----

test('rankOf counts thresholds passed, and stops at the top of the table', () => {
  assert.equal(rankOf(0), 0);
  assert.equal(rankOf(RANK_THRESHOLDS[0] - 1), 0);
  assert.equal(rankOf(RANK_THRESHOLDS[0]), 1, 'the threshold itself promotes');
  assert.equal(rankOf(RANK_THRESHOLDS[1]), 2);
  assert.equal(rankOf(RANK_THRESHOLDS[2]), 3);
  assert.equal(rankOf(10_000), MAX_RANK, 'rank is capped, not unbounded');
});

test('rankOf tolerates a missing or non-numeric kill count', () => {
  // Structures have no `kills`, and a v1 save restores vehicles without one.
  // Returning NaN here would poison every accuracy calculation downstream.
  assert.equal(rankOf(undefined), 0);
  assert.equal(rankOf(null), 0);
  assert.equal(rankOf(NaN), 0);
});

test('the rank damage bonus is small and monotonic', () => {
  let last = 0;
  for (let r = 0; r <= MAX_RANK; r++) {
    const m = rankDamageMultiplier(r);
    assert.ok(m > last, 'each rank is strictly better than the last');
    last = m;
  }
  // Deliberately modest — accuracy is where rank is meant to be felt, and a
  // large damage bonus on top of a large accuracy bonus compounds into an
  // elite unit no fresh unit can trade with.
  assert.ok(rankDamageMultiplier(MAX_RANK) <= 1.25, 'top rank is not a damage doubling');
});

// ---- hitChance: the shape of the curve ----

test('accuracy rises with rank, at a fixed distance and tier', () => {
  const chances = [0, 2, 5, 10].map((k) => hitChance(shooter(k), team(0), 20));
  for (let i = 1; i < chances.length; i++) {
    assert.ok(chances[i] > chances[i - 1], `rank ${i} should beat rank ${i - 1}`);
  }
});

test('accuracy rises with the team weapon tier', () => {
  const chances = [0, 1, 2, 3].map((t) => hitChance(shooter(0), team(t), 20));
  for (let i = 1; i < chances.length; i++) {
    assert.ok(chances[i] > chances[i - 1], `tier ${i} should beat tier ${i - 1}`);
  }
});

test('accuracy falls with distance', () => {
  const near = hitChance(shooter(0), team(0), 5);
  const mid = hitChance(shooter(0), team(0), 50);
  const far = hitChance(shooter(0), team(0), 95);
  assert.ok(near > mid && mid > far, 'a longer shot is a worse shot');
});

test('range scales the bonuses rather than being subtracted from them', () => {
  // The distinction matters: were falloff subtracted, a high enough rank could
  // cancel distance out entirely and an elite unit would be as accurate at the
  // edge of its range as at point blank. Scaling means rank still helps at
  // range, but never erases it.
  const eliteNear = hitChance(shooter(10), team(3), 1);
  const eliteFar = hitChance(shooter(10), team(3), 100);
  assert.ok(eliteFar < eliteNear, 'even an elite crew is worse at maximum range');

  const greenFar = hitChance(shooter(0), team(0), 100);
  assert.ok(eliteFar > greenFar, 'and is still better than a green one out there');
});

test('accuracy stays inside its clamps however the terms stack', () => {
  const stacked = hitChance(shooter(10_000), team(99), 0);
  assert.ok(stacked <= 0.95, 'nothing is ever unmissable');

  // Beyond nominal range — combatController holds targets out to
  // RANGE_HYSTERESIS, so `dist / range` really can exceed 1 here. Without the
  // clamp inside hitChance the falloff would pass 1 and invert the curve,
  // making very long shots *more* accurate.
  const beyond = hitChance(shooter(0), team(0), 200);
  const atRange = hitChance(shooter(0), team(0), 100);
  assert.ok(beyond >= 0.15, 'and never below the floor');
  assert.ok(beyond <= atRange, 'a shot past maximum range is never better than one at it');
});

// ---- shotRoll: the determinism the whole design rests on ----

test('shotRoll is a pure function of its inputs', () => {
  const a = shotRoll(7, 12, 900, 'hit');
  const b = shotRoll(7, 12, 900, 'hit');
  assert.equal(a, b, 'no hidden state — the same shot rolls the same twice');

  // And crucially, calls in between must not move it. This is the property a
  // PRNG stream would not have, and the reason one is not used.
  shotRoll(1, 1, 1, 'hit');
  shotRoll(2, 2, 2, 'dir');
  assert.equal(shotRoll(7, 12, 900, 'hit'), a, 'unrelated rolls do not advance it');
});

test('shotRoll is always a usable probability', () => {
  for (let tick = 0; tick < 300; tick++) {
    const r = shotRoll(3, 9, tick, 'hit');
    assert.ok(r >= 0 && r < 1, `roll ${r} out of range at tick ${tick}`);
  }
});

test('every input, and the salt, changes the answer', () => {
  const base = shotRoll(5, 6, 100, 'hit');
  assert.notEqual(shotRoll(6, 6, 100, 'hit'), base, 'shooter matters');
  assert.notEqual(shotRoll(5, 7, 100, 'hit'), base, 'target matters');
  assert.notEqual(shotRoll(5, 6, 101, 'hit'), base, 'tick matters');
  // The salt is what keeps a miss's *direction* from being correlated with the
  // decision to miss. Sharing one number would make every miss from a given
  // shooter fall on the same side of its target.
  assert.notEqual(shotRoll(5, 6, 100, 'dir'), base, 'salt matters');
});

test('rolls are spread across the range, not clustered', () => {
  // A hash with poor avalanche would still be deterministic and still pass
  // every test above while producing, say, only values below 0.2 — which
  // would silently turn every shot into a hit. Ten buckets over a few hundred
  // shots should all be occupied.
  const buckets = new Array(10).fill(0);
  for (let tick = 0; tick < 500; tick++) {
    buckets[Math.floor(shotRoll(1, 2, tick, 'hit') * 10)]++;
  }
  assert.ok(buckets.every((n) => n > 0), `some bucket never filled: ${buckets.join(',')}`);
});
