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
| [online-multiplayer-lighting-desync.md](online-multiplayer-lighting-desync.md) | Vehicle/building lighting looked different between online players. Traced every "normal play" lighting path and found it already tick-deterministic; the real gap was two debug-only headlight toggles writing to local-only state, unlike their day/night siblings which were already locked during online play — locked them the same way. |
| [online-multiplayer-mutual-stall.md](online-multiplayer-mutual-stall.md) | In progress: both clients STALLED at once on a two-tab-one-machine test, after a genuine earlier `AGREED` — rules out the three fixes above and a per-process room split, leading hypothesis is `requestAnimationFrame` throttling on a backgrounded tab starving `LockstepSession`. Added diagnostic logging (previously none existed); root cause not yet confirmed from a live repro. |
| [portal-landing-button-row.md](portal-landing-button-row.md) | The landing screen's unused background photo and its five-button row (sign-in plus the three modes plus a God-Mode button gated on one account's email). |
