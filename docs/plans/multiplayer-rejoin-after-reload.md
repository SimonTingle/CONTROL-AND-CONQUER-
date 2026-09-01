# Multiplayer pressure test: no way back into a running match

## The report

> "On my end I can occasionally connect, when secondary player connects, the
> player who initiated the game gets booted out. List all errors in order,
> create phased planning, retest until no more errors."

## What did and did not reproduce

Built a full local harness (Postgres, the API server, Vite) and drove real
two-account sessions through Playwright, escalating conditions each round:

| scenario | result |
|---|---|
| two distinct accounts, isolated browser contexts, localhost timing | clean — no boot, both enter |
| same account in two tabs (same cookie jar) | clean — tab 1 unaffected, plays at 20 ticks/s throughout |
| two distinct accounts, throttled network (150ms RTT, capped bandwidth), 2 minutes of real orders on both sides | clean — zero closes, zero page errors, zero failed requests |
| host's own tab reloads mid-match | the **guest's** socket is untouched — the same-user-id "replaced by a new connection" (`4009`) close in `server/src/ws/match.js:200-205` only ever touches the reloading user's own prior socket |

**The literal symptom — "player 2 connecting boots the host" — did not
reproduce under any of these.** The 4009 replace-on-reconnect path is scoped
to `user.id`; nothing found makes a second, genuinely different account's
connection touch the first player's socket.

## What did reproduce, directly and repeatedly

The host-reload case above exposed something else, worth treating as the real
finding: **once a client's tab is gone mid-match — reload, crash, or just
closing and reopening — there was no way back in, for anyone, including the
host.**

Read directly from the code:

```js
// server/src/routes/matches.js — GET /matches, the lobby browse list
where m.status = 'open'
```

A running match is never listed. The only place a match's id lived was
`LobbyScreen.current`, in-page JS state that a reload wipes. Confirmed live:
reload the host's tab mid-match and the guest's `[tick-rate]` log goes
straight to `STALLED` and stays there — exactly the roster-quorum design in
`ws/match.js` ("a drop pauses the match for everyone... until they reconnect")
— except *nobody* had a route back to reconnect through. Neither player could
browse to it (not `open`), and there was no other lookup.

This is not literally the reported mechanism, but on a real flaky connection —
the condition actually being tested — it produces the identical *symptom*: a
hiccup reloads one tab, the match silently freezes, whoever is still there
sees nothing but a stall with no explanation. Two related gaps surfaced
alongside it and are recorded, not fixed, here:

- **No code path ever sets `matches.status = 'finished'`.** Even a match that
  legitimately ends (a win) stays `'running'` in the database forever.
- The in-game "Leave match" action (`endOnlineMatch`, bound to two toast
  buttons) never told the server at all — it only closed the socket and
  reloaded. Left alone, the fix below would have handed a player straight back
  into the exact match they had just deliberately left.

## The fix

**1. `GET /matches/mine`** (`server/src/routes/matches.js`) — the caller's own
`open`-or-`running` match, found via a real join to `match_players` so it can
never leak a match the caller isn't part of. Mirrors the shape of the existing
`GET /matches/:id`.

**2. `LobbyScreen.show()`** (`src/ui/lobbyScreen.js`) now calls
`checkForOwnMatch()` before falling back to the ordinary browse list. It reuses
the exact `renderRoom`/`onStart` transition `refresh()` already has — no new
state machine, and a failed lookup here falls through to the browse list
rather than blocking the lobby from opening at all.

**3. Closing the gap the fix would otherwise have opened** — `leaveMatch` is
extended to work for a `running` match too (previously it only marked
`abandoned` when `status = 'open'`), and `endOnlineMatch`'s two "Leave match"
call sites now go through a new `leaveOnlineMatchDeliberately()`, which awaits
`api.leaveMatch(matchId)` *before* the reload (a reload cancels any request
still in flight — ordering it after or racing it would have lost the call the
same way not making it at all would). The other `endOnlineMatch` call sites —
lost sync, disconnected — are deliberately untouched: their messages say
"please rejoin," and leaving the row alone is what makes that promise
`/matches/mine` can now keep.

## Files

- `server/src/routes/matches.js` — `GET /matches/mine`; `leave` no longer
  restricted to `status = 'open'`.
- `src/net/api.js` — `getMyMatch()`.
- `src/ui/lobbyScreen.js` — `checkForOwnMatch()`, called from `show()`.
- `src/main.js` — `LobbyScreen` gets `getAccount`; `match.matchId` retained on
  the live match object; `leaveOnlineMatchDeliberately()`.
- `server/test/matches-mine.test.mjs` (new, real Postgres integration test).
- `tests/lobby-rejoin.test.mjs` (new, dependency-free, fake-DOM — same
  approach as the existing `lobby-reentry.test.mjs`).

## Verification

- **`npm test`** (root) — 506 pass, 6 new.
- **`node --test server/test/`** — 10 pass, 5 new. `matches-mine.test.mjs`
  uses a real local Postgres and the app's real `build()`/`createSession()` —
  not mocks — since the value under test is the SQL join and status filter;
  every row it creates is deleted in a `finally`.
- **Six negative controls**, each by surgical edit, each failing behaviourally
  and restored: `checkForOwnMatch` not checking `status === 'running'`; the
  `entered` guard removed (races the poll loop); `show()` reverted to call
  `renderBrowser()` alone (needed a dedicated spy-based test — every other
  test called `checkForOwnMatch()` directly and so didn't exercise the wiring,
  confirmed by hand before adding it); the server route's status filter
  widened to include `finished`/`abandoned`; the server route's membership
  join removed (leaks another user's match).
- **End-to-end browser verification of the exact bug**, with the real fix
  running against a real local Postgres/API/Vite stack: two real accounts,
  a live match, host's tab reloaded mid-match. Before the fix, per the earlier
  pressure-test round: guest stuck on `STALLED`, host had no path back. After:
  host reopens Multiplayer Online (no manual match-picking) and is back in —
  both HUDs visible, guest's tick rate resumes from `STALLED` to 15/s, zero
  page errors on either side.

## Honest limits

- **The literal reported mechanism — second player's connection booting the
  host — was not reproduced**, under distinct accounts, same-account two tabs,
  or a throttled network. What's shipped here is the closest verified adjacent
  bug, not a confirmed fix for the exact causal chain described. If the
  original symptom recurs after this, it is a different bug and needs fresh
  reproduction, not a reopening of this one.
- **Not fixed:** matches never transition to `status = 'finished'`. A won
  match still shows up forever to `/matches/mine` and would offer a "rejoin"
  into a game that already ended. Out of scope for this pass — flagged, not
  addressed.
- **Not fixed:** a *guest* whose tab reloads mid-match now has the same
  `/matches/mine` recovery path as the host, but this was only end-to-end
  verified for the host-reload direction, since that is what the pressure
  test actually produced. The guest path is covered by the same code (there is
  no host/guest branch in `checkForOwnMatch`) and by the unit tests, but not
  separately reproduced live.
- Every browser round in this investigation ran in this sandbox's headless,
  software-rendered Chromium (`GPU stall due to ReadPixels`, forced WebGL
  fallback) — several early runs mistook slow first-frame rendering for a
  hang before wait times were lengthened. Confirming on real hardware/network
  conditions is still worth doing given the report is specifically about a
  degraded real-world connection.
