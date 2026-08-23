# What the AI commander actually does

An investigation, not a fix: what is an enemy team capable of in Multiplayer
AI — economy, base building, army buildup, and above all, does it ever decide
*when* to attack, retreat a losing fight, or come back for a second try? No
code changed here; this is the answer, read directly out of
`src/vehicles/aiCommander.js` (781 lines, read in full) and its neighbours.

## The short answer

**Attack timing is a flat headcount, not a plan.** The instant a team's
`gun-platform` count reaches a difficulty-set threshold (`attackAt`, 2 or 3),
every idle armed unit is sent toward the nearest *scouted* hostile point,
every tick, forever. There is no comparison to the enemy's force size — the
AI has no code path that even looks at how big the other side's army is.

**There is no retreat.** Combat units have no health check, no flee state, no
repair-bay routing, nothing. `combatController.js` sets `threatUntil`/
`threatFrom` on every unit that takes damage, and says so directly in its own
comment:

```js
// Tell the victim it is under fire, and from where. Read by harvesterAI's
// FLEEING state; anything that ignores these fields simply stands its
// ground, which is the right default for something armed.
```
— `combatController.js:236-238`

Only `harvesterAI.js` reads those fields. A `gun-platform` fights until it
dies. There is no "pull back, heal, try again" cycle for combat units to
have — a losing army isn't withdrawn, it's spent.

So: builds an economy, yes. Builds an army and commits it, yes, on a
threshold. Plans, compares strength, retreats, recovers, retries — no, none
of that exists for combat units. What follows is the evidence, by topic.

## 1. Economy

Builds a harvester facility and tries to keep 2 harvesters, but the loop is
periodic, not reactive — nothing fires the instant a harvester dies.

```js
_manageEconomy(dt) {
    const base = this._base();
    if (!base || base.mode !== 'deployed') return;
    if (this._tryBuildNext(base)) return; // one action per tick is plenty
    this.buildTimer -= dt;
    if (this.buildTimer > 0) return;
    this.buildTimer = this.economy.buildInterval;
    // Economy before army: a team with no income cannot sustain either, and a
    // harvester that pays for itself is worth more than a gun that does not.
    if (!this._tryBuildUnit('economy', this.economy.harvesterCap)) {
      if (!this._manageDefense()) {
        this._tryBuildUnit('combat', this.economy.combatCap);
      }
    }
}
```
— `aiCommander.js:301-319`

`harvesterCap` is a hardcoded `2` across **every** difficulty, deliberately
not scaled up (comment at `aiCommander.js:55-64`). A dead harvester is
replaced only on the next `buildInterval` tick — up to 20 seconds later on
Easy — never immediately. There is no "credits are low" check anywhere in
the file, and the AI never buys the weapon-tier fire-rate upgrade
(`core/team.js:29-33` — confirmed absent by grep) or either structure's
upgrade track.

## 2. Base building

Structure choice and order are entirely generic — whatever is tagged
`production`/`repair`, cheapest first:

```js
const BUILDABLE_TAGS = new Set(['production', 'repair']);
const BUILDABLE_DEFS = STRUCTURE_CATALOG.filter((d) => d.tags?.some((t) => BUILDABLE_TAGS.has(t))).sort(
  (a, b) => (a.cost ?? 0) - (b.cost ?? 0)
);
```
— `aiCommander.js:78-84`

That fixes the order for every AI team, every match, every difficulty:
harvester-facility (free) → armed-factory (1200) → repair-bay (2000). No
randomization, no alternate strategy.

**Placement isn't a decision** — it's the next free pad slot:

```js
_buildOnPad(pad, def) {
    const slot = this.ctx.structures.freeSlot(pad, def.footprint);
    if (!slot) return false;
    if (!this.team.spend(def.cost ?? 0)) return false;
    const built = this.ctx.structures.place(def, pad, { x: slot.x, z: slot.z });
    ...
}
```
— `aiCommander.js:602-614`

Defenses (gun-turret, sensor-tower) are deliberately excluded from that path —
`structures.js:191-193`'s own comment: *"Not 'production': aiCommander's
BUILDABLE_DEFS picks off those tags, and a turret is not something it can
build on a pad anyway."* Instead a field-engineer is walked out to a ring
55–140 units from home and deploys one, capped at `defenseCap` and timer-gated
— proactive by schedule, never reactive to being attacked. There is no "under
fire, build a turret" code anywhere. `power-spire` is explicitly hardcoded out
too: `structures.js:162`, *"an AI commander never chooses to build one of
these."*

## 3. Military buildup

