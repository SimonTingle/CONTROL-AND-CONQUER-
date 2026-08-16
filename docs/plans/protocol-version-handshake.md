# Protocol version handshake

## Context

Every fix in the previous two rounds has touched shipped wire behavior: `Intent.command`'s shape, `resumeAt`'s send behavior, the new `waiting`/`resyncNeeded` message types. None of it is guarded by a version check in the `welcome` message, so two players on different builds during a deploy mid-transition will fail in some new, undocumented way.

The symptom would be a silent desync or a stall — not "your client is too old", just a game that stops working. The reason is narrow: the client has no way to know its understanding of the wire format matches the server's, so it applies bad interpretations to good frames, or ignores frames entirely, producing a divergence that looks like ordinary gameplay lag until both clients are ejected for desync or timeout.

## The fix

**A. Add protocol version constant to both server and client** (`server/src/ws/match.js`, `src/main.js`).

`PROTOCOL_VERSION = 1`, exported from the server. Both client and server define it; the server includes it in the `welcome` message.

**B. Client validates version before simulating** (`src/main.js`, `startOnlineMatch`).

Right after receiving `welcome`, check `welcome.protocolVersion === PROTOCOL_VERSION`. If it does not match, end the match with a clear message naming both versions and asking the player to refresh the page.

## Verification

**Unit tests** (`tests/match-room.test.mjs`):
- `PROTOCOL_VERSION` is defined and numeric on the server.

**Build verification**:
- `npm run build` passes.
- `npm test` passes with new test included.

**What is NOT tested here:**
- A real version mismatch during an e2e test. That would require mocking different protocol versions on each client, which would require invasive changes to the match setup for a single edge case. The logic itself is simple (a `!==` check) and the pathway is exercised on every connection, so the real check happens every time a match starts in production. A mismatch will immediately show up as the expected "version mismatch" message rather than a silent desync.

## Future work

If the wire format changes incompatibly — for instance, if `Intent.command` adds or removes a required field, or if `waiting` gains an additional payload field that must be handled — bump `PROTOCOL_VERSION` and the mismatch check will automatically block the incompatible pair. No changes to the check itself are needed; it scales to all future incompatibilities.
