# Weapons resolve instantly and leave no trace

## The problem

Combat worked, and was invisible.

`combatController.js` resolved every shot as hitscan: `_fire` applied
`target.takeDamage(...)` on the same tick the trigger was pulled, then called an
`onShot` hook so `main.js` could draw a tracer *after the fact*. The file's own
header was explicit about it — "the travelling tracer is therefore purely
cosmetic: it is drawn after the damage it represents has already been applied,
and nothing reads it back."

Everything downstream of that followed:

- **No shot could miss.** The only gate between a valid target and applied
  damage was `aimError > AIM_TOLERANCE` and line of sight. Two units in range of
  each other traded damage at a rate fixed entirely by `fireInterval`, and the
  outcome of every engagement was decided the moment it started.
- **Nothing landed anywhere.** A shot that hit produced a white flash; a shot
  that missed did not exist. The terrain a battle was fought over looked
  identical afterwards.
- **Veterancy did not exist.** Vehicles have carried a `kills` counter since
  weapons did, saved in the snapshot and shown on the picker card, but nothing
  read it except `vehicleSellRefund`'s `KILL_BONUS_PER_KILL`. A unit that had
  destroyed ten things fought exactly like one fresh off the pad.
- **A kill was worth nothing on the field.** Destroying an enemy vehicle
  produced three dark boxes (`leaveWreckage`) and a stat increment. The only
  credits a kill ever generated were indirect, months later in match time, if
  you happened to sell the unit that made it.

There was also no particle system anywhere in the repository, and no pickup
entity of any kind — the closest precedent for either being `blooms.js`'s
crystal fields.

## What was changed

Four things, staged as four commits on one branch:

1. Shells that travel, and can miss.
2. Ground impacts that crater the terrain and scorch it.
3. A ground mark under each shell that is a shadow by day and a glow by night,
   and explosions that light the ground after dark.
4. A bounty coin at every wreck, claimable by either team.

## The argument this change had to answer

`combatController.js`'s header did not merely describe hitscan — it *argued for*
it, on two specific grounds, and reversing the decision meant answering both
rather than deleting the paragraph.

**"A per-tick projectile-versus-everything loop."** This turned out not to be
the design that was needed. The alternative adopted here decides hit or miss
**at launch**, so a shell never tests itself against anything: it flies to a
point and resolves there. The per-tick cost is an integration and one
comparison, i.e. O(shells in flight), not O(shells × world). At the engagement
counts this game produces, that is not a measurable cost.

**"'Who killed what' is ambiguous when a shooter dies mid-flight."** This was
the real hazard and it drove the shape of the projectile record. A shell holds
**no reference to its shooter**. At launch it copies out the shooter's id, team
id, def id and the damage the shot was fired with. A tank destroyed one tick
after firing still lands its shell, still deals its damage, and is still
credited — and when its instance has genuinely been spliced out of
`vehicles.instances`, the team-level `killsByDefId` tally is credited from the
copied `shooterDefId` instead of being silently lost.

This is the same rule `harvesterAI.js`'s header sets out and `aiCommander.js`
follows — never cache a reference to another entity across ticks — applied to
the one system that had previously sidestepped it by never spanning ticks at
all. `tests/projectile-flight.test.mjs` covers both directions of the problem:
shooter removed mid-flight, and target removed mid-flight.

## Determinism: why the accuracy roll is a hash, not a random number

A shot that can miss needs a random number, and this simulation has none. There
is no seeded PRNG anywhere in `src/`, and `CLAUDE.md` forbids `Math.random`
anywhere a simulated value can reach.

**The option not taken** was to add one — a seeded generator threaded through
the sim, serialized in the snapshot and included in `stateHash`. This was
rejected because a PRNG *stream* is itself a desync surface, and a
particularly nasty one: the shared secret is not just the seed but the number of
draws taken, so one client taking one extra draw — from a code path that runs
under a condition the other client evaluated differently, or simply from a
different build — diverges every roll thereafter, silently and permanently. It
would also have to be restored exactly on a snapshot resync, meaning the draw
count becomes part of the save format.

**What was done instead** is `shotRoll` in `projectiles.js`:

