# The real production disconnect, and an on-screen build stamp

## What prompted this

PR #109 (multiplayer pressure test) shipped a fix for a real but different
bug — no way to rejoin a running match after a reload — and was honest that
it had **not** reproduced the literal reported symptom ("when a secondary
player connects, the host gets booted out").

The user then deployed it and sent back real production logs from two actual
two-account matches, plus a request: show the running build's commit on
screen (top-left, visible on mobile and desktop), and find out why only one
device can stay connected to multiplayer at a time.

## Reading the production log

Two matches, both genuinely two distinct accounts (one has a live
`POST /auth/register` creating the second account mid-session, and a `409`
on a repeat attempt with the same email proving it was a real new account,
not a re-registration):

- **`400d1759...`**: create → second account registers → joins → starts →
  both clients open a WebSocket → `[match] agreed in 400d1759... at turn 0: 2
  peers` — the lockstep handshake succeeded — then **1.7 seconds later**,
  `[match] ... socket closed on 400d1759...: code=1006 reason=(none)`.
- **`9c4c06f2...`**: identical shape. Both connect, agree at turn 0, then
  **both** sockets close with `code=1006` — one ~12s after agreeing, the
  other ~19s after.

**No `4009` appears anywhere in this log.** That is the code PR #109's
investigation was built around (`server/src/ws/match.js`'s
same-`user.id`-replaces-the-old-socket close) — its absence here rules that
mechanism out definitively for this report. What's here instead is new:
`code=1006`, the browser's code for "closed abnormally, without a close
frame" — the TCP/TLS connection itself was cut. `server/src/ws/match.js`
only ever closes with an explicit code of its own (`4001`, `4003`, `4009`,
`4010`); `1006` is not one of them, which is why this points at something
between the browser and the Node process — a proxy, a timeout, a dropped
connection — rather than at the application's own logic.

A third session in the same log (`93d78dd3...`, `expectedPlayers=1`
throughout) is the harmless case PR #109's `/matches/mine` already handles
correctly: the same account, on two devices, each rejoining as the other's
tab reloads — clean `code=1001` closes throughout, no `4009`, working as
designed.

## What this change does, and what it honestly can't

**Cannot do:** reach the CapRover instance or the live API (this
environment's egress proxy blocks it — confirmed earlier this session) or
inspect its nginx/proxy configuration, replica count, or timeouts. Whatever
is cutting these connections lives in infrastructure this session cannot see.
That's a concrete ask left for the user, not a code change:

- Is "Websocket Support" actually enabled on the `control-conquer-api` app's
  HTTP settings? (CLAUDE.md already documents this as required; unclear from
  the log whether it's the cause here, but worth re-checking.)
- **Is the app running more than one instance?** `server/src/ws/matchRoom.js`
  says plainly, in its own header, that `rooms` is in-memory and
  per-process. If requests are ever load-balanced across replicas, a second
  player's socket could land on a process with no knowledge of the first
  player's room — a very plausible way to produce exactly this shape of
  failure, independent of any timeout.
- Any reverse-proxy read/idle timeout shorter than the observed window.

**Can do, and did:**

### 1. The commit SHA, on screen, always

`src/ui/versionBadge.js` (new) mounts a small fixed corner element reading
`__APP_VERSION__` — the same build-time constant `vite.config.js` already
computes, now correctly SHA-stamped in production since PR #108's Dockerfile
fix rather than falling through to `'unknown'`. Wired in from `src/main.js`,
right after the existing console log of the same value — on screen this time,
because a console line is invisible on a phone with no attached devtools,
which is exactly the situation that made "are we both on the latest build?"
take reading CapRover deploy logs instead of a glance at either screen.

Positioned below `#menu-toggle` (not beside it — the hamburger already owns
that exact top-left corner) and given a higher `z-index` than every overlay
screen (portal, lobby, difficulty, match-end) so it reads correctly from the
very first landing screen, not only once a match is in progress. Verified
live in a real browser at both a desktop (1440×900) and an iPhone (390×844)
viewport: visible, legible, zero overlap with the hamburger or anything else,
fully on-screen at both sizes.

### 2. A bounded reconnect on an abnormal close

Before this, `matchClient.js`'s `close` event handler always called
`handlers.onClose` immediately and unconditionally — which `main.js` wires to
`endOnlineMatch('Disconnected from the match.')`: instant, no retry, whatever
the code. A transient `1006` — exactly the shape a brief network or proxy
hiccup produces — had the identical outcome as a deliberate kick.

This does not fix whatever is cutting the connection (it can't, per above).
It stops treating every close as equally fatal:

- **Terminal, never retried:** the server's own deliberate codes (`4001`
  authentication_required, `4003` not_a_member, `4009` replaced by a new
  connection, `4010` protocol mismatch) and any clean close (`wasClean`,
  e.g. `1000`/`1001` — the player leaving, the page navigating away). None of
  these are transient; retrying them would just repeat the same outcome more
  slowly.
- **Retried, bounded:** everything else past the point a welcome has ever
  landed (a close *during* the initial handshake is a connection failure
  `connect()` already reports — retrying that silently would only delay a
  real "can't reach the server" error). Three attempts, backing off
  1s/2s/3s, opening a fresh socket to the same match id each time.

The server already resends `welcome` + `begin{resuming:true}` to a socket
reconnecting mid-match (`ws/match.js`'s "arriving after that" branch — the
same mechanism PR #109's `/matches/mine` relies on), so a successful
reconnect resumes play through the *existing* `onBegin` resuming logic rather
than anything new. The one piece that needed wiring: `main.js`'s
`startOnlineMatch` builds its `match` object's `releasedTurn` once, from the
very first welcome; a reconnect's fresh welcome now updates it too (a new
`onWelcome` handler), since `onBegin`'s resume logic reads that field to
decide which turn to resume at — stale, it would resume at the wrong one.

## Files

- `src/ui/versionBadge.js` (new), `src/main.js`, `src/ui/style.css` — the
  badge.
- `src/net/matchClient.js` — `_openSocket`/`_handleMessage`/`_handleClose`/
  `_handleError` (refactored out of `connect()`'s single inline closure so a
  reconnect can reuse the same message handling), the reconnect state
  machine, `close()` cancelling a pending retry.
- `src/main.js` — `onWelcome` handler refreshing `match.releasedTurn`.
- `tests/version-badge.test.mjs`, `tests/match-client-reconnect.test.mjs`
  (both new, dependency-free).

## Verification

- **`npm test`** — 518 pass, 12 new (4 badge, 8 reconnect).
- **Five negative controls**, each by surgical edit, each failing
  behaviourally and restored: `TERMINAL_CLOSE_CODES` emptied (a deliberate
  server close gets retried); the `wasClean` check dropped from the retry
  condition (a clean close gets retried); the attempt budget removed
  (retries forever); the badge's `aria-hidden` attribute dropped; the badge
  not appended to `document.body`.
- **Live browser check** of the badge at two real viewport sizes (screenshots
  taken), confirming position, legibility, and no overlap.
- Root and `itch.io/` builds both pass; `itch.io/` synced.
- **The reconnect logic itself was not verified against the actual
  production failure** — there is no way to reproduce a `1006` from this
  environment (it would require actually cutting a live TCP connection
  through whatever infrastructure is doing it, which this session cannot
  reach). It is verified against a fake WebSocket driving the real state
  machine in `matchClient.js`, and argued from the log evidence — not proven
  against the real failure mode.

## Follow-up: instance count checked, one more retry-code gap closed

The user checked CapRover directly: `control-conquer-api`'s **Instance
Count is 1**. That rules out the multi-replica hypothesis above outright —
`matchRoom.js`'s in-memory, per-process room state was never split across
processes for these matches. It is not the cause of the observed `1006`
closures.

While checking, a fresh production log (single-account reconnect flow, no
new `1006` case) surfaced `[match] reaping <user> from <matchId>: silent for
15150ms` — `matchRoom.js`'s `reapSilent`, which drops a socket after
`DROP_AFTER_MS` (15s) of silence via an explicit `socket.close(4008, 'timed
out')`. That code was missing from `matchClient.js`'s `TERMINAL_CLOSE_CODES`
(`4001, 4003, 4009, 4010` — no `4008`), so a legitimately-timed-out player
would have been retried by this change's own reconnect logic instead of
being told plainly they timed out. Fixed: `4008` added to the set, with a
negative control (reverted, confirmed
`tests/match-client-reconnect.test.mjs`'s server-codes test fails for `4008`
specifically, for the right reason; restored, confirmed passing again).
This is a real gap closed, not a fix for the `1006` mystery — `reapSilent`
closes with an explicit `4008`, never `1006`, so it was never the mechanism
behind the original two-account reports either.

The `1006` root cause is still open. With multi-replica ruled out, the
remaining concrete things worth checking on the CapRover side are the same
two named above: "Websocket Support" actually enabled on the app's HTTP
settings, and any reverse-proxy read/idle timeout under roughly the
observed 2–20 second window.

## Honest limits

- **This does not fix the root cause.** If it is a load-balancer routing two
  players' sockets to different processes (the most concrete, testable
  hypothesis this investigation produced — see `matchRoom.js`'s own
  in-memory, per-process warning), no amount of client-side retry closes that
  gap; the reconnect would just fail the same way, repeatedly, until the
  budget runs out. That specific question — is the API app running more than
  one instance — is the single most useful thing to check next, and this
  session cannot check it.
- The reconnect is bounded (3 attempts, ~1–3s backoff each) on purpose: a
  genuinely dead match must still end cleanly rather than retry forever. If
  the real interruption lasts longer than ~6 seconds, this will not save it —
  it will just delay the same "Disconnected from the match" outcome by a few
  seconds.
- No "reconnecting…" indicator was added for the gap between an abnormal
  close and either a successful reconnect or giving up — the existing
  mid-match stall toast (`main.js`'s `MID_MATCH_STALL_ESCALATE_S` path) will
  eventually cover a long gap, but a short one currently passes silently.
  Left as a possible follow-up, not added here, to keep this change to what
  the log evidence actually supports.
