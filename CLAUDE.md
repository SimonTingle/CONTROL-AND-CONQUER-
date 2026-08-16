# Working in this repository

Notes for anyone — human or AI — picking this up cold.

## Layout

| Path | What it is |
|---|---|
| `src/` | The game. Vite + three.js, no framework. |
| `src/core/` | Simulation spine: `simClock`, `snapshot`, `stateHash`, `world`, `team`. |
| `src/net/` | Lockstep multiplayer: `intents` (the wire format), `lockstep`, `matchClient`, `api`. |
| `src/vehicles/`, `src/structures/` | Simulation. `commands.js` is the radial-menu vocabulary. |
| `src/ui/` | Screens and HUD. No simulation state. |
| `server/` | Fastify API: accounts, cloud saves, and the match relay. Its own CapRover app. |
| `tests/` | `npm test` — dependency-free unit tests. `tests/e2e/` needs a database. |
| `docs/plans/` | One document per substantial change. See below. |
| `bug-fixed.md` | Confirmed-fixed bugs, with root cause and how it was verified. |

## Commit a plan with the code

Every substantial change gets a document in `docs/plans/`, committed on the same
branch as the code it describes. `docs/plans/README.md` has the conventions.

The reason is narrow and practical: the investigation behind a change is
expensive to produce, invisible in the diff, and gone the moment a session ends.
The multiplayer fix turned on reading two save files tick by tick and noticing
that one number was divisible by six and the other was not. None of that
survives in `-  const graceExpired = …`.

Record what was found and *not* fixed as carefully as what was.

## Three places to write things down, and the difference

- **Commit message** — what changed and why, for someone reading `git log`.
- **`docs/plans/`** — the investigation: evidence, reconstruction, alternatives
  rejected, findings deferred. Written before the code.
- **`bug-fixed.md`** — only bugs that are diagnosed, fixed **and verified**.
  Not a to-do list and not a changelog; if it is not confirmed, it does not go
  in.

## Verification

There was no test infrastructure here at all until recently, and commit messages
claimed suites that existed only in scratch directories. Do not do that.

- `npm test` must stay dependency-free — no database, no browser, no network. It
  covers rules that can be expressed over plain objects.
- **Write the negative control.** Revert the fix (`git stash`, or a surgical
  edit that restores just the old branch) and confirm the test fails, and fails
  for the *right reason* — a behavioural assertion, not a missing import. A test
  that has never failed has not been shown to test anything.
- `tests/e2e/` is for things only reachable with real infrastructure. The
  two-client match test is the only check in the repo that can observe a
  lockstep split-brain; `window.__determinismCheck` replays a single client
  against itself and is blind to it.
- Claim only what was actually run. "Not verified: X" is a perfectly good line
  in a commit message.

## Simulation rules, learned the hard way

- **The sim is deterministic and must stay that way.** Every client re-simulates
  everything from a shared seed and an ordered intent stream. No `Math.random`,
  no `Date.now`, no `performance.now` anywhere a simulated value can reach — use
  `src/core/simClock.js`. Render-only code may use whatever it likes.
- **Player actions are data.** Anything that changes the world goes through
  `src/net/intents.js` and is applied at a tick boundary — including in single
  player, so there is one path that is exercised constantly rather than a
  networked path that only runs in multiplayer. Writing sim state directly from
  a UI handler has silently desynced matches before.
- **Intent shapes are a wire format.** Peers on different builds currently have
  no way to detect the mismatch, so a positional change to an intent constructor
  breaks any client that has not refreshed. Prefer adding a named field.
- **Never cache a reference to another entity across ticks** — it can die.
  Re-resolve from the live `instances` arrays. `harvesterAI.js`'s header explains
  the reasoning; `aiCommander.js` follows it.

## Deployment

Two CapRover apps from one repo: the root `Dockerfile` (static nginx frontend)
and `server/Dockerfile` (API). Both deliberately omit `HEALTHCHECK` — CapRover
runs its own probe and a second one fights it into a restart loop. The API
terminates WebSockets, which requires "Websocket Support" enabled in its HTTP
settings; without it every match connection arrives as a plain GET and the route
answers 426.

`VITE_API_URL` is baked at **build** time, not read at runtime.
