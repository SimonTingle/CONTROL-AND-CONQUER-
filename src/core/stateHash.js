/**
 * A digest of everything the simulation is allowed to disagree about.
 *
 * Lockstep's whole premise is that identical inputs produce identical state on
 * every machine. That premise cannot be fully guaranteed here: the sim leans on
 * `Math.sin/cos/atan2` in dozens of places, and IEEE-754 pins the last bit only
 * for `+ - * /` and `sqrt` — transcendentals may differ between JS engines and
 * CPUs. So rather than assume convergence, we measure it: clients exchange this
 * hash periodically and resync from the host when it disagrees.
 *
 * Two design points matter for correctness:
 *
 *  - **Iteration is by id, never array order.** `vehicles.instances` is a plain
 *    array whose order depends on spawn/removal history, which is *not* part of
 *    the game state two clients need to agree on. Hashing it directly would
 *    report a desync where none exists.
 *
 *  - **Floats are quantised before hashing.** Raw bits would flag a 1e-16 trig
 *    difference as a full desync and trigger a pointless resync every few
 *    seconds. Quantising to QUANTUM means the hash only moves when something has
 *    drifted enough to matter. The tradeoff is real and worth stating: a value
 *    sitting exactly on a rounding boundary can still hash differently from a
 *    negligible difference. That is tolerable precisely because a hash mismatch
 *    triggers a snapshot resync rather than an error — a false positive costs
 *    one redundant state transfer, not a broken match.
 */

import { fnv1a } from './fnv1a.js';

/** World units (and hitpoints) per hash step. See the note on quantisation above. */
const QUANTUM = 100; // i.e. 0.01 resolution

/** Quantise a float to an integer, with NaN/undefined collapsing to a constant. */
function q(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'x';
  return Math.round(v * QUANTUM);
}

function byId(a, b) {
  return a.id - b.id;
}

/**
 * Hash the simulation state of a running match.
 *
 * @param {object} ctx `{ vehicles, structures, game }` — the same shape the
 *   command context and snapshot serializer already take.
 * @param {number} tick the sim tick this hash describes; included so a hash can
 *   never be compared against one from a different point in time.
 * @returns {string} `"<tick>:<hex>"`
 */
