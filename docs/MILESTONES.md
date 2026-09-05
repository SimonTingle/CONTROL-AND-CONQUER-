# Milestones

Major points in this project's life where a system went from "in progress"
to "works." Not a changelog — `git log` has that. This is the short list of
moments worth being able to find again.

## 2026-08-18 — Online multiplayer works

Three rounds of fixes: the original two-clients-two-private-worlds desync,
the running-match version of the same fail-open plus rejoin handling, and a
build-version handshake so a mid-deploy client/server mismatch fails loudly
instead of silently. Confirmed working in practice.

- [online-multiplayer-desync.md](plans/online-multiplayer-desync.md)
- [online-multiplayer-quorum-and-rejoin.md](plans/online-multiplayer-quorum-and-rejoin.md)
- [online-multiplayer-protocol-handshake.md](plans/online-multiplayer-protocol-handshake.md)

## 2026-09-04 — Two players finally see the same match (`v0.2.0`)

Every previous online-multiplayer round fixed the *connection* — two clients
reaching the same match, staying in lockstep turn by turn, surviving a
rejoin. This one fixed the *world*: two players in a real match could not
see or affect each other at all, while the state hash — the only
cross-client check the game had — reported agreement throughout, because it
hashed vehicle positions but never structure positions, and nothing checked
that two clients had even generated the same island from their shared seed.
Closed both gaps and bumped `PROTOCOL_VERSION` 4 → 5 so a stale deploy fails
the connection instead of silently disagreeing. **Confirmed by the user in
production** after redeploying the API service to version 5: "I can now see
both players/teams on the same map and interact."

Tagged `v0.2.0` at the commit that landed the fix (PR #124).

- [split-brain-invisible-to-the-hash.md](plans/split-brain-invisible-to-the-hash.md)
