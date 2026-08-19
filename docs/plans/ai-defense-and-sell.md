# AI-built defenses and selling one back

## Context

`base-defenses.md` shipped the gun turret, the sensor tower, and the field
engineer that carries one out and deploys it — and left three things
explicitly for later: the AI never builds or uses a defense, the deploy
command was never clicked through the UI, and there was no way to get rid of
one once placed short of losing it in combat. This picks up all three except
the fourth item on that doc's roadmap (terrain ramparts), which the user
explicitly deferred again this round.

## AI-built defenses (`src/vehicles/aiCommander.js`)

`aiCommander` already had a per-tag production loop (`_tryBuildUnit`) and a
per-unit stuck-timer/retry pattern for units a team can own more than one of
at once (`scoutState`/`_driveScout`). Neither reached the field engineer: it
is tagged `support`, which nothing asked for, and even if it were built it
had no driver at all — `_manageEconomy` only ever calls `arrive()`-free
production commands, never sends a unit anywhere.

**`defenseCap`**, a new flat (not difficulty-scaled) knob alongside
`harvesterCap`/`combatCap`, counts gun-turret and sensor-tower together —
deliberately flat, since a fortified perimeter reads as a one-time
investment rather than an arms race the way army size does.

**`_manageDefense()`** queues one field-engineer at a time, gated on
`_ownDefenses().length + _ownUnits('field-engineer').length < defenseCap` —
counting engineers still walking toward a deploy site against the cap, not
just finished structures. Without that, a 15s `buildInterval` spent watching
one engineer cross ~100 units of ring queues a second and third before the
first ever plants anything, and the team ends up with more defenses than
`defenseCap` ever allowed. Slotted into `_manageEconomy`'s existing
harvester-then-combat priority chain, between the two: cheaper and more
one-off than the ongoing combat cap, but not worth a look until the
harvester cap is already met.