```js
fnv1a(`${shooterId}|${targetId}|${tick}|${salt}`) / 0x100000000
```

The inputs are three things every client already agrees on, hashed with the
FNV-1a already used by `stateHash.js`. The properties that matter:

- It is stateless, so there is nothing to serialize and nothing to keep in step.
- It is a pure function, so a resync that rewinds the world **reproduces the
  same rolls** rather than desynchronising a stream.
- Unrelated rolls cannot perturb it. `tests/missile-accuracy.test.mjs` asserts
  this directly, because it is exactly the property that would quietly stop
  holding if someone later added a counter.

The `salt` argument exists because two decisions are made per shot — whether it
hits, and which way a miss goes. Sharing one number between them would make
every miss from a given shooter fall on the same side of its target.

The roll's distribution is also tested. A hash with poor avalanche would be
deterministic, pass every purity test, and still (say) never return above 0.6 —
turning every shot into a hit. Ten buckets over 500 shots must all fill.

## Accuracy model

`hitChance(inst, team, dist)` in `combatController.js`, exported and pure:

```
base 0.60
  + 0.08 per veterancy rank   (0-3)
  + 0.10 per team weapon tier (0-3)
  × (1 - 0.45 × dist / range)
clamped to [0.15, 0.95]
```

The composition is deliberate and is tested as such. Rank and tier are **added**
to the base and the whole thing is then **scaled** by range. Subtracting a range
penalty instead would let a high enough rank cancel distance out entirely, so an
elite unit would be as accurate at the edge of its range as at point blank.

`dist / range` is clamped inside `hitChance`, because `_validTarget` holds
targets out to `RANGE_HYSTERESIS` (1.15×) — without the clamp the falloff term
would pass 1 and *invert*, making very long shots more accurate than nominal
ones. This was caught by writing the boundary test, not by reading the code.

A miss is aimed, not accidental: the aim point is offset to a spot on the
ground beside the target, at least `MIN_MISS_OFFSET` (2.5 units) away so a
close-range miss cannot land inside the target's own footprint and read as a hit
that did nothing. That offset is why the decision has to be made at launch.

## Veterancy: derived, not stored

`veterancy.js` exports `rankOf(kills)` and nothing else stateful. **No `rank`
field was added to any instance**, deliberately: `kills` is already simulation
state, already serialized, already incremented at the kill site. A second field
would be a denormalised copy of it — one more thing to save, hash, migrate and
get out of step with its own source.

Thresholds are cumulative kills at 2 / 5 / 10. Rank buys accuracy
(`ACCURACY_PER_RANK`) and a deliberately small damage bonus (+5%/rank): a unit
that hits more often already deals more damage per second, and stacking a large
damage bonus on top compounds into an elite unit no fresh unit can trade with.

**One consequence that had to be handled:** `kills` was *not* in `stateHash`
before this change, and correctly so — it was a display stat, and a client whose
tally had drifted still simulated identically. It decides accuracy and bounty
value now, so it is hashed. This is the kind of field-becomes-load-bearing
transition that is easy to miss and produces a desync nobody can reproduce.

## Craters: recorded events, replayed on load

`core/craters.js` is modelled directly on `core/terraform.js`, which had already
proved the technique for construction pads: write into `heightmap.data`, flag
`needsUpdate`, and get correct shading and shadows free because the terrain
shader derives normals analytically from that same texture.

The two things that do *not* follow automatically are the same two terraform
patches by hand, and both are easy to skip and hard to notice:

- `fogTerrain.patchTerrain` — without it the explored-percentage readout drifts
  against ground whose height changed.
- `heightmap.terrainVersion++` — without it a cached NavGrid flow field routes
  vehicles through a hole that is now too steep to climb.

**Three alternatives were weighed for making this survive a save:**

| Approach | Why not |
|---|---|
| Serialize the heightfield | 513², ~1MB of floats per save. This is exactly what terraform's pad replay exists to avoid. |
| RLE the height delta, like `tracksRLE` | Works, but far larger than the record list for the crater counts involved, and the encode/decode is a second thing to keep correct. |
| **Record and replay (chosen)** | Four numbers per crater. `dig` and `restore` share one `_apply`, so replay is exact by construction rather than by agreement between two code paths. |

