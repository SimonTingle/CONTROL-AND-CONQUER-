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
