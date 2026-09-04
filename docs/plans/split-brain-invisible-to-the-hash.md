# Two players, one match, two different worlds — and the desync check said everything was fine

## The report

> "I was playing an online multiplayer with a friend. All the debugging
> statistics matched on the top of the screen, we were using the same seed
> etc.. however when I explored and found a base it was not his base and there
> were only us two players officially on the map. I could see his statistics
> correctly in the hamburger menu too. He arrived at what he thought was my
> base, but it wasn't my base and I couldn't see him. Something wasn't right. I
> destroyed the enemy base, but that base wasn't his, as I looked at his screen
> and he wasn't affected."

## The finding

`src/core/stateHash.js`, before this change:

```js
const vs = vehicles.instances.filter((v) => !v.dead).sort(byId);
for (const v of vs) {
  parts.push(`v${v.id},${v.teamId},${q(p.x)},${q(p.z)},...`);   // position
}

const ss = structures.instances.filter((s) => !s.dead).sort(byId);
for (const s of ss) {
  parts.push(`s${s.id},${s.teamId},${q(s.health)},${q(s.progress)},${s.mode}`);
}                                                              // no position
```

Vehicles are hashed with their coordinates. **Structures were not.** A base
station is a structure. So two clients could hold every building on the map in
a completely different place and the state hash — the only cross-client
correctness check this game has — would report `AGREED`.

That is the answer to "why did nobody get told". Whatever moved the two worlds
apart, this is why the players spent an entire match discovering it by walking
around instead of being shown a desync at the first checkpoint ten turns in.

The statistics screen could not have helped either. `src/ui/statisticsScreen.js`
is per-team scalar counters — credits earned, units built, kills — with **zero
spatial content**. Two clients running the same command stream converge on
identical counters whether or not they agree about where anything is. "I could
see his statistics correctly" is not evidence of a shared world, and it was
reasonable of the players to think it was.

### The second hole: nobody checks the island

Only the **seed** crosses the wire (`server/src/ws/match.js`). Every other
terrain parameter — resolution, amplitude, octaves, the noise implementation
itself — comes from each client's own bundle
(`src/main.js`: `world.regenerate({ ...DEFAULT_TERRAIN, seed: welcome.seed })`).
And `hashState` never read the terrain.

Every spawn point is derived from the heightfield (`findTeamSpawnPoints`), so
two peers who generated different islands from one seed would place their bases
in different places and then play two different games. Nothing anywhere would
have said so.

## What was ruled out, and how

The investigation is worth recording because three plausible causes were
eliminated, and eliminating them is what left the hash itself as the finding.

- **Different builds.** The obvious way to get two different islands from one
  seed. `PROTOCOL_VERSION` guards the wire format, not simulation constants, so
  a stale cached bundle would not be caught. The user confirmed both machines
  showed the same commit hash — so this was not the trigger here, though it
  remains a live hazard for anyone else, and is now closed.
- **Phantom empty seats.** `src/main.js` sized the team roster from
  `info.maxPlayers`, the lobby's *capacity*, while the whole relay uses the
  real roster. A 6-seat lobby that two people join built six teams and spawned
  six base stations — four owned by nobody and, because unfilled human seats
  are still flagged human, with no AI commander either. Inert bases a player
  can find, attack and destroy with no opponent behind them, identical on every
  client so nothing reports a desync. **This reproduces the report exactly**,
  but the user left the seat slider at its default of 2, so it is not what
  happened to them. Found on the way, fixed here.
- **Local terrain drift.** `DEFAULT_TERRAIN` is all literals and is never
  mutated; `heightAt` reads a `Float32Array` built purely from seed and params;
  `deviceTier` touches only the GPU texture filter, not `this.data`.
- **Rejoin duplicating the world.** `deserialize` clears vehicles and
  structures before restoring.

## What is still unknown, stated plainly

**The trigger that moved the two worlds apart has not been identified.** With
same-build confirmed, the islands should have been identical and therefore so
should the base positions. I could not derive the cause from the report, and I
have not guessed at one in code.

What this change does is make that class of divergence *impossible to have
quietly*: it would now be reported at the first checkpoint instead of being
played through. If it recurs, `window.__worldCheck()` (added here) answers the
question in one line on each machine.

That is a smaller claim than "fixed", and it is the honest one.

## The changes

**1. Structure position and def id join the state hash**
(`src/core/stateHash.js`). The single change that would have turned the reported
match into a loud `DESYNC` within ten turns. Read from `s.x`/`s.z` — what
`serializeStructure` already treats as authoritative placement — and quantised
on the same terms as vehicle positions, so a sub-centimetre trig difference
still does not trigger a pointless resync.

**2. A terrain digest, folded into the same hash**
(`Heightmap.digest()`, `src/terrain/heightmap.js`). FNV-1a over every 7th sample
of the generated field, quantised to 1e-4 of normalised height, cached until
`generate()`. Deliberately *not* invalidated by craters or terraform: those are
replayed identically from the shared intent stream, so they are not a source of
disagreement about the island. Folding it into `hashState` rather than adding a
new message reuses the comparison, reporting and resync machinery that already
exists.