**`_driveEngineer`/`_driveOneEngineer`**, modeled directly on
`_driveScout`/`_driveOneScout` — same `engineerState` Map (one entry per
owned engineer, so one going stuck cannot stall another's order), same
`SCOUT_STUCK_TIMEOUT`/`SCOUT_ANGLE_STEP` escalation when a target turns out
unreachable. The one real difference: **a bug found before it shipped, not
after.** `deployDefenseCommands`'s own `enabled()` only refuses water — there
is no floor on how close to base is too close, because a human choosing to
plant a turret at their own front door is a legitimate (if odd) choice.
Nothing distinguishes "just built, never sent anywhere" from "arrived at a
previous target" through `hasOrder` alone — both read as `hasOrder === false`.
Checked naively, a freshly built engineer sitting on the pad would deploy
its turret at the factory door on its very first tick. Fixed with
`DEFENSE_MIN_RADIUS` (55, under gun-turret's own 74-unit range) as an
AI-side distance floor from `team.homePoint`, checked before considering the
deploy command at all — not a change to the shared command, since the
human path has no such problem to begin with.

`_preferredDefenseCommand` picks a sensor tower first if the team has none
(vision benefits everything else the team builds), then gun turrets up to
the cap — reading the offered `deploy-*` commands generically off
`commandsFor`, so a third defense structure added later needs no change here
beyond its place in the preference order.

## Selling a defense (`src/vehicles/commands.js`)

**`SELL_COMMAND`**, modeled on `UPGRADE_COMMAND`'s shape: refund is
`Math.round(cost * 0.5 * (health / maxHealth))`, paid through `team.earn()`,
then the structure is queued through the same destroy pipeline
`deployDefenseCommands`'s own `execute()` already uses
(`ctx.entities.queueDestroy`). Health-proportional on purpose — a turret
whittled down by an attack shouldn't refund the same as one that was never
touched, and a flat fraction would make selling a nearly-dead structure a
way to launder its remaining value.

Wired onto `'gun-turret'` under mode `'armed'` and `'sensor-tower'` under
mode `'idle'` — the two modes each finishes construction into
(`StructureInstance`'s own comment explains why: a turret has no other job
and nothing to trade away, so it comes up armed rather than idle). Neither
has any other command, so `sell` is the whole list for both.

Deliberately generic rather than defense-specific: nothing in `sellRefund`
reads anything about turrets or towers, so a future sellable structure can
reuse the same command unchanged.

## Verification

- **`tests/ai-defense.test.mjs`** (9 cases, dependency-free — a plain mock
  `ctx` shaped like `main.js`'s `commandContext`, no renderer): `_manageDefense`
  builds exactly one engineer under the cap and refuses once built+in-flight
  defenses already meet it (including refusing with an engineer that hasn't
  deployed yet, and correctly *not* counting a dead structure); the engineer
  prefers a sensor tower until the team has one, then a gun turret;
  end-to-end through `_driveOneEngineer`, a freshly built engineer standing
  near home is sent toward the perimeter rather than deploying on the spot,
  one that has actually walked clear deploys immediately without an extra
  detour, and a still-walking engineer is not re-targeted every tick.
  **Negative control:** removing the `DEFENSE_MIN_RADIUS` floor reproduced
  the exact bug described above — the near-home test failed with a structure
  placed where none should have been (`1 !== 0`). Restored.
- **`tests/base-defense.test.mjs`** gained 3 cases for the sell command,
  exercised through `commandsFor` rather than calling the command object
  directly, the same path an intent or a real click uses: a full-health gun
  turret sells for exactly half its cost; a half-dead sensor tower sells for
  a quarter, not half, proving the refund is actually health-scaled and not
  a flat fraction that merely looks right at full health; a structure still
  in `'building'` mode is offered no commands at all, so it cannot be sold
  out from under itself mid-rise. **Negative control:** flattening the
  refund formula back to `cost * 0.5` failed exactly the health-scaling case
  (`150` where `75` was expected) and none of the others. Restored.
- `node --test tests/*.test.mjs`: **112/112**. `npx vite build` succeeds.
- **Driven in a real browser** (Playwright, headless Chromium), Multiplayer
  AI (Easy, one AI opponent), through the actual radial-menu UI rather than
  calling command functions directly: deployed the base station via a real
  double-click and "Deploy base" click; built an Armed Factory via a real
  click-to-confirm placement (not a pre-computed coordinate — several screen
  offsets were tried until one landed inside the pad, exactly the ambiguity
  a real player's click has to resolve too); built a Field Engineer from the
  Armed Factory's own radial menu for 300cr; selected it from the vehicle
  drawer; opened its radial menu and confirmed it offered exactly
  "Deploy Gun Turret" and "Deploy Sensor Tower", both enabled; clicked
  "Deploy Gun Turret". The vehicle drawer's active-vehicle list lost the
  Field Engineer entry immediately after — direct confirmation that
  `execute()` ran for real and the engineer was consumed via
  `ctx.entities.queueDestroy`, not just that the click was accepted.
  Credits were granted through a temporary console hook
  (`window.__grantCredits`, added for this test run and removed before
  commit) rather than earned through the harvester economy — bootstrapping
  the 1500cr needed for an Armed Factory and an engineer this way was a
  deliberate scope cut, not an attempt to hide anything: harvesting is
  pre-existing, unrelated code, and every step *after* granting credits
  still went through the same `commandsFor`/intent path a real click always
  uses.
  **Not verified: clicking "Sell" on the resulting structure.** The chase
  camera re-centres on a different active vehicle the instant the engineer
  is consumed (confirmed: the HUD read "Scout Buggy" one screenshot later),
  and the deploy point sits at a spawn angle chosen from a 6-candidate arc
  around the base's own heading (`baseSpawnAnchor` in `commands.js`) that
  can land outside the camera's default framing entirely. Re-centring on the
  base and scanning a grid of screen offsets around it — including a
  zoomed-out wide scan — never located the placed turret's radial menu.
  `page.mouse.wheel()` did not visibly change the chase camera's zoom
  (`chase.zoom()`'s wheel listener in `main.js` was not investigated further
  — out of scope for this change), which is what defeated the wide scan.
  This is a test-harness camera-positioning gap, not a functional one: the
  sell command's correctness is covered directly above via `commandsFor()`
  with a negative control, and it is wired through the exact same
  `execute()`/`queueDestroy` mechanism just proven to work for
  `deployDefenseCommands` above. Also not verified in an online match — see
  `base-defenses.md`'s own note on the same gap; nothing here closes it
  either.

## Found along the way, not chased down

Setting up the browser verification above, a fresh Multiplayer AI match's
harvester facility shipped its free harvester as expected, but delivered
**0 credits after 40 simulated minutes** (`window.__step(2400)`, confirmed
via the vehicle drawer reading "Crystal Harvester 100% · 0 cr" — its
lifetime-delivered stat, not just the team total). The sim was genuinely
advancing throughout (`window.__hashState()` changed at every checkpoint),
so this was not a frozen tab or a `__step` artifact. Not root-caused — could
be a map where the nearest reachable bloom field is implausibly far from
that particular spawn point, or a genuine `harvesterAI` stall this session
didn't have the budget to isolate. Recorded rather than fixed, and unrelated
to anything in this change: worth another session picking it up with a
repeatable seed and a look at `world.blooms.nearestTo`'s actual candidates
from that spawn point.

## Deliberately not done

- **Terrain ramparts**, the fourth item on `base-defenses.md`'s original
  roadmap, remain out of scope — the user explicitly picked "2, 3 & 4" this
  round, not "1".
- **The AI never sells a defense it built.** `_manageDefense` only ever adds;
  nothing retires an obsolete or badly-placed one. Symmetrical with the human
  side only getting the option, not an AI policy for using it.
