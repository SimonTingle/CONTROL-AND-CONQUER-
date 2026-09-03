# The second fps regression: 60 → 22, and two of its causes were predicted in writing

## The report

> "in previous commits and md files we achieved 60 fps, now we are averaging 22
> fps examine what changes since we achieved 60 fps have been made that may
> have had an affect on fps and list them in order of criticality"

Baseline is `f092b43` (2026-08-26), the commit `docs/plans/fps-regression.md`
describes. **74 commits** landed on `main` between it and this one.

60fps is 16.7ms a frame and 22fps is 45.5ms, so ~28.8ms of new work per frame
needs accounting for. Three independent regressions each take a large share.
They are not alternatives; they stack.

## The uncomfortable part

Two of the three were **named in advance, in writing, by the first
fps-regression document**, and shipped anyway:

- It recorded that fixing the sound cache key "without adding a load-time
  pre-warm would move baking into gameplay frames and make performance worse."
  The key was fixed. The pre-warm was never added.
- The headlight pool's own header recorded that light cost "turns sharply
  nonlinear" past 16 lights. The pool went to 32.

Neither was an oversight in the sense of nobody having thought about it. In
both cases the note existed, was read, and was reasoned past. That is worth
recording more carefully than the fixes themselves, because the mechanism —
a warning that survives as prose while the number it guards moves — will
recur.

---

## 1 — CRITICAL: the headlight pool went from 4 real SpotLights to 32

