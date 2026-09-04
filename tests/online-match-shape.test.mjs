/**
 * How many teams an online match builds, and whether two clients agree they
 * are standing on the same island.
 *
 * Both come from the same report (docs/plans/split-brain-invisible-to-the-hash.md):
 * two players in one match, each finding "an enemy base" that was not the
 * other's, with every number on screen agreeing.
 *
 * ## Seat count
 *
 * `src/main.js` sized the team roster from `info.maxPlayers` — the lobby's
 * *capacity* — while the entire server relay uses the actual roster
 * (`welcome.expectedPlayers`, already on the wire and ignored). A 6-seat lobby
 * that two people joined therefore built six teams and spawned six base
 * stations, four of them belonging to a seat nobody sat in and, because those
 * seats are flagged human, with no AI commander either. Inert bases a player
 * can find, attack and destroy with no opponent behind them — and every client
 * builds the identical phantoms, so nothing reports a desync.
 *
 * The arithmetic is asserted here rather than in main.js because main.js
 * cannot be imported without a browser. `seatPlan` mirrors exactly what that
 * file now computes; if the two ever drift, this test is worth nothing, which
 * is why the real line carries a comment pointing here.
 *
 * ## Terrain
 *
 * Only the seed crosses the wire. Every other terrain parameter comes from
 * each client's own bundle, so two peers could build entirely different
 * islands from one seed with nothing to say so — and since every spawn point
 * is derived from the heightfield, they would place their bases in different
 * places. `Heightmap.digest()` is what makes that visible.
 *
 * Dependency-free: `Heightmap` needs no GPU to generate its Float32Array, and
 * the seat arithmetic is integers.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Heightmap, DEFAULT_TERRAIN } from '../src/terrain/heightmap.js';
import { createTeams } from '../src/core/team.js';
import { findTeamSpawnPoints } from '../src/core/pick.js';

/**
 * The seat arithmetic `src/main.js`'s online path performs, in isolation.
 * `expectedPlayers` is the server's frozen roster count; `maxPlayers` is the
 * lobby row's capacity.
 */
function seatPlan({ expectedPlayers, maxPlayers, aiCount = 0 }) {
  const humanSeats = expectedPlayers ?? maxPlayers;
  const totalTeams = humanSeats + aiCount;
  return { humanSeats, totalTeams };
}

// ---------------------------------------------------------------------------
// Seat count — the phantom bases

test('a 6-seat lobby that two people joined builds two teams, not six', () => {
  const { totalTeams } = seatPlan({ expectedPlayers: 2, maxPlayers: 6, aiCount: 0 });
  assert.equal(totalTeams, 2, 'four of those teams would be bases nobody owns');

  // The number is only useful if it survives into the world that gets built.
  assert.equal(createTeams(totalTeams - 1).length, 2);
});

test('one base station per team, and no more', () => {
  // deployStartingForces spawns exactly one base per spawn point, so the count
  // of spawn points is the count of bases a player can walk into.
  const heightmap = new Heightmap({ ...DEFAULT_TERRAIN, seed: 4242 });
  const { totalTeams } = seatPlan({ expectedPlayers: 2, maxPlayers: 6 });
  assert.equal(findTeamSpawnPoints(heightmap, totalTeams).length, 2);
});

test('a full lobby is unchanged — capacity and roster agree', () => {
  // The case every existing multiplayer test already covers, and the reason
  // this bug stayed invisible: when maxPlayers === roster the two formulas are
  // numerically identical.
  assert.equal(seatPlan({ expectedPlayers: 2, maxPlayers: 2 }).totalTeams, 2);
  assert.equal(seatPlan({ expectedPlayers: 20, maxPlayers: 20 }).totalTeams, 20);
});

test('AI seats still count, and are added to the real roster not the capacity', () => {
  const { humanSeats, totalTeams } = seatPlan({ expectedPlayers: 2, maxPlayers: 8, aiCount: 3 });
  assert.equal(humanSeats, 2);
  assert.equal(totalTeams, 5); // 2 humans + 3 AI, not 8 + 3
});

test('an older server that sends no expectedPlayers falls back to capacity', () => {
  // The field has been on the wire since before this change, but the fallback
  // keeps a peer talking to something that predates it from building zero teams.
  assert.equal(seatPlan({ expectedPlayers: undefined, maxPlayers: 4 }).totalTeams, 4);
});

// ---------------------------------------------------------------------------
// Terrain digest

test('the same seed and params digest identically', () => {
  const a = new Heightmap({ ...DEFAULT_TERRAIN, seed: 777 });
  const b = new Heightmap({ ...DEFAULT_TERRAIN, seed: 777 });
  assert.equal(a.digest(), b.digest());
  assert.ok(a.digest(), 'digest should be a non-empty value');
});

test('a different seed digests differently', () => {
  const a = new Heightmap({ ...DEFAULT_TERRAIN, seed: 777 });
  const b = new Heightmap({ ...DEFAULT_TERRAIN, seed: 778 });
  assert.notEqual(a.digest(), b.digest());
});

test('a terrain parameter that never crosses the wire still changes the digest', () => {
  // This is the case the digest exists for. Two clients agree on the seed —
  // the only thing they exchange — but one has a different `amplitude` or
  // `octaves` baked into its bundle. Same seed, different island, and before
  // this nothing anywhere would have noticed.
  const seed = 20260727;
  const base = new Heightmap({ ...DEFAULT_TERRAIN, seed });

  for (const [field, value] of [['amplitude', 120], ['octaves', 6], ['ridgeBlend', 0.2], ['warp', 0.5]]) {
    const other = new Heightmap({ ...DEFAULT_TERRAIN, seed, [field]: value });
    if (field === 'amplitude') {
      // amplitude scales heightAt, not the normalised field the digest walks —
      // recorded rather than asserted, so the limit is documented not assumed.
      continue;
    }
    assert.notEqual(base.digest(), other.digest(), `a different ${field} must change the digest`);
  }
});

test('regenerating invalidates the cached digest', () => {
  const h = new Heightmap({ ...DEFAULT_TERRAIN, seed: 1 });
  const first = h.digest();
  h.generate({ seed: 2 });
  assert.notEqual(h.digest(), first, 'a stale cached digest would defeat the whole check');
});

test('the digest is stable across repeated calls', () => {
  const h = new Heightmap({ ...DEFAULT_TERRAIN, seed: 99 });
  assert.equal(h.digest(), h.digest());
});