Only one real combat unit exists — `gun-platform`. `scout-buggy` is *also*
tagged `combat` (`catalog.js:17`), which produces a genuine quirk: once
`combatCap` gun-platforms are built, the same tag-scan keeps spending the
remaining combat budget on **extra scout-buggies**, which then do nothing but
wander and explore, since `_manageArmy` explicitly excludes `scout-buggy` by
id from the attacking force (`aiCommander.js:383`). Reads like an unintended
side effect of tag reuse, not a deliberate scouting-force scale-up.

The army-size gate to attack:

```js
// Attack only once there is enough of a group to be worth committing.
// Below that they hold near home, which doubles as base defence since
// combatController engages anything that wanders into range regardless.
if (army.length < this.economy.attackAt) return;
```
— `aiCommander.js:394-396`

`attackAt` is 2 (easy/normal) or 3 (hard/expert) — see the difficulty table
below. Once production hits `combatCap`, it simply stops; there's no
"rebuild losses beyond the cap" logic distinct from the same cap check firing
again on the next scheduled tick.

## 4. Attack decision-making — the headline finding

**No enemy-strength comparison exists anywhere in the file.** The entire gate
is the line quoted above: once `army.length >= attackAt`, the army advances
toward a target every tick, indefinitely. There's no "wait for the army to
be bigger than theirs," no timer beyond a 1.5-second re-target throttle, no
one-shot "declare war" event — it's a threshold that's simply true or false
on every tick.

Where it sends the army is fog-gated, not map-hacked:

```js
_attackTarget() {
    const fog = this.team.fog;
    const threshold = fog?.revealThreshold ?? 0;
    const consider = (x, z) => {
      if (fog && fog.seenAt(x, z) < threshold) return; // never scouted: unknown
      ...
    };
    ...
    return best; // nearest-to-home scouted hostile structure or enemy base
}
```
— `aiCommander.js:555-582` (abridged)

If nothing hostile has been scouted yet, the army just advances toward a
spread-out point near the map centre instead — the advance doubles as
reconnaissance (comment, `aiCommander.js:409-411`). Only one target is ever
chosen at a time: no multi-pronged attacks, no splitting the army, no feints.

Who actually shoots whom, tick to tick, isn't decided by the AI commander at
all — every unit on the map, player's and AI's alike, runs the identical
nearest-enemy auto-acquire in `combatController.js`:

```js
// Nearest wins. Deliberately not "weakest" or "most valuable": a unit
// shooting past the thing directly in front of it to plink at something
// it has decided matters more reads as broken, whatever the spreadsheet
// says.
```
— `combatController.js:161-164`

So the AI decides *when* and *where* to send a mass of units. It has no
target-value logic, no focus-fire, and — this is the part worth restating —
no idea how strong the enemy actually is when it commits.

## 5. Retreat, regroup, recover — none of it exists

Covered above: combat units have no health threshold, no flee state, no
repair-bay routing. Contrast directly with what harvesters get
(`harvesterAI.js:32-36,67-73,779-843` — `REPAIR_RETREAT_FRACTION = 0.5`, a
real `_maybeRetreatForRepair`, a real `_flee`) — none of that machinery has a
combat-unit counterpart. The army-management loop only ever *advances* units
that are free to be re-ordered:

```js
for (const unit of army) {
      // Never re-order a unit already engaging something — combatController
      // owns the shooting, and re-targeting mid-fight just makes it drive in
      // circles under fire.
      if (unit.combatTarget || unit.hasOrder) continue;
      this._advanceUnit(unit, target);
}
```
— `aiCommander.js:417-423`

There's no branch anywhere that pulls a damaged unit *out* of a fight. A
losing engagement just ends in dead units, and the only thing that happens
next is the same periodic economy loop eventually producing replacements —
which then walk toward the same `attackAt` threshold and repeat the exact
same one-way trip.

## 6. Scouting

Real, continuous, and the AI's only source of enemy intel — but blind, not
targeted. Every owned scout-buggy spirals outward from home forever:

```js
const EXPLORE_RADIUS_START = 90;
const EXPLORE_RADIUS_STEP = 45;
const EXPLORE_RADIUS_MAX = 480;
```
— `aiCommander.js:89-91`, golden-angle rotation to pick new directions
(`SCOUT_ANGLE_STEP = 2.399`, `aiCommander.js:99`), ring widening on every
successful new point. It has no notion of "go find the enemy base" — it's an
undirected outward search centred on the AI's own `homePoint`, with the
advancing army's own sight radius supplying whatever additional vision comes
for free en route.

