# Statistics screen: a second page in the drawer

Request: hide World Settings behind a sub-menu in the left hamburger and add a
second option, Statistics, showing per-team stats for Sandbox, Multiplayer AI
and Multiplayer Online — score, units built and lost, which vehicle has the
most kills, what each harvester has earned — with player names for online
matches and small graphs that fall back to text on a phone.

Scope agreed before starting: an in-place drawer takeover rather than a second
full-screen overlay; the live current match only, no persisted history; only
the stat tracking that genuinely does not work today; and player names shown on
this screen alone.

## What was already there

More than expected, which is most of why this is a small change.

- `Team.stats` (`team.js`) already had `creditsEarned`, `unitsBuilt`,
  `unitsLost`, `structuresBuilt`, `structuresLost`, written from
  `Team.earn()` and `main.js`'s build/destroy paths.
- Vehicles already carried `kills`, `odometer` and `creditsDelivered`
  (`vehicleController.js:141-143`), incremented at `combatController.js:247`,
  `vehicleController.js:458` and `harvesterAI.js:510`.
- `MatchEndScreen._buildSummary()` already rendered a per-team table with the
  look wanted, and its `.match-summary` CSS is reused here directly.
- `Menu` already took a schema **function** and re-rendered wholesale via
  `rebuild()` — so page switching needed no new component, just a `view` field.

## Three things that changed the design

### 1. `creditsEarned` is not harvest income

`Team.earn()` has three callers, not one: harvester delivery
(`harvesterAI.js:507`), selling a structure back (`commands.js:190`) and an AI
build refund (`aiCommander.js:1089`). So `creditsEarned` counts credits that
were never produced, and a build-and-sell loop inflates it without harvesting
anything.

Score therefore reads a new `harvesterEarningsTotal`, tallied only at the
delivery site. `creditsEarned` is still shown, on its own row labelled *Credits
earned*, and the screen says in as many words that the two differ. Showing one
number labelled "Score" that quietly included refunds would have been worse
than showing both.

### 2. A unit's stats die with the unit

`vehicles.remove()` (`vehicleController.js:855-857`) splices a destroyed
instance out of the array, and `leaveWreckage` captures nothing. Anything
computed by walking live instances silently under-counts every match — the
"most kills" answer would quietly exclude every unit that fought and died,
which is most of the interesting ones.

So three tallies live on the team and are written **at the existing increment
sites**, not rescued at destroy time:

- `killsByDefId` and `topKillsVehicle`, beside `inst.kills++`
  (`combatController.js`). "Is this run better than the best so far" is
  answerable while the shooter is alive, so no destroy-time hook is needed.
- `harvesterEarningsTotal`, beside `inst.creditsDelivered +=`
  (`harvesterAI.js`).

Only `deadHarvesterEarnings` needs the destroy pipeline, because it is
inherently a per-unit list rather than a running scalar. It appends in the
existing `entities.onDestroy` handler in `main.js`, which runs before the
removal hook, so `creditsDelivered` is still readable. Live harvesters are read
straight off `vehicles.instances` at render time and combined with it.

`topKillsVehicle` replaces on strictly greater, never on equal — otherwise the
record just tracks whoever fired most recently.

Turret structures are shooters too (`_shooters()` concatenates them) and carry
`def.id`/`kills` under the same names, so they fold into the same tallies. That
widens "top unit" to "top entity"; a deliberate call, noted rather than done
silently.

### 3. `team.stats` gained its first nested values

`snapshot.js` serialized with `stats: { ...team.stats }` — a **shallow**
spread — and restored with `Object.assign`. Both are shape-agnostic, so new
*flat* fields would have needed no snapshot change at all. But `killsByDefId`
is an object and `deadHarvesterEarnings` an array, and a shallow spread copies
those by reference: the "snapshot" would keep changing after it was taken.