A tempting bound — keep only the most recent N craters — was **rejected**, and
the reason is recorded in the file: a save that had forgotten its oldest craters
would replay to a *different heightfield* than the one it was taken from, which
in an online match is a desync rather than a cosmetic difference. Growth is
bounded at the source instead: `MIN_CRATER_DAMAGE = 12` means light weapons
never dig, so sustained autocannon fire cannot erode the map or the save.

Crater depth is clamped at the sea margin (`terraform.js`'s `SEA_MARGIN`, same
value, same reason) so a crater can never punch a pond into a hillside or flip
drivable ground into water. Depth is also capped outright at 2.4 units, because
a crater deep enough to trap a vehicle is a movement bug wearing a visual
flourish.

## Scorch marks: render-only, and why that differs from craters

`render/scorchMask.js` copies `core/trackMask.js`'s structure exactly — the
`Uint8Array` + `DataTexture` splat mask, the hot-cell set, and in particular the
**fractional fade remainder**, whose absence trackMask's header documents as
having silently turned a 75-second fade into a ~4-second frame-rate-dependent
one. A ten-minute scorch fade drops far less than one 0-255 step per frame, so
the same bug would have been correspondingly worse here.

Scorch is deliberately **not serialized**, unlike both the craters beneath it and
the tracks it is modelled on. The distinction is whether the simulation reads
it: a crater changes height, and therefore line of sight, wheel grounding and
pathing; a scorch mark changes nothing but colour. Saving it would mean keeping
a second megabyte-scale array in agreement across a lockstep match to buy back a
cosmetic detail. A loaded world shows fresh ground under old craters. That is
the accepted cost.

In the shader, scorch **darkens and desaturates** rather than tinting toward a
colour. Mixing toward a fixed brown would erase the difference between scorched
sand and scorched rock — which is precisely the terrain variation the impact is
meant to be sitting on.

## The ground mark: one quad, cross-faded

The request was a shadow by day and a transparent glow on the floor by night.
These are drawn by the *same quad*, cross-faded on sun elevation through
`nightFactor()`, rather than by two effects switched between.

Real `castShadow` on the shell mesh was the obvious alternative and is worse at
both ends: it costs shadow-map fill for a sub-metre object, and it produces
nothing at night, when the glow pool would still have to exist as a separate
thing. One quad does both jobs.

`nightFactor`'s thresholds are exported and shared with the coin glow, and were
chosen to match the existing dusk gates that `headlightsWanted()` (main.js) and
the flare command (`commands.js`) already use. Three systems independently
deciding when night starts was a real risk worth designing out.

Impact lights are **hard-capped at six concurrent** and only spawn below the
dusk threshold. Both matter: a point light per shell would recompile shaders
mid-battle, and by daylight the light is invisible against the sun and would be
pure cost.

## Bounty coins

`vehicles/bounty.js`, dropped from the destroy pipeline next to `leaveWreckage`
— and for the same stated reason that hook sits there: the instance still knows
where it was and how many kills it had earned, and `vehicles.remove()` takes
both away.

Value is `round(cost × 0.25 × (1 + 0.10 × rank))`. Well under half deliberately:
a bounty should reward aggression, not make killing more profitable than
harvesting, which would invert the economy the whole game is built on.

**Either team can claim it.** The killer gets a head start, not an entitlement.
A coin nobody has to contest would just be a delayed credit transfer with extra
steps.

Two details exist for lockstep rather than for play:

- The claim goes to the **nearest** eligible vehicle, not the first found.
  `vehicles.instances` is ordered by spawn history, which is not something two
  clients need to agree on; letting it decide a coin would make an economic
  outcome depend on it. Distance is a fact about the world.
- Ties break on **lower id**, for the same reason.

Structures drop nothing — a building is not salvage you drive over, and a base
station worth a quarter of its cost would make razing a base pay better than
taking one.

## The credit flourish

`ui/creditBurst.js` is DOM, not 3D particles. The effect's entire job is to
connect a point in the *world* to a point in the *interface*; world particles
could only fade out near the screen edge and imply the rest, while DOM particles
actually arrive. It also sidesteps depth sorting against terrain, and inherits
the HUD's own gold (`#f0c65a`) rather than maintaining a second copy of it in a
material.