`ed73372`, delivering a real multiplayer request ("a teammate's headlight beam
should be visible to other players too"), generalised `HeadlightPool` from one
rig to `RIG_COUNT = 8`. A rig is 4 SpotLights, so the scene went from **4 to
32 real lights**.

Why that is the top cause:

- three.js compiles the number of **visible** lights into every lit material's
  shader and evaluates all of them per fragment, *regardless of intensity*.
  The rigs are added to the scene at construction and `visible` is never
  toggled — `headlightPool.js` says so itself: *"Still visible, still counted,
  still costing."*
- The pool is constructed at module load in `main.js`, so **sandbox and
  single-player pay the full 32 too**. Not an online-only cost, which matches a
  flat, always-present 22fps rather than something that appears in a lobby.
- This is the same failure mode that once took this project to 705ms of a
  710ms frame (`bug-fixed.md`, Performance).

### The arithmetic error

`headlightPool.js` justified 8 rigs as *"comfortably inside the flat part of
the measured cost curve — 4 lights cost ~0.8ms, and the curve turns sharply
nonlinear only past 16."*

The knee is **16 lights**. 8 rigs is **32 lights**. The sentence compares a rig
count against a curve measured in lights, and concludes it is inside a bound it
is actually double. `docs/plans/synced-headlights-and-time-of-day.md` then
recorded, accurately, that the number *"was not independently re-measured …
inferred from the pool's own documented cost curve, not re-run from scratch."*
The inference was the error, and the note admitting it was inferred is exactly
where it should have been caught.

### The fix

`RIG_COUNT = 2` — 8 lights, half the knee. Your own vehicle plus the nearest
other piloted one still cast real beams; beyond that the pool degrades the way
it always degraded, to emissive-only lamps.

`LIGHTS_PER_RIG` and `POOL_LIGHT_COUNT` are now exported so the test asserts
the *product*, not the factor. The header was rewritten to state the bound in
lights and to say plainly that `RIG_COUNT * 4` is the number that costs.

### Measured, live, in a browser

Counted from the running game (`?benchmark=12`), which is hardware-independent
— it is a property of the scene graph, not of the GPU:

| | before (`RIG_COUNT = 8`) | after (`RIG_COUNT = 2`) |
|---|---|---|
| pool SpotLights | 32 | **8** |
| **visible lights in scene** | **34** | **10** |
| page errors | none | none |

Every visible light is evaluated per fragment on every lit surface, and the
terrain is a full-screen lit surface.

---

## 2 — CRITICAL: an O(n²) pathfinding solve moved onto a per-tick path

`NavGrid._solve` was a Dijkstra with a **linear min-scan**: n = 1,849 cells, so
**n² ≈ 3.42M inner iterations per solve**. Its own comment carried the
assumption that made that acceptable — *"this runs once per unique goal, not
per frame."* Three changes since `f092b43` each broke it:

- **Every ground shell wiped the cache.** `craters.js`'s `dig()` bumps
  `terrainVersion`; `NavGrid` rebuilt and cleared every cached flow field on
  that. A firefight destroyed the whole cache several times a second, and each
  rebuild cost a full solve per live goal.
- **The AI army was dead code at the 60fps baseline.** `a4cc07d`'s own comment
  records `_manageArmy` early-returning on `army.length === 0` for entire
  matches, *"taking `_updatePosture`, `_pickArmyTarget` and `_advanceUnit` with
  it."* Fixing that switched a whole per-tick layer back on. Part of this
  "regression" is therefore the game finally doing work it was always supposed
  to do — which is why the response is to make the work cheap, not to switch
  the AI back off.
- **`MAX_CACHED_FIELDS = 24` was sized for 4 teams.** A 20-team match wants
  40–60 live goals, so the cache thrashed and a thrash costs a full solve.

### The fixes

1. **Binary heap** (`CellHeap`) instead of the linear min-scan: O(n²) → O(n log
   n), ~3.42M → ~20K operations.
2. **The cache is cleared on passability changes, not on terrain changes.** A
   crater that submerges no cell, and any structure going up or down, are
   handled exactly as before; a crater that only moves heights no longer
   invalidates routing.
3. **`setTeamCount`** sizes the cache from the roster (6 fields per team,
   floor 24, ceiling 160), called from `beginMatch` — which covers online too,
   since online sets its team count before calling it.

### Why the heap needed a parity test, not just a faster one

`_solve`'s `next[]` records the *first* neighbour to achieve a cell's best
distance, so it depends on the order cells are settled in. The linear scan
settled ties by lowest index (`dist[i] < best` is strict, walking `i` upward).
Many equally-shortest routes exist on open ground, and a different tie-break
picks a different one — still valid, still shortest, but **different**. In a
lockstep match that is a desync between a patched and an unpatched client.

So `_solveReference` (the original solver) is kept solely as an oracle, and
`tests/nav-grid-heap-parity.test.mjs` diffs `dist` and `next` for **every goal
cell** across four grid shapes: flat open ground, a wall with a single gap
(mirror-image detours of equal length), water splitting the map, and a ramp
where climb limits make edges directional.

**The negative control is the argument for the test's existence.** Reversing
the tie-break to `a > b` — still a correct Dijkstra, still shortest routes —
fails the parity test, and **all 11 pre-existing NavGrid tests still pass.**
The difference is completely silent to every other test in the repo. That is
precisely the desync case, and nothing else in the suite would have caught it.

---

## 3 — CRITICAL: sound buffers baked inside gameplay frames

`fps-regression.md`: *"fixing the key without adding a load-time pre-warm would
move baking into gameplay frames and make performance worse."*

`4171959` fixed the key — correctly; the old key ignored params, so a 5-damage
plink and a base-station kill made the identical noise, and the sound editor's
whole feedback loop was broken. But the key quantised to **two decimal
places**, which is not a bound: damage scales continuously with veterancy rank
and a custom turret's damage is any integer in 1..100, so the key space ran to
hundreds of values per id. Every new key is an `OfflineAudioContext` render
whose noise fill is **synchronous on the main thread**, landing at every shot
and every explosion.

Second-order: the old key was also what *accidentally* bounded `bufferCache` at
48. Fixing it removed the bound without replacing it, leaving an unbounded map
of decoded audio held for the life of the page.

### The fix

**Geometric quantisation — one bucket per doubling** (`quantiseParam`).
Loudness and pitch are ratio-perceived, so a geometric step spends its buckets
where they can be heard: 5→10 is one bucket and so is 50→100. A gun twice the
calibre of another still gets its own bake, so the audible contract the key fix
existed to restore is intact, while the number of distinct bakes per id is
bounded by how many doublings fit the range (about eight) rather than by how
finely the damage numbers happen to be spread.

The snapped value is now passed to **both** the key and the generator. It
previously keyed on the quantised value and baked with the raw one, so which
buffer a key named depended on which shot baked it first.

An LRU bound (`MAX_CACHED_BUFFERS = 200`) is the backstop. Sized above the
working set quantisation actually produces, so in practice it never evicts and
never re-bakes.

**The cost, stated plainly:** a gun whose damage band straddles a power of two
shifts timbre slightly as veterancy ranks it up, because its band lands in two
buckets rather than one. Any bucketing has this at some boundary; a finer ratio
shrinks the step but multiplies the bakes, which is the thing being bounded.
The test pins it at "at most two buckets" rather than pretending it does not
happen.

### Ambience

`MIN_AMBIENCE_SEGMENT_SECONDS = 4`, enforced in `validateRecipe` and clamped
again in `synth.js`. A bed re-renders every segment minus its crossfade, each
starting with a synchronous per-sample noise fill; the schema's old floor of 1s
made that ~5 offline renders a second across two beds instead of ~0.45, an 11×
increase. `validateRecipe` bounded a bed's *size* and explicitly declined to
bound its *rate* — and recipes arrive over the wire from other players.

---

## 4 — HIGH: the AI commander's posture scan ran every tick

`aiCommander.update()` has no tick throttle, and `_updatePosture` was its most
expensive call: `_homeUnderThreat`, `_checkOpportunisticStrike` and
`_scoutedEnemyStrength` each walk every vehicle, the last also every structure
with a fog lookup per entity. At 60Hz × up to 20 teams that is millions of
iterations a second — feeding a decision only read once every
`ARMY_TARGET_INTERVAL` (1.5s), because posture is what *chooses* the army
target, and the target itself was already correctly throttled.

Now throttled to that same cadence. The cost is that a defensive reaction can
lag by up to 1.5s; the target it would have picked was already on that cadence,
so the commander is no less responsive than its own retargeting allowed.

---

## 5 — The pre-existing set

All predate `f092b43`, none caused the cliff, all compound it.

- **`leaveWreckage` was unbounded.** Per death: 1 Group, 3 BoxGeometries, 3
  shadow-casting Meshes, added to the scene **with no reference retained** —
  which made removal impossible even in principle, so nothing cleared them and
  a new match started littered with the previous one's dead, all of it in the
  sun's map-wide shadow frustum every frame. Now tracked in a `wrecks` array,
  capped at `MAX_WRECKS = 40` (oldest disposed first), and cleared in both
  `beginMatch` and `regenerate`.
- **`ScorchMask.clear()` existed with no call site.** Now called from the same
  two places.
- **`trafficController` was O(U²)** — every vehicle measured against every
  other, every tick, at 60Hz: 780 pairs at 40 units, 19,900 at 200. Replaced
  with a uniform-grid broad phase, cells sized to the widest possible
  interaction.
- **`facilityControl._facilityById` was a linear scan over all structures**,
  called once per claimant inside a per-tick rebuild. Now a `Map`, rebuilt each
  pass rather than cached across ticks (a structure can die at any time, which
  is this file's own stated rule).
- **`remoteActiveVehicles` did an O(U) `.find()` per remote player per frame.**
  Now one pass into a `Map`, built only when a remote player exists.

The traffic broad phase needed the same treatment as the heap, for the same
reason: `_resolveAvoidance` and `_resolveCollision` mutate what they are
handed, so **pair order is part of the simulation result**. A grid naturally
emits pairs in bucket order; candidates are therefore collected and sorted back
into ascending `(i, j)` — the order the nested loop produced. Negative control:
deleting the sort fails the parity test.

---

## Tried and deliberately reverted: the autoQuality backoff

`autoQuality`'s dwell doubles on every flip **including the first**, so one
honest drop to low quality means waiting 12s to recover, then 24s, 48s. That
looks like a defect, and "the first change is free" was implemented.

It makes `tests/auto-quality-damping.test.mjs`'s narrow-band case strobe an
extra time — which is the exact dusk/dawn flashing the damping was written to
fix and that a player reported. A slower recovery is the cheaper of the two
bugs, so the change was reverted and the reasoning left in the file so the next
person does not re-derive it.

Worth noting diagnostically: `LOW_FPS_THRESHOLD` is 25, and the report is a
steady **22**. The reporter is most likely already pinned in the low state
(pixel ratio 1, fog ×2.2) and *still* only reaching 22 — meaning the
un-degraded frame rate is worse than 22, which points at a per-fragment cost
(finding 1) rather than a CPU one.

---

## Verification

Frame rate cannot be measured here — no GPU, exactly as `fps-regression.md`
records — so the same discipline applies: assert hardware-independent
properties and hand the reporter the tools to confirm the fps itself.

- **`npm test`: 546 passing, 0 failing** (527 before; 19 new).
- **`npm run build`** (root) and the `itch.io` fork's build both pass.
- **Live browser count** of scene lights, before and after, in the table above.
  No page errors either run.
- **Negative controls for every fix**, applied by surgical edit (never `git
  checkout`) and restored:

| Reverted | What failed, and how |
|---|---|
| `RIG_COUNT` back to 8 | "pool puts 32 lights in the scene; the measured cost curve turns sharply nonlinear past 16" |
| heap tie-break reversed to `a > b` | parity test fails — **and all 11 existing NavGrid tests still pass** |
| unconditional `_cache.clear()` | "a crater that changes no passability does not re-solve" fails |
| cache key back to 2 decimal places | both cardinality bounds fail |
| broad-phase sort removed | pair order no longer matches the nested loop |

- **Runtime handles** for the reporter: `window.__headlightPool` (rig count),
  `window.__navGrid.solveCount` (should climb when units pick new destinations
  and stay flat while a firefight only digs craters),
  `window.__audio.debugState().cachedBuffers` (should settle, not grow all
  match), `window.__tickProfiler`, and the perf HUD's own light-count readout
  (press `p`).

## Not verified

- **That this is the reporter's 22 → 60.** It cannot be established from here;
  there is no GPU, so the symptom is not reproducible and no absolute fps
  number measured in this environment predicts anything about real hardware.
  What *is* established, hardware-independently, is that the scene went from 34
  visible lights to 10, that a 3.4M-iteration solve became a 20K-iteration one
  and stopped being invalidated by every shell, and that main-thread audio
  bakes went from unbounded to a small fixed set. The reporter should confirm
  on the hardware where the drop was seen.
- **The NavGrid heap's cost was not timed**, only its operation count reasoned
  and its output proved identical. Timing it here would measure SwiftShader
  noise.
- **No 20-team match was actually run.** The team-count cache sizing is argued
  from the goal-count arithmetic, not observed under load — this environment
  cannot stand up 20 connected clients.
- **The wreck cap of 40 was not tuned against play.** It is a bound chosen to
  be generous rather than a number derived from what a battlefield should look
  like.

## Found and deliberately not fixed

- **`projectileFx` toggles PointLight `visible` per explosion**
  (`src/render/projectileFx.js`). Changing the count of visible lights is
  exactly what forces three.js to re-link every material, so each explosion
  pays a re-link. Left alone: it is a behaviour change to explosions, it
  predates all of this, and finding 1 removes most of its penalty by shrinking
  what has to be re-linked. Worth doing next if explosion hitches persist.
- **One permanent `PointLight` per power spire** (`structures.js`), added to the
  group and never removed, so real light count grows with structures built
  across all teams and re-links on each build. Same class of problem as the
  above and the same reason for deferring.
- **`vehiclePicker.update()` still costs ~50ms/frame while the drawer is open**
  — unchanged since the first document flagged it. Gated behind the drawer
  being open, so it is not steady state, but it is still the largest single
  number in the profile when it is open.
- **`_build()` re-samples all 1,849 cells on any terrain change**, so a crater
  still costs one grid resample even though it no longer costs a solve. That is
  a ~100× improvement and was left there; making it incremental means teaching
  `craters.dig()` to report *where* it dug, which is a larger change than this
  pass warranted.
- **`restartAmbience()` re-bakes both beds on every `applyCustomSounds()`**,
  even when no ambience recipe changed.
