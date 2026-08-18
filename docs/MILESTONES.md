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
