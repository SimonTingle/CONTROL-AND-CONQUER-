# AI base spawn: the degenerate fallback ignored the team's slice entirely

## Context

Asked what governs where an AI (or human) team's base is placed in a
multi-team match, the answer traced to `findTeamSpawnPoints` in
`src/core/pick.js`: each team gets an equal compass slice of the map, and
`findEdgeSpawnPointAtAngle` marches inland from the map edge along that
bearing looking for dry, gentle-enough ground.

Reading that function turned up a fallback its own comment already named as
a compromise: if the *entire* line from edge to centre along one exact
bearing never touches dry land, it gives up and returns the map centre,
unconditionally — no check that the centre is even dry, and no relationship
to the team or slice that asked for it.

## Why this is a real bug, not just an accepted edge case

`findTeamSpawnPoints` doesn't call `findEdgeSpawnPointAtAngle` once per
team — it tries 7 angular nudges within the team's slice
(`[0, ±0.18, ±0.34, ±0.48]` of the slice width) and keeps whichever nudge's
result has the best *clearance* from bases already placed for earlier teams,
via a plain distance comparison:

```js
const clearance = placed.length
  ? Math.min(...placed.map((p) => Math.hypot(p.point.x - found.point.x, p.point.z - found.point.z)))
  : Infinity;
if (clearance > bestClearance) { bestClearance = clearance; best = found; }
```

That comparison has no way to tell a genuine coastal point from the
degenerate map-centre fallback — it only measures distance. Bases already
placed for other teams are, by construction, out near the coastline; the map
centre is typically *farther* from all of them than another coastal point in
the same slice would be. So if even one of the 7 nudge bearings happens to
be fully underwater (a bay cutting straight through, or a sufficiently
irregular coastline), the degenerate centre point can look like the
*best-separated* candidate and win the comparison outright — pulling a
team's base to world origin, possibly underwater, and definitely outside the
slice the whole placement scheme exists to keep it in.

This was found by reading, not by reproducing it against the game's actual
procedural terrain — the existing code comment already frames the case as
"a fully-flooded map," which the real terrain generator may or may not ever
produce. It's recorded as a real gap in the logic regardless of how often it
fires in practice.

## The fix

`findEdgeSpawnPointAtAngle` gained an optional `sliceHalfWidth` parameter
(radians, default `0`). When the primary bearing's march finds nothing dry
at all, and a nonzero slice half-width was given, it now sweeps outward from
the original bearing in both directions — up to the slice boundary, never
past it — re-running the same edge-to-centre march at each test angle. The
first dry point found this way is accepted, then pulled 20 world units
further inland along that same test angle (`SPAWN_DEGENERATE_INLAND`) rather
than left sitting on the waterline. Only if nothing anywhere in the slice is
dry does it fall through to the original map-centre return.

`findTeamSpawnPoints`'s one call site now passes `slice / 2` — the search
can reach exactly to this team's own slice boundary and no further, matching
the "never let a nudge cross into a neighbouring slice" rule already
enforced one level up by how the nudge angles themselves are computed.

`findEdgeSpawnPoint(camera)` — the single-player/scout edge-spawn path with
no team or slice concept — was left untouched; it never passes the new
parameter, so a fully-underwater bearing there still falls straight to the
centre exactly as before. There's no slice to bound a sweep to in that case,
and fixing it wasn't requested.

`SPAWN_DEGENERATE_INLAND = 20` was chosen to match the coarse end of the
existing grade probes (`GRADE_PROBE_DISTS`, up to 12) rather than the
larger, vehicle-scale spawn-near radii used elsewhere in the file — this is
choosing a point on a coastline, not clearing room around an existing
vehicle.

## Verification

- **`tests/team-spawn-points.test.mjs`** (new): a synthetic heightmap
  (`{params, seaLevelY, heightAt}}`, no terrain generator) with a wedge of
  underwater angles around bearing 0, including the centre point itself.
  - A wedge narrower than the given slice half-width: the fallback finds dry
    land and does not return the centre.
  - The point returned is inland of the coastline radius it found (distance
    from centre is less than the max search radius), not sitting on the
    waterline.
  - A wedge *wider* than the slice half-width: every angle the sweep is
    permitted to try is still wet, and it correctly still degenerates to the
    centre — the sweep must not search past its bound.
  - No `sliceHalfWidth` argument at all (the camera-based caller's shape):
    unchanged old behaviour, straight to centre.
  - `findTeamSpawnPoints` end-to-end with a narrower wedge: every one of 4
    teams' placed bases lands on dry ground.
  - Negative control: stashed the fix (`git stash push -- src/core/pick.js`),
    reran the suite — the "sweeps within its slice" and the
    `findTeamSpawnPoints` end-to-end tests failed with the expected
    behavioural assertions (`'landed on dry ground'`,
    `'every placed team starts on dry ground'`), not an import or syntax
    error — then restored the fix (`git stash pop`) and confirmed all 5
    pass again.
- `node --test tests/*.test.mjs`: 34/34 (29 pre-existing + 5 new) — ordinary,
  non-degenerate team spawn placement is unaffected.

Not verified: whether the game's actual procedural terrain generator (as
opposed to the synthetic heightmap here) is capable of producing a bearing
degenerate enough to exercise this path at all, in single-player, AI, or
online multiplayer. This closes the gap in the logic for if/when it does,
without claiming to have observed it happen in a real match.
