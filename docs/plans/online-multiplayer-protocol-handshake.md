# Online multiplayer, round three: a build-version handshake

## Note: reconciled with a concurrent pass at the same fix

A separate session landed a first attempt at this same change on this branch
first (`a9bd939`, "Add protocol version handshake..."), superseded by this
version rather than left alongside it. Its approach was one-directional and
had a real bug worth recording, since the same shape of mistake is easy to
repeat: it added `PROTOCOL_VERSION` to the `welcome` frame and checked it in
`main.js` **after** `client.connect()` resolved, with no server-side check at
all — so an old *client* connecting to a new server was never caught (only
the reverse), which fails requirement 2 below outright. Worse, the mismatch
branch called `endOnlineMatch(...)`, which opens with `if (!match) return;` —
and at that point in `startOnlineMatch`, the module-level `match` variable is
still `null` (it isn't assigned until much later in the same function). The
guard fired, `endOnlineMatch` silently returned having closed nothing and
shown no toast, and `startOnlineMatch` returned `undefined` rather than
throwing — so the caller's `.catch()` never ran either. The net effect was a
protocol mismatch that produced *no visible symptom at all*: not the
undocumented desync this feature exists to replace with something better, but
a strictly worse silent no-op. This version's client-side check lives inside
`MatchClient.connect()` itself, rejecting the promise before it can resolve,
which is what the existing `lobbyScreen.onStart().catch(...)` was already
built to handle — no new failure path to get subtly wrong.

## Context

The two previous rounds (`online-multiplayer-desync.md`,
`online-multiplayer-quorum-and-rejoin.md`) both changed the shape of what
crosses the wire between `server/src/ws/match.js` and
`src/net/matchClient.js` — `Intent.command`'s field set, how `resumeAt` sends
its primed delay window, the `waiting` and `resyncNeeded` frames — without
either side ever checking that the peer it just connected to agrees on any of
it. Nothing was broken *by* that; both changes shipped as coordinated
frontend+backend deploys. But the two apps are deployed separately (see
`CLAUDE.md`: "Two CapRover apps from one repo"), so a window where one has
redeployed and the other has not is a real, if usually brief, possibility —
and there was no code path that would have told either player what was wrong
if it happened. The likely failure mode is the same class of bug both
previous rounds fixed: two clients trusting frames whose shape or meaning
they disagree about, producing wrong behaviour with no diagnostic beyond "the
world doesn't match."

`main.js`'s `startOnlineMatch` already has one ad hoc case of this — checking
`welcome.expectedPlayers === undefined` to detect a server old enough to
predate the lockstep start barrier. That check works but only covers one
specific field from one specific past change, and only in one direction
(client noticing an old server). Nothing covers a server noticing an old
client, or a case that isn't "this field happens to be missing."

## Decision: a hardcoded integer, not a derived one

Two options were available for what "the protocol version" actually is:

- **Derive it** from something that already exists — `package.json`'s
  `version`, or a hash of the wire-format files.
- **Hardcode a small integer**, bumped by hand whenever a wire-affecting
  change is made, the same way `TICKS_PER_TURN` and `INPUT_DELAY_TURNS` are
  plain constants rather than computed.

Hardcoding won. `package.json`'s version tracks the *app*, not the *wire
format* — most releases (UI changes, new vehicle types, balance tweaks) don't
touch the protocol at all, and tying the check to app version would produce
false-positive rejections on every one of them, training whoever deploys this
to expect (and eventually ignore) spurious mismatches. A content hash would
be precise but silent about *why* two versions differ, and — because the
client and server live in genuinely separate packages with no shared
module — hashing would need its own build step to keep both sides looking at
the same set of files, which is more machinery than the problem justifies. A
hand-bumped integer costs one line in a comment reminding whoever changes the
wire format to bump it (see `PROTOCOL_VERSION`'s docstring in both files) and
is exactly as precise as that reminder is honoured — the same trust already
placed in `TICKS_PER_TURN` matching between the two files, which is not
generated either.

## Design: checked in both directions, neither trusting the other first

The two files can't share a module (separate deployables — see the layout
table in `CLAUDE.md`), so each defines its own `PROTOCOL_VERSION` constant.
Two independent checks make sure neither an old client nor an old server
can slip past unnoticed:

1. **Client → server, at connect time.** `matchClient.js`'s `socketUrl`
   appends `?protocolVersion=N` to the WebSocket URL. `match.js`'s
   `handleMatchSocket` reads it via `checkProtocolVersion` — the very first
   thing it does, ahead of even authentication, so a build mismatch is never
   confused with (or masked by) a credentials problem, and a mismatched
   client never gets far enough to receive a `welcome` it might misread. A
   missing or non-numeric value (an old client, built before this handshake
   existed, which never sends the param at all) is rejected exactly like a
   numeric one that disagrees — no default-to-compatible fallback.

2. **Server → client, in `welcome`.** The server echoes its own
   `PROTOCOL_VERSION` in the `welcome` frame. `matchClient.js` checks it
   against its own constant before resolving `connect()`'s promise. This is
   what catches the direction the query-param check can't: an *old* server,
   one that predates `checkProtocolVersion` entirely, never rejects the query
   param (it doesn't know to look for one) and proceeds straight to a
   `welcome` — one with no `protocolVersion` field at all, since that field
   didn't exist yet either. `undefined !== 1` fails the client's check
   exactly like a numeric disagreement would.

Both rejections produce a `{ t: 'error', error: 'protocol_version_mismatch',
serverVersion, clientVersion }` frame (server-side) or a rejected `connect()`
promise carrying a message naming both versions (either direction, from the
client's perspective) — never a silent proceed. `main.js`'s existing
`lobbyScreen.onStart` handler already `.catch()`es a failed `connect()` and
shows `err.message` in a toast, so no change was needed there: the clear
message this round adds is exactly what that existing plumbing needed to
have something worth showing.

## What this does not cover

- **A version bump that isn't made.** If a future wire-format change ships
  without bumping `PROTOCOL_VERSION` in both files, this catches nothing —
  the check is only as good as the discipline behind it, same as
  `TICKS_PER_TURN` today. Noted in both constants' docstrings as the thing to
  remember, not solved structurally.
- **Mid-match mismatch.** The check only runs at connect time. A version that
  changes correctness of frames already in flight for a match that started
  before either side redeployed is out of scope — matches are short-lived and
  in-memory (`rooms` is wiped on server restart per the file header), so a
  server redeploy already ends every in-flight match; this closes the gap at
  the boundary that actually matters, which is a fresh connection.
- **Downgrade / rollback.** A rollback to an older server after a newer one
  has run behaves like any other mismatch — rejected, not specially
  detected or messaged.

## Verification

- `tests/match-room.test.mjs`: `checkProtocolVersion` unit tests (accepts an
  exact match including the query-param's string form; rejects a numeric
  mismatch and reports the client's declared version; rejects a missing/
  non-numeric value exactly like a mismatch, not as compatible-by-default).
  Negative control: temporarily made `checkProtocolVersion` always return
  `{ ok: true }` (the pre-fix fail-open) — the two rejection tests failed for
  the right reason (a behavioural assertion on `.ok` and `.clientVersion`,
  not a missing import), then the function was restored.
- `tests/match-client-protocol.test.mjs` (new): cross-checks that the
  client's and server's `PROTOCOL_VERSION` constants agree (the one thing
  nothing else in the repo would catch if they drifted, since the two files
  can't import each other); checks `socketUrl` appends the query param;
  checks `versionMismatchMessage`'s wording covers both the numeric-mismatch
  and the old-unversioned-server cases.
- `tests/e2e/two-client-match.mjs`: extended with two cases run against the
  real relay before any user or match exists — a peer declaring a different
  numeric version, and a peer that omits the parameter entirely — both
  asserting the exact `protocol_version_mismatch` frame and that both
  versions are named in it. Also updated `connectClient`'s socket URL to
  send the real client version, since the server's new connect-time check
  would otherwise reject every client this harness opens. Ran end to end
  against a real Postgres instance and the real API server
  (`node tests/e2e/two-client-match.mjs`, 18/18 passed) — not just described;
  the runnable command in the file's own header was executed. Negative
  control: reverted the server-side check to `{ ok: true }`, restarted the
  server, and confirmed the same two cases fail for the right reason (the
  request falls through to `authentication_required` instead of being
  rejected for its version) — then restored the real check and reran to
  confirm 18/18 again.
- `npm test`: 29/29, including the two files above (server deps were not
  installed in this session's container by default; installed via
  `cd server && npm install` to actually run them rather than assume).

Not verified: a live two-CapRover-app deploy where the frontend and API are
genuinely on different builds at the same moment — the e2e test's two
processes are both running this change's code, so what's exercised is the
mismatch *codepath*, using synthetic version numbers, not an actual
old-build artifact.
