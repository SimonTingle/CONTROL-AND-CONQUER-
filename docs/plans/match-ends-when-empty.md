# A match's own DB row now ends when its last player leaves

## What prompted this

Reported directly: "when all players leave a match, the match stays
running, and when a player tries to start a new game online or join the
lobby, the player gets added to an old stagnant game that should have been
killed."

Same practical symptom as the earlier orphaned-match bug
(`docs/plans/orphaned-match-hijack.md`), which the user confirmed fixed —
but that fix only runs `abandonOrphanedMatches()` once, at server boot. It
is correct *and only* correct there, because it can only be sure a room is
dead once the process that ran it is a genuinely fresh one (`rooms` is
purely in-memory — see `matchRoom.js`'s header). It does nothing for a match
that empties out while the server keeps running, which is how almost every
match actually ends — players just close the tab or quit the game; nobody
restarts the API for that.

## The two real gaps

1. **`server/src/ws/match.js`'s socket `close` handler** already detects the
   exact moment a match truly ends: `if (room.players.size === 0)
   rooms.delete(matchId);`. It deletes the in-memory room, but never told
   the database. The row stayed `status = 'running'` forever from that point
   on.
2. **`server/src/routes/matches.js`'s `POST /matches/:id/leave`** only ever
   marked a match `abandoned` when the *leaving user was the host* **and**
   the match was still `status = 'open'`. A non-host leaving a running
   match, or the host leaving one, never ended it — even as the last player
   out.

Both let a match's DB row outlive every reason it should still be
`open`/`running`, and `GET /matches/mine` (added for reload-recovery) has no
way to tell that apart from a genuinely live match — so it kept auto-
rejoining the next player who opened the lobby straight into the dead one,
exactly as reported.

## The fix

- **`match.js`**: alongside the existing `rooms.delete(matchId)`, an
  `UPDATE matches SET status = $2 WHERE id = $1 AND status IN ('open',
  'running')` — `'finished'` if the room had actually started, `'abandoned'`
  if not (mirrors the existing vocabulary; nothing in the JS codebase
  branches on which of the two a done match has, confirmed by grep — this
  is for a human reading the row later, not load-bearing). Fire-and-forget
  with a `.catch()`, matching this file's existing best-effort style: the
  in-memory room is already gone regardless of whether the DB write
  succeeds.
- **`matches.js`'s `leave` route**: after deleting the leaving player's row,
  an added check — if the roster is now empty, mark the match `finished`
  regardless of status or who left. Additive alongside the existing
  host-leaves-an-open-lobby rule, not a replacement for it.

## Files

- `server/src/ws/match.js` — the `close` handler.
- `server/src/routes/matches.js` — the `leave` route.
- `server/test/leave-empties-match.test.mjs` (new) — real-Postgres,
  `app.inject`: a running 2-player match stays `running` after the first
  player leaves, becomes `finished` after the second, and `/matches/mine`
  stops offering it back.
- `tests/e2e/two-client-match.mjs` (extended) — the only place with a real
  server + real WebSocket clients + a real DB, so the only place that can
  actually verify the `close` handler's DB update, not just the `leave`
  route's SQL. Both sockets close, then `GET /matches/:id` (the ordinary
  client-facing route, not a direct DB query) confirms `status` left
  `running`.

## Verification

- `node --test server/test/*.mjs` — 19 pass (3 new, 16 existing, no
  regressions in `matches-mine.test.mjs`/`abandon-orphaned-matches.test.mjs`/
  `create-match-player-cap.test.mjs`).
- `node tests/e2e/two-client-match.mjs` against a real local server + real
  Postgres — 19/19 pass, including the new "the match is no longer running
  once both sockets have closed" assertion (`status=finished`).
- **Two negative controls**, each by surgical edit (`cp` backup, not `git
  checkout`), each confirmed to fail for the right reason and restored:
  - `leave`'s new "remaining roster empty" branch commented out — the
    "marked finished once the last player leaves" test failed on that exact
    assertion.
  - `match.js`'s DB update on room-empty commented out — re-ran the real
    e2e suite against a real server with the reverted code: 18/19 passed,
    the new assertion failed with `status=running` (the literal reported
    symptom), everything else unaffected.
- `npm test` (root) — 519 pass, unaffected (no simulation code touched).
- Root build passes.

## Not done

- `itch.io/` was not touched or resynced — nothing in this change lives in
  `src/`; it is entirely `server/`.
- The `MATCH_START_REPORT_MS`-tunable e2e harness is not part of `npm test`
  and needs a real local Postgres + a manually started API server, per its
  own header — it was run manually for this change (twice, once against the
  negative control) but is not exercised by CI.
