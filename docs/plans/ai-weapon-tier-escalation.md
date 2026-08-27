# The AI can escalate now

`docs/plans/ai-strategy-genre-audit.md` named AI weapon-tier upgrades as the
largest remaining gap against Command & Conquer: C&C's defining rhythm is waves
that get progressively nastier, and this AI's capability was flat from minute 1
to minute 41. The uploaded diagnostic recorded `weaponTier: 0` on all five
teams after 41 simulated minutes.

## The diagnosis: a missing caller, not a missing system

`TEAM_WEAPON_UPGRADE_COMMAND` (`src/vehicles/commands.js`) is the only writer of
`team.weaponTier`, and it is attached solely to the armed factory's radial
menu. `aiCommander.js` never contained the string `upgrade` — it used
`commandsFor` for `deploy` and `build-<unitId>` and nothing else. The upgrade
was a human-only affordance by omission.

Two things made this cheap to close:

- **The payoff was already wired, and is wider than "fire rate".** `weaponTier`
  drives `combatController.js`'s fire interval, `craters.js`'s
  `tierBoost = 1 + 0.12 * weaponTier` (so shells dig visibly bigger holes) and
  `main.js`'s impact effects. Nothing new to build on the payoff side.
- **No determinism work.** `weaponTier` was already serialized
  (`snapshot.js`) and already hashed (`stateHash.js`). Unlike the danger zones
  on the parent branch, this needed no snapshot or hash changes and therefore
  **no `PROTOCOL_VERSION` bump of its own** — the parent's 3 → 4 already covers
  the simulation change this rides on.

There was also a symptom pointing straight at it: the AI **hoards**. In the
parent branch's 41-minute verification, Jade finished holding **29,109** idle
credits having earned 42,070, and Crimson held 15,613. Capped at 3 gun
platforms and 2 harvesters, they had nothing left to buy. All three tiers
together cost 5,200.

## The design

`_tryUpgradeWeapons()` mirrors `_tryBuildUnit`'s shape: scan own idle
structures, `commandsFor(s, ctx)`, find `upgrade-weapons`, require
`enabledResult === true`, execute. The cost table, the max-tier check and the
spend stay in the command — the AI decides *whether it wants to*, which was the
entire gap, and fires the same command the player's radial menu does.

### Placement is the mechanism

```
economy → defense → combat → weapons upgrade → recon
```

Sitting **after** combat is the whole escalation mechanic, and it needs no
timer and no separate schedule. `_tryBuildUnit('combat', combatCap)` returns
false precisely when the army is at cap, so the chain reaches an upgrade
exactly when there is nothing better to buy. Lose a tank and the army drops
below cap, so the next tick rebuilds it instead: **replacement outranks
escalation for free**, which is the right priority and would have taken
explicit code to express any other way.

Ahead of recon because a fire-rate tier beats a second scout — and because it
is the treasury's only real sink.

### Difficulty gating

A new `maxWeaponTier` in `DIFFICULTY_ECONOMY`: **easy 0, normal 2, hard 3,
expert 3.**

This is the first entry in that table that changes what an AI *does* rather
than how much or how often. Every other knob scales a number, which is why the
genre audit describes a harder AI as "the same AI acting more often". A tier is
a real capability step.

easy stays at 0 deliberately. Combined with the parent branch's fix — which is
what made the commander field a full army at all — an easy opponent at tier 3
would be a very large jump from the passive AI that shipped before it: 1.9×
fire rate *and* bigger craters is not an easy match.

### The reserve

`UPGRADE_RESERVE` (600) is the cost of a crystal-harvester, the economy unit
this commander actually rebuilds. An upgrade bought with the last of the
treasury speeds up guns the team can no longer keep supplied, and a dead
harvester it cannot replace costs far more over the rest of a match than a
fire-rate step gains. Named as the number it protects, so a catalog price
change is visibly the thing to re-check.

## Verification

`npm test` — **371 pass, 0 fail** (8 new). `npm run build` passes.