export function hashState({ vehicles, structures, game, projectiles, bounties, blooms, harvesterAI, heightmap }, tick) {
  const parts = [`t${tick}`];

  // The island itself is part of what two clients must agree on, and until now
  // nothing checked it: only the *seed* crosses the wire, while resolution,
  // amplitude, octaves and the noise implementation all come from each
  // client's own bundle. Every spawn point is derived from the heightfield, so
  // two peers who generated different islands place their bases in different
  // places — and then play two different games while every other number on
  // screen agrees. Folding the digest in here means that shows up as a desync
  // at the first checkpoint, through the comparison machinery that already
  // exists, rather than as a match nobody can explain.
  //
  // Optional so single-player and the existing tests can omit it.
  if (heightmap?.digest) parts.push(`land${heightmap.digest()}`);

  const vs = vehicles.instances.filter((v) => !v.dead).sort(byId);
  for (const v of vs) {
    const p = v.group.position;
    // `kills` joins the hash now that it decides something: veterancy scales
    // accuracy and damage (vehicles/veterancy.js), and the bounty a wreck
    // drops. Before that it was a display stat, and a client whose tally had
    // drifted still simulated identically; now a one-kill disagreement means
    // two clients rolling different hit chances from the same shot.
    parts.push(
      `v${v.id},${v.teamId},${q(p.x)},${q(p.z)},${q(v.heading)},${q(v.health)},${v.mode},${v.kills ?? 0}`
    );
  }

  // Position and def id are here because they were once missing, and a real
  // match was lost to it: two players, same seed, this hash reporting
  // agreement the whole time, each unable to find the other's base — because a
  // structure could stand anywhere on either client and still hash equal. A
  // base station is a structure, so the only cross-client check the game has
  // was blind to where every building on the map actually was. Vehicles were
  // always hashed with their position; structures simply never were. See
  // docs/plans/split-brain-invisible-to-the-hash.md.
  //
  // Read from `s.x`/`s.z` rather than a mesh position, matching what
  // `serializeStructure` (core/snapshot.js) treats as the authoritative
  // placement — the mesh follows those, not the other way round.
  const ss = structures.instances.filter((s) => !s.dead).sort(byId);
  for (const s of ss) {
    parts.push(
      `s${s.id},${s.teamId},${q(s.x)},${q(s.z)},${s.def?.id ?? '?'},${q(s.health)},${q(s.progress)},${s.mode}`
    );
  }

  // Blocked crystal fields. This now decides where a team's harvesters go —
  // two clients disagreeing about a block route their economies differently
  // and diverge within seconds, well before the effect would show up anywhere
  // else being hashed. Only fields with at least one block are worth a part;
  // most fields have none. Team ids are sorted because Set iteration order is
  // insertion order, which is not guaranteed to agree between two clients
  // that blocked the same field in a different sequence.
  if (blooms) {
    for (const f of blooms.fields) {
      if (!f.blockedByTeam || f.blockedByTeam.size === 0) continue;
      const teams = [...f.blockedByTeam].sort((a, b) => a - b);
      parts.push(`bf${f.id},${teams.join('.')}`);
    }
  }

  // Contested ground (harvesterAI's team-shared danger zones). Hashed for
  // exactly the reason blocked fields above are: this decides where a team's
  // harvesters go, so two clients disagreeing about a zone route their
  // economies apart within seconds — long before the divergence would surface
  // in the positions and credits that are hashed downstream of it.
  //
  // Teams are sorted, and zones within a team are sorted by their own
  // coordinates, because Map iteration is insertion order: two clients that
  // recorded the same two ambushes in a different sequence hold identical
  // state in a different order, and must still hash the same.
  if (harvesterAI?.dangerZones) {
    const teamIds = [...harvesterAI.dangerZones.keys()].sort((a, b) => a - b);
    for (const teamId of teamIds) {
      const zones = harvesterAI.dangerZones.get(teamId) ?? [];
      if (!zones.length) continue;
      const sorted = zones
        .map((z) => `${q(z.x)}.${q(z.z)}.${q(z.radius)}.${q(z.until)}`)
        .sort();
      parts.push(`dz${teamId},${sorted.join('|')}`);
    }
  }

  // Shells in flight. Their `willHit` is the accuracy roll's verdict, decided
  // at launch, so two clients that rolled differently disagree here a whole
  // flight-time *before* the damage lands — which is the earliest a resync can
  // possibly catch it. Positions are quantised like everything else; the
  // integration is plain multiply-add, so they should agree exactly.
  if (projectiles) {
    const ps = projectiles.instances.slice().sort(byId);
    for (const pr of ps) {
      parts.push(`p${pr.id},${pr.teamId},${q(pr.x)},${q(pr.z)},${q(pr.y)},${pr.willHit ? 1 : 0}`);
    }
  }

  // Uncollected bounty coins. A coin is credits waiting to happen, so a client
  // that has one the others don't is already economically divergent.
  if (bounties) {
    const cs = bounties.instances.slice().sort(byId);
    for (const c of cs) {
      parts.push(`b${c.id},${q(c.x)},${q(c.z)},${c.value},${c.expiresAtTick}`);
    }
  }

  // Credits and elimination are the two team-level facts a divergence shows up
  // in fastest — an economy that drifts by one harvest load is already broken.
  for (const t of game.teams) {
    parts.push(`c${t.id},${q(t.credits)},${t.defeated ? 1 : 0},${t.weaponTier}`);
  }

  return `${tick}:${fnv1a(parts.join('|')).toString(16).padStart(8, '0')}`;
}
