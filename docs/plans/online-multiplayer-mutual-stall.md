# Online multiplayer: mutual stall on two backgrounded tabs

## The report

A two-player match got stuck: both clients simultaneously showed `STALLED`
and "Still waiting for the other player," each apparently waiting on the
other, at different checkpoints/ticks (team 1 at checkpoint t40/tick 300,
team 0 at checkpoint t50/tick 324). Both were run as two browser tabs/windows
on one computer, against a single API server instance that was not
redeployed or restarted during the session.

## Ruling out the three previously-fixed failure modes

`eb097cd`, `58109f1`, and `8540fe6` (see `bug-fixed.md` and
`docs/plans/online-multiplayer-desync.md`,
`online-multiplayer-quorum-and-rejoin.md`,
`online-multiplayer-protocol-handshake.md`) already fixed every previously
diagnosed way this symptom could happen — a short-rostered start, a late
joiner never receiving `begin`, a disconnected client demoting to local
simulation, a running-match quorum keyed on connection count instead of
roster, an unprimed `resumeAt`, a dead `resyncNeeded` handler, a reaper that
punished a legitimately-stalled (not dead) peer, and an unversioned protocol
mismatch. None of those fits here: `AGREED @tNN (2)` is a *sticky* field,
written only once the server has actually bucketed two clients' hashes for
the same turn and found them equal (`src/ui/netDebug.js`,
`server/src/ws/match.js`'s `'hash'` handler). Seeing it on both screens means
the two clients genuinely *did* converge earlier in this match — this is a
new divergence afterward, not a repeat of a client that never joined
properly.

## Ruling out per-process room splitting

`server/src/ws/match.js`'s `rooms` map is in-memory and per-process (module
header, lines 1–56); a redeploy mid-match or more than one replica without
sticky sessions would silently split two players into separate rooms under
one match id, each with its own quorum that can never again produce a shared
verdict. Asked directly: the server was a single instance and was not
redeployed during this session. That rules this out for this incident,
though it remains a real, still-unhardened gap worth logging for next time
(see below).

## Leading hypothesis: `requestAnimationFrame` throttling on a backgrounded tab

Confirmed test setup: both clients were tabs/windows on one machine, which
the user alt-tabbed between to check on each side.

The simulation loop is driven entirely by `requestAnimationFrame`
(`src/main.js`, `animate()`), with a bounded catch-up (`MAX_FRAME_DT = 0.25`,
`MAX_CATCHUP_STEPS = 5`) and no `visibilitychange` handling anywhere in
`src/`. `LockstepSession.beginStep()` (`src/net/lockstep.js:120-149`) — which
advances the turn counter and sends this client's own input for `turn +
inputDelayTurns` — only ever runs from inside `simTick`, which only ever runs
from inside `animate()`.

Browsers throttle `requestAnimationFrame` hard for a tab/window that is not
currently focused (commonly to ~1 call/s or less). A backgrounded tab's
`animate()` calls collapse to that rate, and even then process at most 5 sim
steps per call — it falls far behind wall-clock time and stops sending new
turn input almost immediately (per the comment at `lockstep.js:138-146`, a
stalled client — one missing an input turn — automatically stops sending
further input, which is what keeps turn numbering from running away from the
simulation). The foregrounded tab keeps running normally, exhausts the input
buffer its peer pre-sent, and correctly stalls waiting for the backgrounded
tab's next turn report. Because the user alt-tabs to check the *other*
client, whichever tab is currently being looked at is, by construction, the
one whose peer is currently backgrounded — so it shows `STALLED`. Switching
tabs flips which side is backgrounded and which one stalls, matching "each
team was waiting for the other team."

This isn't purely a same-machine testing artifact: it would affect two
separate real players any time one alt-tabs away mid-match. Same-machine
testing just makes it trivial to trigger, since checking on one client
requires backgrounding the other.

## Not yet confirmed

This hypothesis is well-supported by the code (no `visibilitychange`
handling, a tick loop entirely gated on `requestAnimationFrame`) and by the
reported test setup, but has not yet been observed directly — no logging
existed anywhere in the lockstep path to check it against. Confirmed instead:
`server/src/ws/match.js` had zero `console.*` calls, and
`src/net/matchClient.js` had none either — a repro at the time of the report
would not have produced anything postable.

## What changed here

Added minimal, permanent diagnostic logging so the next repro is checkable
directly, without speculating further:

- `src/main.js`: a `visibilitychange` listener logging transitions with a
  timestamp, and a per-second log of match ticks actually processed
  (`[tick-rate] N match ticks/s · visibility=... [· STALLED]`) whenever an
  online match is live. If the throttling hypothesis is right, tick rate
  should collapse in lockstep with `visibility` going `hidden`, and the stall
  should follow shortly after (bounded by `inputDelayTurns`).
- `src/net/matchClient.js`: a `case 'pong'` (previously silently dropped by
  the `default:` case — the heartbeat's replies were never read at all,
  only sent), and logging on socket `close`/`error` with code/reason. This
  also leaves a trail for the *other* still-unconfirmed hypothesis noted in
  `online-multiplayer-desync.md` — a half-open socket whose inbound leg died
  while the outbound heartbeat kept the server's reaper fooled.
- `server/src/ws/match.js`: logs room creation (to catch the per-process
  room-split case directly if it recurs), each `agreed`/`desync` broadcast
  (turn + peer count), each `reapSilent` drop (elapsed silence), and each
  server-side socket close (code/reason) — closing the "nothing to post"
  gap above.

No behavior changed; `npm test` (all 29 cases) and a `vite build` both pass
unchanged after this patch.

## Next step

Reproduce with the same alt-tab pattern and collect both tabs' browser
console output plus the server log for that window. If the tick-rate log
confirms the collapse, the fix is to decouple `LockstepSession` progression
(and the WS heartbeat) from `requestAnimationFrame` for online matches — e.g.
a `setInterval`-based ticker or a Worker heartbeat — while leaving rendering
on `requestAnimationFrame`, which is fine to throttle when there is nothing
to draw. Not implemented yet: doing so before the tick-rate log confirms the
mechanism would be guessing at a fix for an unconfirmed cause, which this
repo's convention (`CLAUDE.md`, "write the negative control") is explicit
about not doing.