## 7. Difficulty — behavior only, never a resource or stat cheat

Two separate systems exist and are easy to conflate. `DIFFICULTIES`
(`difficultyScreen.js`) is Sandbox-only and has zero effect on AI — it just
gates how much of the map must be explored before the base station unlocks
(no AI teams exist in Sandbox). The one that matters is `AI_DIFFICULTIES`
(`aiDifficultyScreen.js:10-15`), which sets `teamCount` (1–4 AI opponents) and
feeds `DIFFICULTY_ECONOMY`:

```js
const DIFFICULTY_ECONOMY = {
  easy:   { harvesterCap: 2, buildInterval: 20, combatCap: 1, attackAt: 2, defenseCap: 1 },
  normal: { harvesterCap: 2, buildInterval: 15, combatCap: 3, attackAt: 2, defenseCap: 2 },
  hard:   { harvesterCap: 2, buildInterval: 11, combatCap: 5, attackAt: 3, defenseCap: 3 },
  expert: { harvesterCap: 2, buildInterval: 8,  combatCap: 7, attackAt: 3, defenseCap: 3 },
};
```
— `aiCommander.js:70-76`

`buildInterval` is how often the AI takes *any* build action at all — 20s
down to 8s, i.e. harder difficulties simply act more often. `combatCap` scales
1→7. `attackAt` only moves once, 2→3. `defenseCap` scales 1→3. `harvesterCap`
never moves. **No credits multiplier, no starting-credit bonus, no unit-stat
change** — `Team` starts every team, human or AI, at `credits = 0`
(`core/team.js:56`), and the vehicle/structure catalogs carry no
difficulty-dependent fields at all. Higher difficulty means "reacts faster,
builds a bigger army, attacks at a slightly higher threshold" — not "cheats."

One more slider, `buildDelaySeconds` (0–180s, default 30), delays the AI's
very first action (`aiCommander.js:127,170-173`).

**A stale bit of UI worth flagging while it's fresh**: `aiDifficultyScreen.js:110`
still renders — *"AI opponents are coming in a future update — this starts a
solo match with these settings saved."* — directly contradicted by the fully
functional `AiCommander` this report is about. Leftover placeholder text,
never cleaned up after the AI actually shipped.

## 8. Multiple AI teams — independent, not coordinated

Up to 4 AI teams in one match (`AI_DIFFICULTIES.teamCount`), one
`AiCommander` instance per non-human team:

```js
game.aiCommanders = game.teams
      .filter((team) => !team.isHuman)
      .map((team) => new AiCommander({ team, buildDelaySeconds: ..., ctx: commandContext, camera }));
```
— `main.js:2069-2079`

**Zero coordination.** Every filter in the file is `v.teamId === this.team.id`
for "mine," everything else is uniformly hostile — human and AI opponents
alike. The mode is explicitly framed as free-for-all in its own UI copy: *"N
AI bases, all versus all"* (`aiDifficultyScreen.js:12-14`). AI teams fight
each other exactly as they fight the player, with no alliance or shared-intel
logic whatsoever. Online lockstep matches can mix human seats with AI-filled
bot seats too, and those bot seats are hardcoded to `'normal'`
(`main.js:2191`) — no difficulty picker for them.

## 9. What's conspicuously absent

- No target prioritization beyond nearest-enemy (shared with the player's own
  units — `combatController.js:161-164` — but it means the AI's army has zero
  focus-fire or threat-based targeting of its own).
- No retreat or self-preservation for combat units (§5).
- No adaptation to what the human or another AI is actually doing — nothing
  reads an opponent's build order, composition, or recent losses.
- No build-order variation — the exact same three structures, same order,
  every game.
- No army-vs-army strength comparison before attacking (§4).
- No formation logic — each unit in the "army" pathfinds independently toward
  the shared target and can arrive piecemeal.
- No weapon-tier or structure upgrade purchases, ever.
- No strategic relocation of an already-deployed, endangered base — base
  movement only exists as a one-time fallback when initial deployment fails.
- Single-target attacks only — no splitting the army, no feints.

## Not investigated

- Whether the "all versus all" framing changes qualitatively with 3-4 AI
  teams in play (e.g. two AIs ganging up on a third by coincidence of
  geography, not intent) — plausible from the code but not observed in a
  live run.
- Actual play-tested pacing/difficulty feel — this report is entirely a
  static read of the code, not a played match with timings recorded.
- The AI-filled bot-seat path in online lockstep matches specifically
  (`main.js:2191`) beyond confirming it's hardcoded to `'normal'`.
