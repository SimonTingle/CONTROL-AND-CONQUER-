# Author-built vehicles in online matches

## The ask

Build a vehicle in the editor, name it whatever you like, set its attributes,
and have it work in an online match and be buildable by AI opponents. Plus a
design question: should vehicles come from the backend from now on?

## Half of that question is "no"

Split it, because the two halves have opposite answers.

**The built-in five stay in the bundle.** They are version-locked to code that
reads them — `harvesterAI` reads `capacity`/`fillRate`/`unloadRate`,
`base-station` carries a `deploy` block, `vehicleFactory` reads `shape.*` — so
serving them from Postgres decouples data from the code that has to agree with
it. They are also already byte-identical on every peer for free, which is the
property the whole feature below is spent re-establishing for custom vehicles.
Moving them to the DB would create that problem where none existed and put a
network round-trip in the boot path, which would additionally break the
`itch.io/` build, whose stated contract is that an empty `VITE_API_URL` still
leaves sandbox and AI matches playable.

**Custom vehicles do come from the backend** — but pinned into a match, not
fetched live. Detail below.

## What was already there

More than expected. Custom vehicles were *already* persisted server-side:
`saves` rows with `mode='vehicle-def'` and payload `{ draft, def }`. Nothing
about storage needed inventing. Three things blocked them from online play, and
`docs/plans/vehicle-builder.md` had already named the shape of the fix
("needs the full def shipped in the match handshake and a `PROTOCOL_VERSION`
bump").

The gate itself was one allowlist in `customCatalog.js`, deliberately
fail-closed, and the reason it existed is unchanged by any of this: only
`defId` **strings** cross the wire. `snapshot.js` serialises `defId`, the far
end resolves it against its own catalog, and `if (!def) continue` skips what it
cannot resolve — no error. One player has a tank, the other has empty ground,
and `stateHash.js` cannot tell, because it hashes instance ids and quantised
positions and never defs.

## Three blockers, three fixes

### 1. Ids collided across accounts

`customIdFor` slugged the name: `My Tank` → `custom:my-tank`. Two accounts with
*entirely different* vehicles both called "My Tank" therefore produced **the
same id for different defs**. Nothing caught it — that is precisely the silent
divergence class the last three rounds of multiplayer work were spent removing,
re-introduced by the naming scheme.

Ids are now content-addressed: `custom:` + 64 bits of FNV-1a over a canonical
(recursively key-sorted) serialisation of the def with `id`, `name`,
`description` and the runtime-only keys stripped. So:

- Two different vehicles can never share an id.
- Renaming does not change identity, and two authors who build the same thing
  under different names converge on one id rather than colliding.
- **The name becomes free text**, which is what actually delivers "name it
  whatever I want" safely — including two players choosing the same name.

`fnv1a` was extracted from `stateHash.js` rather than a second hash introduced;
the default seed is unchanged so lockstep hashes are byte-identical across the
refactor. `crypto.subtle` was rejected outright: it is async, and both callers
are synchronous paths.

The consequence, stated plainly: **the id is now derived data, so anything that
edits a def must re-derive it.** The editor does this in `onEdit`, which every
widget already funnels through. `validateDef` rejects a def whose id does not
match its own contents — an unchecked claim about content is worth nothing —
and `loadCustomDefs` re-derives on read so vehicles saved by the older
slug-based build migrate silently rather than being quarantined as broken.

### 2. Nothing carried the def

`welcome` was already the only per-match setup frame (it carries `seed`,
roster, timing), so the def set rides there. `PROTOCOL_VERSION` 1 → 2 in both
`src/net/matchClient.js` and `server/src/ws/match.js`: a v1 client would ignore
the array and resolve none of those ids, which is exactly the failure the
version check exists to prevent, so this is not an additive field that can ride
along unversioned.

**The match owns the vehicle set, snapshotted by value at creation.** Not a
live per-client fetch — that races. You join at T, I join at T+2s after the
host edits a vehicle, and our catalogs differ. Pinning by value also means
editing a vehicle afterwards cannot reach into a match already playing it.
Stored as `matches.custom_defs jsonb` (migration `006`) — a column rather than
a join table because it is written once, read as one blob, and never queried by
element.

Distribution model is **host's loadout**: the host's finished vehicles become
the match's vehicle set, read server-side from their own saves rather than
accepted from the request body. The client that authored a def is the one party
with a motive to skip the bounds check, so it does not get to assert what the
match will play.

### 3. There was no trust boundary

The server stored defs as `z.object({}).passthrough()`, and `validateDef` had
**no upper bound on anything** — `speed: 1e6`, `turret.damage: 1e9`,
`fireInterval: 0` all validated cleanly. Harmless while a def never left the
machine that wrote it. Not harmless once one arrives from another player: in
lockstep it is not even cheating, since every peer simulates it identically —
it just ruins the match for all of them.

The ranges already existed in `BUILDER_GROUPS`, as HTML attributes on a slider
and nothing more. `deriveBounds()` turns them into a table, and they are now
enforced. **No number was invented** — the editor's own limits simply became
binding.

The two sides check different things, on purpose:

- **Client** — structural safety: will `buildVehicleMesh` survive this def, do
  the axle arrays agree, is the lights block present. Needs `catalog.js` and
  `structures.js`. Protects the machine doing the rendering.
- **Server** — stat bounds. The only check a client cannot be trusted with.

`server/Dockerfile` does `COPY src ./src`, so the API image contains only
`server/src` and cannot import `src/builder/builderSchema.js`. The table is
therefore **generated and committed** (`npm run sync:bounds` →
`server/src/vehicles/vehicleBounds.js`), with a test that fails if the copy
drifts. Editing a slider range without regenerating is a test failure rather
than a bound that is shown in the editor and silently unenforced on the server.

## Two bugs found on the way

**A validator stricter than the engine.** Bounds-checking every path
unconditionally rejected `base-station` and `crystal-harvester`, which ship with
`dims.turretRadius: 0` and friends because they have no turret to size. Both
render perfectly. Turret and track dimensions are now skipped when the matching
shape flag is off — the same trap `vehicleDraft.js`'s axle rules already
existed to avoid, walked into again from a new direction. Caught by a test that
forks *every* built-in, not just the first one.

**The economy role was a trap.** The Production panel offers "Harvester
Facility" and the "Economy" role, but `blankDef` sets no
`capacity`/`fillRate`/`unloadRate` and the editor cannot author them.
`aiCommander._tryBuildUnit('economy', cap)` selects by tag, so it would buy
that vehicle as part of its economy and the vehicle could then never harvest
anything. Now refused in `validateDef`, which is the smaller fix and honest
about what the editor actually supports; exposing the three fields is the
larger alternative and was not done.

## The AI needed nothing

`_tryBuildUnit` selects by tag, `producedUnitIds` resolves `producedBy`
generically, and army recruitment filters on `tags.includes('combat')`. All of
it is id-agnostic already, so a match-supplied vehicle is buildable by an AI
opponent for the same reason a local one was in `multiplayer-ai`.

## Verification

- **`npm test`: 139/139**, dependency-free. New coverage across
  `tests/vehicle-def.test.mjs` (content addressing, bounds, the dormant-path
  gate, the economy refusal), `tests/custom-vehicle-catalog.test.mjs` (the
  online path uses match defs and **ignores local ones**, in both directions of
  the allowlist), `tests/server-vehicle-bounds.test.mjs`, and
  `tests/vehicle-bounds-sync.test.mjs` (drift).
- **Negative controls, each reverted and confirmed to fail for a behavioural
  reason, then restored** — seven of them: name-slug ids restored (collision
  test fails), bounds check removed, dormant-path gate removed (forking a
  turretless built-in fails), economy refusal removed, online path merging
  local defs instead of ignoring them (the desync — fails the two tests that
  exist to catch exactly it), server bounds check removed, vendored bounds
  hand-edited to drift.
- **`tests/e2e/custom-vehicle-match.mjs` (new, needs Postgres + the API):
  8/8.** Two real accounts, three saved vehicles, a real lobby and two real
  websockets. Confirms the server pins only the finished in-bounds vehicle,
  refuses the `speed: 999999` one *with its reason*, treats a draft as
  unfinished rather than an error, that both peers negotiate v2, that the
  joiner who authored nothing receives the host's vehicle — and, the assertion
  the whole feature rests on, that **both peers receive byte-identical vehicle
  sets**.
- Migration `006` applied cleanly against a real Postgres 16; `custom_defs`
  confirmed present and populated with one content-addressed def.
- A v1 client is refused with `protocol_version_mismatch` (serverVersion 2,
  clientVersion 1), so the bump is load-bearing rather than cosmetic.
- `npx vite build` succeeds.

**Pre-existing failure, not caused by this change:**
`tests/e2e/two-client-match.mjs` reports 17/18, failing "a lone client is told
what it is waiting for". Confirmed by stashing this branch's changes entirely,
restarting the API on the clean tree, and re-running: **it fails identically
there.** A timing-sensitive assertion around the waiting reporter, unrelated to
anything here.

## Not done, and what it would cost

- **Nothing has been driven in a real browser.** The transport, the filters and
  the byte-identical guarantee are proven at the wire level; an actual match
  played with a custom vehicle on two clients is not. Given the AI path is
  id-agnostic this is expected to work, but expected is not verified.
- **Simulation parity with a custom vehicle is untested.** The e2e proves both
  peers *receive* the same def. That they then *simulate* it identically rests
  on the same determinism arguments as every built-in vehicle, and on
  `stateHash` catching it if not.
- **Ids of existing saved vehicles change.** They are re-derived on load, so
  the editor and picker are fine, but a single-player world save referencing an
  old `custom:<slug>` will drop that unit on restore — failing the same safe
  way it already does. Acceptable pre-1.0; noted rather than migrated.
- **Only the host's vehicles reach a match.** A joiner's own vehicles are
  ignored online, deliberately (chosen over a global public pool: the backend
  has no roles, no reports and no soft-delete, so a shared pool has no
  moderation story at all, and vehicle names would become the first user text
  ever shown to another user — with no HTML escaping anywhere in the codebase).
- **No rate limit on `/saves`**, which is pre-existing but now matters more,
  since saves feed a match. `MAX_MATCH_DEFS = 16` caps what one host can push
  into a `welcome` frame, against the relay's 64 KiB message limit.
