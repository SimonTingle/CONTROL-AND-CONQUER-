# Online matches up to 20 players, with equal spawn separation

## Request

"allow upto 20 players in an online match, make sure there is equal
seperation between players spawn points"

## What was already in place

The simulation side turned out to already be generic over team count —
nothing here needed touching:

- `src/core/pick.js`'s `findTeamSpawnPoints(heightmap, count, opts)` splits a
  full circle into `count` equal slices for *any* `count`, nudging each
  point within its own slice only when needed to clear `minSeparation` from
  an already-placed neighbor. It has no hardcoded team limit.
- `src/main.js`'s `startOnlineMatch` already computes
  `totalTeams = info.maxPlayers + info.aiCount` from the lobby row (not from
  who happens to be connected) and sets `game.aiMatch.teamCount =
  totalTeams - 1`; `beginMatch` calls `createTeams(teamCount)`, and
  `deployStartingForces` calls `findTeamSpawnPoints(heightmap,
  game.teams.length)`. All of it was already parameterized on team count.

So this was a matchmaking-limit change plus UI, not a simulation change.

## What was actually capped at 4

- `server/src/routes/matches.js`'s `createBody` zod schema:
  `maxPlayers: z.number().int().min(2).max(4)`.
- `matches` table's check constraint: `max_players between 2 and 4`
  (`004_matches.sql`).
- `src/ui/lobbyScreen.js`'s `create()` hardcoded `maxPlayers: 2` with no UI
  to choose otherwise — even once the server allowed more, there was no way
  for a host to ask for it.
- `src/core/team.js`'s `AI_NAMES`/`AI_COLORS` only had 4 entries each. Not a
  hard limit (`i % AI_NAMES.length` wraps safely), but a 20-player match
  would have repeated the same 4 colors 5 times over, which defeats the
  point of the "equal separation" ask — evenly spaced positions that still
  look identical in color are not meaningfully separated to a player glancing
  at the map.

## Changes

- **`server/src/db/migrations/007_max_players_20.sql`** (new): drops and
  re-adds `matches_max_players_check` with `between 2 and 20`.
- **`server/src/routes/matches.js`**: `maxPlayers` schema bound raised to
  `max(20)`.
- **`src/ui/lobbyScreen.js`**: new `newMatchMaxPlayers` field (default 2,
  persists across the poll loop's re-renders) and a `createPlayerCountField()`
  slider (2–20) shown above "Create match" in the browse view; `create()`
  now passes it through instead of the hardcoded `2`.
- **`src/core/team.js`**: `AI_NAMES`/`AI_COLORS` extended from 4 to 19
  entries — one per possible non-host seat in a full 20-player match — hues
  spread around the wheel and kept clear of the human player's own teal
  accent color, so a large match still reads as N distinct teams rather than
  4 colors repeating.

## Verification

- **`tests/team-spawn-points.test.mjs`** (new test): 20 teams on a wide-open
  synthetic heightmap land at exactly `i * (2π/20)` (normalized for angle
  wraparound) with every pair of angularly-adjacent teams the same chord
  distance apart (range under 1 unit) — the actual "equal separation" a
  player sees on the ground, not just equal angles on paper. Negative
  control: slicing by `count + 3` instead of `count` (surgical edit, `cp`
  backup) failed the angle assertion for the right reason; restored,
  confirmed passing again.
- **`server/test/create-match-player-cap.test.mjs`** (new, real Postgres):
  a 20-player match is created successfully (`201`, `maxPlayers: 20`
  echoed back); a 21-player request is rejected (`400`). Negative control:
  reverting the zod bound to `max(4)` (surgical edit) failed the 20-player
  test for the right reason; restored, confirmed both passing again, plus
  the existing `matches-mine.test.mjs`/`abandon-orphaned-matches.test.mjs`
  suites still green (16 server tests total).
- **`npm test`** (root) — 519 pass.
- **Live browser check** (Playwright, real local API + Postgres, a freshly
  registered account): opened Multiplayer Online, set the new slider to 20,
  confirmed the readout reads "20 players". Did not complete an end-to-end
  create-and-join through the UI — the lobby's 2-second poll loop kept
  re-rendering the browse view out from under Playwright's click retry on
  "Create match", a test-tooling timing issue, not a functional one; the
  server-side test above already proves a 20-player match creates
  successfully end to end.
- `itch.io/` synced and built; root build passes.

## Not done

- No UI limit on `aiCount` was touched (still 0–3) — the request was about
  *players*, and AI seats already had their own separate cap. A 20-human
  match can still only add up to 3 AI seats on top, for a 23-team match if
  ever wanted; not requested here so left alone.
- No attempt to raise `MAX_MATCH_DEFS` (16, vehicle-defs-per-host, capped by
  the 64 KiB relay message limit) — unrelated to player count, since it
  bounds the *host's* loadout, not the roster size.
- Real-world performance at 20 simultaneous human players (network load on
  the relay, per-tick simulation cost with 20 teams' worth of fog/AI/economy)
  was not measured — this environment cannot stand up 20 real connected
  clients. The lockstep relay and simulation are both already exercised at
  smaller counts in production; whether 20 is smooth in practice is
  unverified.