Every current caller stringifies synchronously (`matchClient._send`,
`main.js`'s determinism check), so nothing was broken — but `view.snapshot()`
hands the object out raw, and that is not a property worth depending on. The
serializer now copies both explicitly. There is a test that mutates a team
after serializing and asserts the snapshot did not move.

Restore needed no change: `Object.assign` only writes keys a save carries, so
an older save loads with the fresh defaults rather than `undefined`.

## The drawer

`Menu` gained a `view` field (`'chooser' | 'settings' | 'stats'`) and three
render methods. The `<details>`/`createControl` pipeline is untouched — World
Settings renders exactly as before, with a back row prepended.

Two details that are not obvious:

- **`rebuild()` is now a no-op unless Settings is showing.** It fires on
  sign-in, sign-out and every snapshot load, none of which are a reason to yank
  someone off Statistics mid-read. `showSettings()` rebuilds from
  `buildSchema()` anyway, so nothing goes stale.
- **Opening always lands on the chooser**, and closing unmounts the stats page
  so it stops re-rendering behind a closed drawer.

`index.html`'s static `<h1>World Settings</h1>` became `Menu`; the constructor
overwrites it immediately either way, so this only fixes first paint.

## Layout, and one thing the browser corrected

Stats run **down** the side and teams **across** the top — the transpose of
`matchEndScreen`'s layout. That was not a style preference: laid out with a
column per stat, six stats overflowed the 320px drawer, measured in a real
browser. Teams are few and stats will keep being added, so the axis that grows
has to be the vertical one. It also buys room for real labels
("Structures built") instead of glyphs.

The "graph" is one absolutely-positioned div behind each number, width scaled
against the best value **in its own row** — Score and Units built are not on
comparable scales. No canvas, no SVG, no library. It hides at the same 720px
breakpoint where the drawer already narrows, so the mobile fallback is complete
rather than degraded.

A second browser finding: the back button overflowed the drawer by exactly its
own margins, because `button.action { width: 100% }` (specificity 0,1,1) beat
`.panel-back` (0,1,0). Fixed by matching the specificity, not by `!important`.

## Online player names

The server already sent `displayName` in `welcome.players`, `begin.players` and
`playerJoined`; the client dispatched `onPlayerJoined` but `main.js` never
wired it and never read `msg.players`. A `rememberPlayerNames()` helper now
feeds `game.playerNames` from all three, and `StatisticsScreen._labelFor()` is
its only reader.

`Team.name` is never written, so the minimap, HUD and radial menu show exactly
what they showed before. The map is cleared at the top of `startOnlineMatch`
rather than in `beginMatch`, because the roster arrives with `welcome` — which
lands *before* `beginMatch` runs, so clearing there would wipe the names the
match had just learned. Seats are reassigned every match, so a stale entry
would put the previous opponent's name on a new player.

Names are never removed when a player drops: their team's stats stay on the
board, and an anonymous row is worse than a name that has stepped away.

## Verification

`tests/statistics-tracking.test.mjs` — 12 tests, dependency-free, driving the
real `CombatController` and `Team` against plain mocks:

- `earn()` moves `creditsEarned` and never the harvest total.
- Fresh teams start zeroed, and do not share nested containers (a single
  literal reused across constructions would alias every team's kills into one
  map — invisible until two teams are on the board).
- Kills land per type, sum across separate units of a type, and survive the
  unit that set them.
- The record yields to a strictly better run and not to a tie.
- A turret can hold it; a non-fatal shot records nothing.
- `serialize` freezes the nested containers; an older save loads at defaults.

Three negative controls, each failing behaviourally:

| Reverted | Result |
|---|---|
| kill-site tallies removed | 3 fail |
| record on `>=` instead of `>` | 1 fail |
| snapshot back to the shallow spread | 1 fail |

Full suite 213 passing; `npx vite build` clean.

**Driven in a browser** (headless Chromium, Multiplayer AI on hard), 16 checks:
chooser on open, both entries, all three sections, bars drawn, back returns,
World Settings intact (8 groups, 37 sliders) with a slider still writing
through to the world, reopening resets to the chooser, bars hidden and no
overflow at 390px, no page errors. Screenshots taken at both widths.

The live-refresh check initially "failed" against the player's own row — which
legitimately never moves in a headless run, since nothing drives the player's
vehicle. Watching the whole panel instead showed the AI's numbers advancing
(1280 → 1920, per-harvester `960 · 320` → `1280 · 640`). A test bug, not a
code bug, but worth recording as the reason that assertion is written the way
it is.

**Not verified: online player names.** The wiring is read-and-reasoned only —
it needs `server/` running plus two signed-in clients in one lobby to confirm
each sees the other's name *and* that the minimap and HUD still show what they
showed before. That last half is the check that actually proves `Team.name`
was left alone.

## Deliberately not done

- No persisted match history — this is the live match only.
- No per-structure production stats; `StructureInstance` tracks no lifetime
  counters and none were added.
- No time-series or sparklines. Nothing here records history, so the bars are a
  same-instant comparison and nothing more.
- No damage-dealt or shots-fired counters.
- No mode tab switcher: the screen is mode-*aware*, and only one match exists
  at a time.
- No change to `Team.name` or anything reading it.
- **Found, not fixed:** `matchEndScreen._buildSummary()` renders five column
  headers but only four value cells per row, so `structuresLost` is dropped and
  the "Buildings" column is misaligned against its data. A separate screen and
  a separate fix; noted here so it is not lost.
- **Pre-existing, not fixed:** the fixed vehicle HUD card overlaps the bottom
  of the drawer. `#panel` scrolls, and World Settings' own content is 1093px in
  an 800px panel, so it has always run under that card too — the Statistics
  page is shorter, and behaves the same.
