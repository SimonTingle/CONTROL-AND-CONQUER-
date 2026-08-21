# Plans

One document per substantial change, written **before** the code and committed
**with** it.

## Why these are in the repository

Most of the reasoning behind a change never reaches the diff. The diff shows a
grace period being deleted; it does not show that two players' save files were
read tick by tick to work out that `11118 = 1853 × 6` meant one client had
stalled on a turn boundary while `14084 = 2347 × 6 + 2` meant the other was
free-running. That reasoning is the expensive part, it is what makes the next
bug in the same area cheap to find, and it evaporates the moment the session
that produced it ends.

Commit messages carry the *what*. `bug-fixed.md` carries the confirmed
*outcome*. These carry the *investigation* — the evidence, the reconstruction,
the alternatives weighed and rejected, and the things found along the way that
were deliberately not fixed.

## Conventions

- **One file per change**, named for the problem rather than the fix:
  `online-multiplayer-desync.md`, not `add-start-barrier.md`. The problem is
  what somebody will search for later.
- **Kebab-case**, matching `docs/performance-optimization-plan.md`.
- **Committed on the same branch as the code it describes**, so the plan and the
  diff arrive in one reviewable unit and stay together in the history.
- **Left alone once merged.** A plan is a record of what was believed and
  decided at a point in time. If a later change proves part of it wrong, that
  belongs in the *new* plan, which can link back — rewriting history to look
  correct in hindsight destroys the only thing these are for.

## What belongs in one

The section that matters most is the evidence. A plan that says "fix the
multiplayer desync" is worth nothing; one that says "here are the two save
files, here is the arithmetic that identifies which failure mode each client
hit, and here is why that rules out the other three candidate causes" is worth
keeping.

Findings that were investigated and *not* fixed matter just as much — they are
the difference between "nobody noticed" and "noticed, judged lower priority,
here is the reasoning". Record them with enough detail to act on later.

## Index

