/**
 * `Atmosphere.seedFromElapsedTicks` — fixing time-of-day desync on rejoin.
 *
 * Reported directly, alongside a headlight-sync report: "synchronize the
 * time of day correctly between all players in online multiplayer."
 *
 * Traced first: for two continuously-connected clients, `update(dt)`
 * (a pure `phase += dt / periodSeconds` accumulator) is only ever called
 * from inside the deterministic sim tick, so it already stays in lockstep
 * automatically — not the bug. The actual gap is a *rejoin*: `main.js`'s
 * `startOnlineMatch` rebuilds the world (and therefore, previously, always
 * left the existing `Atmosphere` instance's `cycle.phase` right where a
 * plain reconnect left it — frozen — but a full page reload path
 * constructs a brand new `World`/`Atmosphere` at its fixed
 * construction-time phase) while `LockstepSession.resumeAt(releasedTurn+1)`
 * resumes at the current turn *without* replaying the skipped ticks. So the
 * rejoining client's sky stayed stuck at the fixed default time-of-day while
 * every continuously-connected peer had moved on however far the match's
 * real elapsed tick count had taken them.
 *
 * `seedFromElapsedTicks` closes that gap with a closed-form version of the
 * same formula `update()` applies incrementally — this test's whole point is
 * proving those two paths agree.
 *
 * A real `THREE.Scene` (cheap, no GPU/canvas needed for plain object
 * construction) and a fake renderer stand-in (`Atmosphere` only ever writes
 * `renderer.toneMappingExposure`, never reads a real WebGL context) keep this
 * dependency-free per CLAUDE.md.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atmosphere } from '../src/sky/atmosphere.js';

const SIM_DT = 1 / 60;

function makeAtmosphere() {
  const scene = new THREE.Scene();
  const renderer = { toneMappingExposure: 0 };
  return new Atmosphere(scene, renderer, { mapSize: 256 });
}

test('seeding from N elapsed ticks matches ticking through all N continuously', () => {
  const ticked = makeAtmosphere();
  const N = 4000; // well past a full 1800s cycle at 60 ticks/sec
  for (let i = 0; i < N; i++) ticked.update(SIM_DT);

  const seeded = makeAtmosphere();
  seeded.seedFromElapsedTicks(N, SIM_DT);

  // Same phase within floating-point tolerance -- not just "close" elevation,
  // which could coincidentally match at two different points in the cycle.
  assert.ok(
    Math.abs(ticked.cycle.phase - seeded.cycle.phase) < 1e-9,
    `ticked phase=${ticked.cycle.phase}, seeded phase=${seeded.cycle.phase}`
  );
  assert.ok(
    Math.abs(ticked.params.elevation - seeded.params.elevation) < 1e-6,
    `ticked elevation=${ticked.params.elevation}, seeded elevation=${seeded.params.elevation}`
  );
});

test('a fresh join (0 elapsed ticks) is a no-op', () => {
  const fresh = makeAtmosphere();
  const seededZero = makeAtmosphere();
  seededZero.seedFromElapsedTicks(0, SIM_DT);

  assert.equal(seededZero.cycle.phase, fresh.cycle.phase);
  assert.equal(seededZero.params.elevation, fresh.params.elevation);
});

test('seeding continues correctly with further ticks afterward', () => {
  // The scenario that actually matters: a rejoining client seeds once, then
  // keeps simulating forward from there just like everyone else.
  const ticked = makeAtmosphere();
  for (let i = 0; i < 5000; i++) ticked.update(SIM_DT);

  const rejoined = makeAtmosphere();
  rejoined.seedFromElapsedTicks(3000, SIM_DT);
  for (let i = 0; i < 2000; i++) rejoined.update(SIM_DT);

  assert.ok(
    Math.abs(ticked.cycle.phase - rejoined.cycle.phase) < 1e-9,
    `ticked phase=${ticked.cycle.phase}, rejoined phase=${rejoined.cycle.phase}`
  );
});