One thing worth stating because the obvious implementation is wrong: the flash
is **driven by the collection event, never by watching the credits number**.
`hud.update` polls credits on a half-second timer, so a flash triggered by
noticing the total had changed would fire late, fire for harvester income too,
and miss two collections landing inside one poll window.

It fires only for the local player's team. An AI hoovering up coins across the
map would otherwise spray the player's HUD with credits they never received.

## Found and deliberately not fixed

- **`tests/match-client-protocol.test.mjs` and `tests/match-room.test.mjs` fail
  on `main`**, before any change here, and still fail. They are untouched by
  this work and were left alone rather than folded into an unrelated branch.
- **`leaveWreckage` still leaks.** It adds a `THREE.Group` straight to the scene
  and never removes it, so a long match accumulates wreck meshes indefinitely.
  It is also non-deterministic (`Math.random`), which is safe only because
  nothing reads it. Out of scope here, but it is now sitting next to a coin
  system that *is* pooled and *is* cleaned up, which makes the contrast obvious
  to the next reader.
- **`showFlare` no longer shares the shot pool.** It used to reuse `showTracer`,
  which is gone. It now has its own four-slot pool in `main.js`. A flare is not
  a shot — no damage, no hit roll, and it must not appear in a state hash — so
  folding it into the projectile *simulation* would have been wrong; a small
  duplicated pool is the cheaper mistake.
- **`KILL_BONUS_PER_KILL` (commands.js) was left as a flat per-kill number**
  rather than re-expressed through `rankOf`. It is a sell-refund term and works
  correctly; changing it would alter existing sell prices for no reason this
  change requires. Noted because sell value and bounty value now scale off the
  same underlying `kills` by two different curves, which a future reader may
  reasonably want to unify.
- **Impact debris does not interact with vehicles.** It is pooled render-only
  geometry that falls to the ground and vanishes.

## Verification

`npm test` — 285 pass, 2 pre-existing failures unchanged. New suites:

- `tests/missile-accuracy.test.mjs` — the accuracy curve's monotonicity in rank,
  tier and range; the clamps at both ends and past nominal range; `shotRoll`'s
  purity, salt sensitivity and distribution.
- `tests/projectile-flight.test.mjs` — damage lands on arrival and not at
  launch; a shell outlives its shooter; a kill by a dead shooter still reaches
  the team tally; a shell whose target died becomes a ground impact; a corpse
  takes no damage; damage is fixed at launch; several shells resolving on one
  tick all resolve (the splice-while-iterating case); a restored shell resumes
  rather than relaunching.
- `tests/craters.test.mjs` — the damage floor and the caps; replay reproduces
  `dig` texel for texel; the sea-margin clamp; `restore` does not re-patch fog.
- `tests/bounty.test.mjs` — the value formula; either team can claim; nearest
  wins over array order; expiry pays nobody; no double claim.
- `tests/statistics-tracking.test.mjs` — rewritten to drive the kill tallies
  through `Projectiles` rather than `CombatController._fire`, since that is
  where the bookkeeping now lives.

**Negative controls run**, per `CLAUDE.md`, each confirmed to fail for a
behavioural reason rather than a missing import:

- Dropped `salt` from the `shotRoll` hash key → "every input, and the salt,
  changes the answer" fails.
- Removed the sea-margin clamp from `Craters._apply` → "a crater never digs
  below the sea-level margin" fails.
- Restricted coin claims to the dead vehicle's own team → six bounty tests fail,
  including "the enemy team can claim a coin dropped by its own kill".

`npm run build` passes.

**Not verified:** the `tests/e2e/` two-client match test has not been run — it
needs a database and real infrastructure, and this environment has neither. It
is the only check in the repository that can observe a lockstep split-brain, so
the additions to `stateHash` (`kills`, in-flight shells, uncollected coins) and
the v3 snapshot round-trip are argued for above but **not** demonstrated across
two real clients. That is the first thing to run before this is trusted online.
Nothing here has been exercised in a browser either — no visual confirmation of
the shadow/glow cross-fade, the night impact lights, or the credit flourish.