**41-minute four-AI match**, `normal`, measured at tick 147,600 — the same
harness and the same moment as the parent branch's run, so the two are directly
comparable:

| team | weaponTier | earned | idle credits | kills |
|---|---|---|---|---|
| Crimson | **2** | 27,915 | 12,901 | 1 |
| Amber | 0 | 2,635 | 235 | 0 |
| Violet | **2** | 17,132 | 4,302 | 1 |
| Jade | **2** | 43,911 | 27,891 | 3 |

Three of four teams reached **exactly 2**, which is `normal`'s `maxWeaponTier`
— the gate holds under real conditions and not only in the unit test. Amber
stayed at 0 on 2,635 credits earned, which is the reserve and affordability
rules working rather than failing: it is the same economically starved team
that could not afford a gun platform on the parent branch either.

Total AI kills rose from 2 to 5 against the parent branch, though with one
run per configuration that is suggestive, not a measurement.

### The claim that did not survive the data

Both the plan for this change and an early draft of the code comment argued
that weapon tiers were "the treasury's only real sink" and would address the
AI's hoarding. **They do not, and the comment now says so.** Jade ended the
parent branch's run holding 29,109 idle credits and ended this one holding
27,891 — all three tiers together cost 5,200 against a 43,911 match income, so
the AI buys its allowance and goes straight back to accumulating. Escalation
is delivered; the hoarding is untouched, and a treasury that large needs a sink
that *scales* (reinforcement beyond a fixed cap, repairs, a second base) rather
than a one-off 5,200.

**Four negative controls**, each a surgical string replacement (never
`git checkout`), each confirmed to fail for its own reason then restored:

| Reverted | Tests that failed |
|---|---|
| the difficulty cap (used the catalog max) | 2 — normal overspends, easy upgrades |
| the credit reserve | 1 — buys with the last credits |
| easy's table value (0 → 3) | 1 — easy upgrades |
| the chain order (upgrade before combat) | 1 — escalates while the army is short |

**A redundant guard was found and removed by its own negative control.** The
first version opened with `if (maxTier <= 0) return false;`. Reverting it
changed no outcome, because `weaponTier >= maxTier` already refuses when
`maxTier` is 0 — the line could never decide anything. It is gone, and the
remaining check carries a comment saying why no separate easy case is needed.

**The chain-order test is worth calling out** because the first version of this
work had no test that could catch the ordering being wrong: the two methods
were tested in isolation, and the escalation mechanic *is* the order. The test
now drives `_manageEconomy` itself, with `terraform.padAt` stubbed to null so
`_tryBuildNext` declines and the unit-vs-upgrade half of the chain runs in
isolation.

## Not verified

- **Whether escalating waves are well tuned.** This makes the AI's capability
  grow over a match; it does not answer whether tier 2 at minute 20 feels fair.
  That is a question for a human playing against it, and it stacks on the
  parent branch's own untested change (attack waves executing at all for the
  first time).
- **Crater growth from higher tiers is untested here.** `craters.js` reads
  `weaponTier` and will now see non-zero values from AI teams for the first
  time. The arithmetic is covered by existing crater tests; that AI shells now
  reach it is inferred, not observed.
- easy/expert were exercised by unit test only — the 41-minute match run was on
  `normal`.
- **The repair queue got worse in this run, not better**, and it is not clear
  this change caused it: longest wait 462s here against the parent branch's
  308s, on a smaller queue (4 waiting, against 8). More tiers means more
  damage dealt means more repairs, so a longer queue at a bay whose *rate* is
  unchanged is a plausible knock-on — but with one run per configuration it is
  equally plausible as run-to-run variance. Either way it reinforces what the
  parent branch already recorded: `MAX_REPAIR_QUEUE` bounds admission, not
  repair rate, and the rate is what a 7-minute wait is actually about.

## Still deferred

Tech-gated build order, base relocation (implemented, never triggered) and
economy escort remain listed in the genre audit. This change makes waves
*escalate*; it does not make the AI choose *different units* over time, which
is the other half of C&C's tech rhythm and a larger piece of work.
