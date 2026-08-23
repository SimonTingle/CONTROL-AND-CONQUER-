# Harvester field selection: stop two harvesters piling onto one field

Follow-up to [ai-commander-overhaul.md](ai-commander-overhaul.md). Driving a
real match to verify that work surfaced a further problem: on `hard`, the AI
built zero combat units in 45 simulated minutes, because it never accumulated
the 1200cr an armed factory costs. A captured credit trace went completely
flat at 1000cr for 90+ straight seconds with two harvesters supposedly
working — flat-zero income needs a different explanation than "slow."

## The mechanism

- A field's stock is capped at 900 and regenerates at at most 6 units/sec at
  full stock, scaling down toward ~2/s near empty (`terrain/blooms.js`).
- Each harvester draws 48 units/sec while filling (`catalog.js`).
- `_isFieldCrowdedOrLow`'s crowd cap, `MAX_HARVESTERS_PER_FIELD = 2`
  (`harvesterAI.js:65`), permits exactly two harvesters on one field — and
  the AI's `harvesterCap` is also flat at 2 (`aiCommander.js`). Nothing
  pushed the AI's two harvesters apart: each independently picked the
  *nearest* non-banned, non-crowded, non-low field, and since a field with 0
  or 1 harvester already on it both read as "not crowded," they routinely
  converged on the same one.
- Two harvesters filling concurrently on the same field draw 96 units/sec
  against ≤6/s regen — a 900-capacity field crosses the 33% low-stock
  threshold in under 10 seconds of concurrent harvesting, and because the
  low-stock check only gates *new* assignments, keeps draining toward zero
  rather than diverting early. Recovering back above 33% at the near-empty
  regen rate is the tens-of-seconds order of magnitude the captured trace
  showed.

A single harvester never triggers this: it fills for ~6.7s, then drives away
to unload for a much longer round trip, during which the field regenerates
undisturbed. The collapse is specifically a *two harvesters, same field, same
time* problem — exactly the shape the AI's fixed harvesterCap of 2 guarantees
it will hit whenever its second harvester happens to pick the same nearest
field as its first.

Not AI-only: `_idle`'s automatic field pick runs for any harvester that
hasn't had a field manually assigned, player-owned included. A human player
usually has enough harvesters and fields in play not to notice one collapsed
field; the AI, permanently capped at 2, cannot absorb it. Fixed once, in the
shared mechanism, rather than teaching `aiCommander.js` a workaround for a bug
that also affects players.

## The fix

One additive tier, prepended to `_idle`'s existing two-tier fallback chain
(`harvesterAI.js`), following the exact idiom already there — each tier is a
`nearestTo` call with a progressively looser `reject`:

1. **New, strictest first attempt**: not banned, not crowded-or-low, and
   `_countHarvestersOnField(field, inst) === 0` — nobody at all currently
   filling or en route. `_countHarvestersOnField` already existed and already
   counts across every team, so no team-filtering was needed.
2. Today's existing first attempt (not banned, not crowded-or-low) is the
   fallback when no untouched field is reachable.
3. Today's existing last-resort attempt (not banned) is unchanged.

This only changes behavior when a genuine alternative field exists within
reach. When only one field is reachable, behavior is unchanged. No touch to
`MAX_HARVESTERS_PER_FIELD`, `LOW_STOCK_FRACTION`, `harvesterCap`, or any other
balance constant — a selection-order fix, not a rebalance.

## Verified, and what it actually bought

Re-ran the same headless-Chromium probe used to find the bug (`Multiplayer
AI`, `hard`, sampling one AI team's credits every 30 simulated seconds) with
and without the fix, same code otherwise:

- **Unfixed**: credits reach 1000 by t≈450s and never move again through
  t=600s — the captured baseline.
- **Fixed**: credits reach 1000 by t≈450s, then keep climbing — the armed
  factory is built by t≈480s (credits drop from ~1320 to 120, the 1200cr
  spend). Confirms the collapse this fix targets is gone.

## Found and not fixed: a second, unrelated freeze

Extending the funded-vs-unfunded comparison further (to t≈930s) surfaced a
second stall: credits flatline again, this time at 120cr, for 20+ minutes
straight, and no combat unit is ever built even though the armed factory now
exists. Inspecting both harvesters' internal state
(`harvesterAI.stateOf(inst)`) during that window found the actual cause: one
harvester sits in `to-base` with a full load, `hasOrder: true`, `blocked:
false`, at an **unchanged position** for the entire 400+ second sample
window; the other sits in `to-field` in the identical condition. Neither is
banned, neither is crowded out — they are simply not moving, despite
insisting they have a live order.

This is not caused by the field-selection fix above, and not made worse by
it. **Confirmed directly**: the identical failure signature — an order that
never resolves, `blocked: false`, zero displacement over 400+ seconds —
reproduces on the unmodified baseline too, with a different pair of
harvesters on a different part of the map. Restored the fix immediately
after confirming this; it is not implicated.

This is a vehicle-driving bug, not a field-selection one, and belongs to the
same class `harvester-collision-avoidance-study.md` already investigated: a
live order that quietly stops making progress with no built-in way to notice
or escalate. That study fixed one specific trigger (`_onAbandoned`'s
`TO_BASE` branch never banning its destination); this is evidently not the
same code path, since these two harvesters are in ordinary `to-base`/
`to-field` legs, not an abandoned-order recovery. Not investigated further
here — it is squarely outside a field-selection fix's scope, and diagnosing
a silent-stall-with-no-detour-escalation bug in the core drive loop deserves
its own investigation with its own telemetry, the way that study did, rather
than a guess bolted onto this change.

**This is the more consequential finding of the two.** The field-selection
fix genuinely works — it measurably delayed the first collapse and let the
armed factory get built where it never did before — but a real match still
never produces a single combat unit, because the harvester economy can
independently freeze solid downstream of it. Whoever picks this up next
should start from `harvesterAI.stateOf()` on a frozen harvester mid-match,
the same way this was found.

## Critical files

- `src/vehicles/harvesterAI.js` — the one change, inside `_idle`.
- `tests/harvester-field-selection.test.mjs` — dependency-free, four tests:
  two-fields-two-harvesters diversifies; one-field-two-harvesters still
  shares (unchanged); the existing crowd cap still applies when no untouched
  field exists; a negative control confirming the pre-fix code converges both
  harvesters on the same field.

## Verification

- `node --test tests/*.test.mjs` — 201 tests, all passing.
- `npx vite build` succeeds.
- Negative control: reverted the new tier inline, confirmed the
  two-fields-two-harvesters test fails because both harvesters land on the
  same field — the actual collapse condition.
- Driven in a real match twice (fixed and unfixed) as described above.
- Not fixed here, recorded above: the harvester-driving freeze that still
  blocks combat production even with this fix in place.
- Not verified: online multiplayer. This is client-local field-selection
  logic over already-synced state (fields, stock, harvester positions all
  already deterministic sim state) touching no `Math.random`/`Date.now`, but
  that is reasoning, not a two-client test run.