**3. `PROTOCOL_VERSION` 4 → 5**, in both `src/net/matchClient.js` and
`server/src/ws/matchRoom.js`. The hash format changed, so two peers straddling
this bump would compute different hashes for an identical world and desync
permanently. Refusing the connection with a named error is the honest answer.
**Both players must reload after this deploys.**

**4. Teams are sized from the roster, not the lobby's capacity**
(`src/main.js`). `welcome.expectedPlayers` has always been on the wire; the
client ignored it in favour of `info.maxPlayers`. It is the number the relay's
own start barrier and turn quorum already use — `max_players` is used nowhere
in the relay at all. Safe because joins are refused once a match leaves `open`
(`server/src/routes/matches.js`), so the roster is frozen before any socket
connects and team ids are always below it.

**5. The lobby no longer claims empty seats fill with AI.** The comment at the
start button said "Starting alone is legal (the other seats fill with AI)".
They did not: an unoccupied *human* seat became a team with a base and nothing
driving it. That text is what would lead a host into the phantom-base case.

**6. `findSpawnPointNear` gains a `deterministic` option**
(`src/core/pick.js`), and `deployStartingForces` uses it. The function's final
fallback returns `findEdgeSpawnPoint(heightmap, camera, ...)`, which reads the
**local camera's yaw** — per-client state feeding a simulated unit's position, a
split-brain seeded at tick zero from a line that looks like a harmless
fallback. It is effectively unreachable there (the base it searches around was
itself placed on dry land), but "effectively unreachable" is not a guarantee.

**7. `window.__worldCheck()`** (`src/main.js`) — terrain digest, hash, team
count, and every base and unit with its coordinates, in one object, for two
players to read from a console and diff by eye. Written because that question
once took a whole match to answer.

## Verification

**The reproduction came first.** `tests/state-hash-blind-spots.test.mjs` was
written and run *before* the fix, and failed:

```
not ok 1 - two worlds whose bases stand in different places hash differently
not ok 4 - two clients that built a different structure in the same place disagree
# pass 6, fail 2
```

Two worlds identical but for a base 360 units away, hashing equal. That is the
reported bug, recreated. After the fix, 8/8.

**Negative controls**, each applied by surgical edit and restored — and one
worth recording as a process note: the first attempt used a `perl` substitution
that silently failed to match, so the suite "passed" while proving nothing. It
was re-run with the revert verified before trusting the result.

| Reverted | What failed |
|---|---|
| structure position + defId out of the hash | the two reproduction tests, behaviourally |
| `digest()` ignoring the heightfield | seed sensitivity, param sensitivity, cache invalidation |
| team count back to lobby capacity | 6-seat/2-player builds 6 teams and 6 spawn points |

**Full suite: 564 passing, 0 failing** (546 before; 18 new). Dependency-free,
as `CLAUDE.md` requires.

**Real infrastructure**, Postgres 16 + the API server, per
`docs/plans/e2e-harness.md`:

- `tests/e2e/two-client-match.mjs` — **22/22**, including the protocol
  handshake now correctly reporting `serverVersion: 5`.
- `tests/e2e/custom-vehicle-match.mjs` — **8/8**.
- `tests/e2e/underfilled-lobby.mjs` (new) — **7/7**. Six seats, two players,
  against a real server: `expectedPlayers=2` while `maxPlayers=6`, both clients
  told the same number, team ids packed from zero and both below the roster
  size, and the client's own arithmetic yielding 2 teams where it previously
  yielded 6. No other test in the repo covered an under-filled lobby, which is
  exactly why the bug survived.

**Live browser** (`?benchmark=8`): `window.__worldCheck()` returns a terrain
digest, a hash, and unit positions, with no page errors.

**Both builds pass** — root and the `itch.io` fork.

## Not verified

- **That this fixes the reported match.** The trigger is unidentified. What is
  demonstrated is that the same divergence would now be reported rather than
  played through silently.
- **Two real browsers in one match.** This environment cannot stand up two
  logged-in game clients rendering 3D at once; the e2e harness proves the
  server contract, and the unit tests prove the arithmetic and the hash, but
  the two composed in a live match is argued, not observed.
- **`amplitude` is not covered by the terrain digest** — it scales `heightAt`,
  not the normalised field the digest walks. Recorded in the test rather than
  asserted, so the limit is documented instead of assumed.

## Found and deliberately not fixed

- **The hash still omits** vehicle `y`, structure `angle`/`upgradeLevel`/
  `padId`, turret bearing, orders and targets, crater and terraform state, and
  fog. Each is a smaller version of the same hole. Structure position was fixed
  alone because it is the one a whole match was lost to; widening further in
  the same change would make the desync check noisier without evidence that any
  of the rest has ever mattered.
- **A stale bundle is still only caught by `PROTOCOL_VERSION`**, which is
  hand-bumped. The terrain digest now catches the specific consequence that
  matters, but two builds differing in some *other* simulation constant would
  still only be caught once they visibly diverge.
