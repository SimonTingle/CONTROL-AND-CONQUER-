# The AI's strategy, measured against C&C and Homeworld

An audit prompted by a 41-minute, four-AI-team diagnostic
(`simTick: 147610`, `mode: multiplayer-ai`) in which every AI opponent was
economically and militarily inert. The question asked was how this AI's
strategy correlates with Command & Conquer and Homeworld. The short answer is
that it is architecturally a C&C AI with two Homeworld ideas grafted on, and
that almost none of the C&C half was reachable code.

## What the diagnostic showed

| | |
|---|---|
| AI rosters | 23 scout-buggies, **1** gun-platform, **0** tanks across four teams |
| Commanded kills by any AI | **0** — the 3 recorded came from turrets auto-engaging |
| `weaponTier` | **0** for all five teams after 41 minutes |
| Repair bays | 14 queued against 2 repairing; one scout holding **23,753 ticks (6.6 min)** |
| Scout health | 8 sitting at exactly 15.0 — the 15% `floorFraction` terrain-grind floor |
| Economy spread | Amber 4,160 credits earned against Jade's 28,821 |
| `reachedRelocateThreshold` | false on every team |

## The mechanism: scouts were army for spending and not for fighting

Three places answered "is a scout part of the army?" independently, and two of
them answered differently:

- `catalog.js` — `scout-buggy` is tagged `['recon', 'combat']`.
- `aiCommander._tryBuildUnit` — counted every combat-tagged unit against
  `combatCap`, so scouts **spent** the army budget.
- `aiCommander._manageArmy` — filtered `v.def.id !== 'scout-buggy'`, so scouts
  could never **be** the army.

Once `combatCap` scouts existed (3 normal / 5 hard / 7 expert), the combat
branch returned false forever and `_manageArmy` early-returned on
`army.length === 0`. `_updatePosture`, `_pickArmyTarget`,
`ARMY_TARGET_INTERVAL` and `_advanceUnit` all sit downstream of that return, so
the whole strategic layer was unreachable for the rest of the match.

What made it certain rather than merely possible: build candidates are filtered
to whatever is *enabled this instant* (`_tryBuildUnit`'s
`cmd?.enabledResult !== true`), and `enabled()` tests credits and nothing else
(`commands.js`). At 350–649 credits a scout is the only affordable combat
candidate, so it wins on every tick the team sits in that band — despite
`valuePerCost` ranking it 0.38 against gun-platform's 9.7. The AI bought the
cheap thing the moment it could and permanently poisoned its own budget doing
so.

The previous pass knew about the tag overlap and priced it as "6 tanks at
expert, not 7". The diagnostic shows the real price was every tank, always.

## Command & Conquer: the shape is right, the escalation is missing

Faithful analogues that already exist:

- Refinery / factory / repair-bay economy with harvester round trips.
- Attack waves gated on a unit count (`attackAt`, 2–3).
- Perimeter defense walked out by an engineer to a 55–140 unit ring
  (`_preferredDefenseCommand`), capped by `defenseCap`.
- Scouting that genuinely gates aggression — `_scoutedEnemyStrength` means the
  commander will not commit to an attack on a base it has never seen, which is
  a stronger fair-play stance than most C&C AIs of the era took.

What is absent is C&C's defining rhythm — **waves that get progressively
nastier**:

- Structure build order is cheapest-first off the catalog's own tags
  (`BUILDABLE_DEFS`, sorted by cost), not a tech tree. There is no notion of
  tier-gating a unit behind a building.
- `weaponTier` has no AI writer anywhere. `TEAM_WEAPON_UPGRADE_COMMAND` is
  attached solely to the armed factory's radial menu, so it is a human-only
  affordance. AI capability is identical at minute 1 and minute 41 — which is
  exactly what the diagnostic's uniform `weaponTier: 0` records.
- Difficulty scales four numbers (`buildInterval`, `combatCap`, `attackAt`,
  `defenseCap`) and no behaviours. A harder AI acts more often with a bigger
  cap; it never acts *differently*.

So a C&C player's expectation — probe, then a real push, then a heavier one
with better tech — cannot be met by this AI even with the army bug fixed. The
push exists. The escalation does not.

## Homeworld / Deserts of Kharak: two good ideas, one of them half-built

Genuine analogues:

- **The mobile base.** `base-station` deploys and can relocate, which is a real
  Deserts of Kharak carrier idea rather than a C&C construction yard. The AI
  has a relocate threshold and never reached it in 41 minutes
  (`reachedRelocateThreshold: false` on every team), so the idea is present and
  unexercised.
- **Resourcing as the strategic centre.** Homeworld's whole shape is "protect
  the collectors, because losing them is losing." This codebase already agrees
  economically: it tracks `deadHarvesterEarnings` per team, and the diagnostic
  records two dead harvesters that had earned 2,240 and 5,440 credits. The
  game already knows a lost harvester is a lost income stream, not a lost unit.

The gap is Homeworld's **collector doctrine**, which has two halves:

1. Collectors break off and retreat when fired on. **Present** — `harvesterAI`
   has a `FLEEING` state driven by `threatUntil`/`threatFrom`, which
   `combatController` stamps on any target at *fire* time.
2. Collectors do not return to a contested patch while it is still hot.
   **Absent.** Nothing remembered where the shooting had been, so a harvester
   fled, the six-second threat memory lapsed, and it drove straight back to the
   same field — which is how harvesters ended up dying at the same crystal
   field repeatedly.

That second half is what `docs/plans/harvester-danger-zones.md` implements, and
it is the single change here most directly traceable to the reference games.

## What was fixed, and what was deliberately left

Fixed on this branch (see `harvester-danger-zones.md` for the detail and the
full measurements):

1. `isArmyUnit` — one predicate now answers the scout question for the budget,
   the candidate scan and `_manageArmy` alike; scouts get their own `reconCap`.
2. Team-shared danger zones, so harvesters avoid ground they were shot on.
3. A repair-queue depth cap, so a bay stops being a car park.

Re-running a 41-minute four-AI match to the same tick (147,600 against the
diagnostic's 147,610): scouts 23 → 8, gun platforms 1 → 10, AI teams fielding
an army 0 → 4 of 4, commanded kills 0 → 2. The strategic layer described above
now actually executes.

Done since, on a follow-up branch — see
`docs/plans/ai-weapon-tier-escalation.md`:

- **Weapon-tier upgrades for the AI**, which this document called the single
  largest remaining gap. It turned out to be a missing *caller* rather than a
  missing system: `TEAM_WEAPON_UPGRADE_COMMAND` already existed and was wired
  only to the player's radial menu. The commander now buys tiers, gated by a
  new `maxWeaponTier` per difficulty — the first entry in `DIFFICULTY_ECONOMY`
  that changes behaviour rather than a magnitude.

Still deliberately not attempted, in rough order of value:

- **Structure upgrades.** The weapon tier is bought; per-building
  `upgradeLevel` (`UPGRADE_COMMAND`) is still human-only.
- **Tech-gated build order.** Cheapest-first is a placeholder, not a strategy.
  Escalating *capability* is now covered; escalating *unit choice* is not, and
  that is the other half of C&C's tech rhythm.
- **Base relocation.** Implemented, never triggered — worth finding out whether
  the threshold is wrong or the situation never arises.
- **Economy escort.** Homeworld's other half: nothing assigns a combat unit to
  cover a harvester, so danger zones currently mean "go elsewhere" where a
  stronger AI would mean "go back, with an escort".
- **Per-difficulty behaviour** rather than per-difficulty numbers.