| Plan | Change |
|---|---|
| [online-multiplayer-desync.md](online-multiplayer-desync.md) | Two clients ran independent simulations of the same map; three fail-open paths in the lockstep start barrier, late-join and disconnect handling. |
| [online-multiplayer-quorum-and-rejoin.md](online-multiplayer-quorum-and-rejoin.md) | Follow-up: the *running* match had the identical fail-open the previous fix closed only at *start* — a dropped peer let the survivor free-run, rejoining never actually worked, and a stall got the player ejected and re-doubled the world on return. |
| [online-multiplayer-protocol-handshake.md](online-multiplayer-protocol-handshake.md) | Follow-up: neither of the above wire-format changes was guarded by any check that two peers agree on the protocol at all — added a hardcoded, hand-bumped `PROTOCOL_VERSION` checked in both directions at connect time. |
| [ai-base-spawn-degenerate-fallback.md](ai-base-spawn-degenerate-fallback.md) | A team's degenerate "no dry land on this exact bearing" fallback returned the unconditional map centre, which the nudge-selection loop one level up could not distinguish from a genuine coastal point — scoped the fallback to sweep within the team's own slice for dry ground before giving up. |
| [vehicle-builder.md](vehicle-builder.md) | A parametric vehicle editor behind God Mode, reusing the game's own mesh builder. The design problem was not the UI but keeping author-built vehicles out of lockstep matches, where only `defId` strings cross the wire — solved with a fail-closed allowlist of offline modes. |
| [minimap.md](minimap.md) | A bottom-right minimap over the fog's own CPU grid. Two bugs that drew wrong rather than erroring: team colours are numbers and a numeric canvas `fillStyle` is silently ignored, and there is no honest camera footprint to draw when the view sees the horizon. Also carries the base-defense roadmap. |
| [mobile-ui-scaling.md](mobile-ui-scaling.md) | The vanishing hamburger menu was a real bug: nothing restricted native pinch-zoom, and touch-action:none only covered the canvas, so a pinch near a toggle button reached the browser's page zoom and shifted every fixed-position element. Fixed both drawers being open simultaneously and unreadable on a narrow phone along the way, found only by screenshotting the sizing fix. |
| [base-defenses.md](base-defenses.md) | A gun turret and a sensor tower, deployed from a vehicle because `canPlaceAt` confines structures to a radius-40 base pad holding two or three buildings — so nothing placed the normal way could ever defend a perimeter. Extracted the turret rig so a vehicle and an emplacement cannot drift apart. |
| [custom-vehicle-production.md](custom-vehicle-production.md) | Making an author-built vehicle buildable from a factory. `producedBy` existed on every def and was read nowhere — the live link was the structure's `produces` array, generated into commands at module import, which a player can never reach. Made the field load-bearing. |
| [tracked-vehicles.md](tracked-vehicles.md) | Tank tracks with suspension. The belt geometry was the easy half — a track has no steered axle, so `steeringWheelbase` returns Infinity and every consumer concluded a tank could only drive straight; needed a pivot-steer model alongside the bicycle one. |
| [online-multiplayer-lighting-desync.md](online-multiplayer-lighting-desync.md) | Vehicle/building lighting looked different between online players. Traced every "normal play" lighting path and found it already tick-deterministic; the real gap was two debug-only headlight toggles writing to local-only state, unlike their day/night siblings which were already locked during online play — locked them the same way. |
| [online-multiplayer-mutual-stall.md](online-multiplayer-mutual-stall.md) | In progress: both clients STALLED at once on a two-tab-one-machine test, after a genuine earlier `AGREED` — rules out the three fixes above and a per-process room split, leading hypothesis is `requestAnimationFrame` throttling on a backgrounded tab starving `LockstepSession`. Added diagnostic logging (previously none existed); root cause not yet confirmed from a live repro. |
| [portal-landing-button-row.md](portal-landing-button-row.md) | The landing screen's unused background photo and its five-button row (sign-in plus the three modes plus a God-Mode button gated on one account's email). |
| [ai-defense-and-sell.md](ai-defense-and-sell.md) | Follow-up to `base-defenses.md`: the AI now builds a field engineer and drives it out to deploy a defense (with a distance floor a human player doesn't need but a freshly-spawned AI engineer does), and both defenses can be sold back for a health-scaled refund. |
| [custom-vehicles-online.md](custom-vehicles-online.md) | Author-built vehicles in online matches and in AI hands. Ids were name slugs, so two accounts' different vehicles could share one — content-addressed them instead, which also makes the name free text. The match now owns a vehicle set pinned from the host's loadout and relayed in `welcome` (protocol v2), and the editor's slider ranges became binding on both sides rather than being HTML attributes nothing enforced. |
| [harvester-collision-avoidance-study.md](harvester-collision-avoidance-study.md) | An investigation, not a fix: four harvesters and one depot, run for ten simulated minutes. Two ordinary collisions in the approach corridor left **all four** permanently frozen for 83% of the run — traced to `_onAbandoned`'s `TO_BASE` branch, which never bans its destination and so re-ran an identical five-angle detour sweep 256 times without moving. |
| [facility-clearance-control.md](facility-clearance-control.md) | Follow-up to the study: harvesters and repair-bay traffic now request clearance before entering a facility's approach corridor. The game already had this built twice — `harvesterAI` and `repairController` each carried their own claim + allocator + sweep, fixing the same bugs out of step — so this unifies them behind one controller whose ledger is *derived* from the vehicles each tick rather than stored on structures. The first version deadlocked in a browser run the unit tests could not see. |
| [vehicle-collision-avoidance.md](vehicle-collision-avoidance.md) | Vehicles clumped instead of flowing around each other — the existing avoidance check only ever meant "stop." Kept the cone-detection trigger, replaced the stop with a lateral steering-offset swerve; found and fixed a case where the swerve itself could abandon a perfectly good order over a transient rock outcrop only the nudge, not the real target direction, ever faced. |
