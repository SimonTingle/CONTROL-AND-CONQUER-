# Performance plan: 30fps minimum, desktop + mobile

**Goal:** a consistent 30fps floor on both desktop and mobile. Mobile is currently ~10fps;
desktop is untested but shares every bottleneck below except pixel-ratio severity.

**How this plan is ordered:** each phase is sized by expected fps impact per unit of
engineering effort, based on a direct code audit (not guesswork) of the current renderer,
shaders, and scene composition. Do the phases in order — later phases assume earlier ones
already landed, and profiling after each phase will tell you whether you've hit 30fps yet
and can stop early.

**Read before starting Phase 0:** wireframe-rendering off-screen objects was considered and
ruled out. Off-screen vehicles/structures/terrain are already frustum-culled by Three.js
today (nothing is rasterized once outside the camera frustum), and even for on-screen
objects, mobile GPUs here are fragment-bound, not vertex-bound — wireframe changes primitive
assembly, not the fragment cost that's actually dominant (shadows, terrain shader, pixel
ratio). It doesn't appear in the phases below for that reason.

---

## Phase 0 — Instrumentation (do this first, before changing anything)

Every later phase's "did it work" check depends on being able to measure. Without this,
you're tuning blind.

- Add an on-screen fps/frame-time readout (min/avg/1%-low over a rolling window), gated
  behind a debug flag so it's easy to enable during testing and hide in the final build.
  `renderer.info.render` (already read for the existing dev stats readout in `main.js`) has
  draw-call and triangle counts — surface those alongside fps so you can tell *which* later
  phase actually moved the number, not just that "it's faster now."
- Establish a fixed benchmark scene per platform: same seed, same camera angle, same number
  of vehicles/structures on screen, same shadow-casting count. Desktop and mobile numbers
  are not comparable to each other without this — record both before Phase 1 as the baseline
  everything else is measured against.
- On mobile specifically, test on the actual lowest-spec device you intend to support, not
  just "a phone" — mobile GPU tiers vary by 5-10x, and DPR alone (see Phase 1) can swing
  results by 4x between two phones that look similar on paper.

**No code-behavior changes in this phase** — only measurement. Skippable only if you already
have reliable fps instrumentation; do not skip if you don't, because every phase after this
one is unverifiable without it.

---

## Phase 1 — Renderer-level settings (cheapest, biggest mobile win)

> **STATUS: COMPLETE.** Implemented, verified, committed.
>
> Added `src/core/platform.js` exporting `IS_MOBILE`, detected once via
> `matchMedia('(pointer: coarse)')` — the signal for "primary input is imprecise," which
> correctly excludes touch-screen laptops whose primary input is still a mouse/trackpad
> (a bare `'ontouchstart' in window` check would not). Falls back safely to `false` if
> `matchMedia` isn't available at all. `src/main.js`'s `WebGLRenderer` now sets
> `antialias: !IS_MOBILE` and caps pixel ratio at `IS_MOBILE ? 1 : 2`.
>
> Verified: `IS_MOBILE`'s logic checked directly against all three `matchMedia` outcomes
> (coarse pointer → true, fine pointer → false, no `matchMedia` → false) via a Node harness.
> Live in this desktop browser, confirmed `matchMedia('(pointer: coarse)').matches` reads
> `false` here as expected, and the renderer's actual WebGL context attributes/pixel ratio
> came back exactly as the desktop branch predicts (`antialias: true`, pixel ratio `2`) — no
> regression on desktop. The mobile branch itself needs confirming on a real touch device (or
> a browser mobile-emulation mode with full CDP touch/pointer emulation, which this session's
> preview tool doesn't provide — its "mobile" preset only resizes the viewport) before
> declaring the mobile fps win real; the code path is correct by construction and the
> Node-level logic check, but nothing here has watched the actual fps number move on mobile
> yet. Do that as part of Phase 5's re-baseline, or sooner if you have a device handy.

These are single-line-per-item changes with no visual-quality redesign required. Expected to
be the single largest mobile win in this whole plan, because DPR compounds every fragment
cost paid in every later phase.

- **Cap mobile pixel ratio below the current `min(devicePixelRatio, 2)`.** A phone at DPR 3
  is rendering 4x the fragments of DPR 1 today even after the existing cap. Drop to `1` (or
  `1.25`) on mobile specifically — keep desktop's cap as-is or raise it, since desktop GPUs
  aren't the constrained side. This is the highest fps-per-line-of-code change available.
- **Disable `antialias: true` on mobile.** MSAA is comparatively expensive on mobile
  tile-based GPUs. If edge aliasing bothers you after the DPR cut, consider a cheap post
  edge-smooth (FXAA) instead — it's a fraction of MSAA's cost — but try disabling outright
  first and see if it's even needed at the new, lower resolution.
- **Detect mobile vs desktop once at startup** (a simple UA/touch/GPU-tier check) and branch
  the settings above, rather than hand-picking one number for both platforms. This detection
  point is also where Phases 2-4's mobile-specific settings hook in, so build it now even
  though only pixel-ratio/antialias use it yet.

**Verify:** re-run the Phase 0 benchmark on both platforms. Expect a large mobile jump; a
smaller (or no) desktop change, since desktop wasn't DPR-constrained the same way.

---

## Phase 2 — Shadows (second-biggest expected win, mobile especially)

> **STATUS: PARTIALLY COMPLETE.** Filter/resolution split + settings toggle implemented,
> committed. Caster-set trimming (this phase's third bullet, below) deliberately deferred —
> out of scope for this pass, tracked as follow-up.
>
> Mobile now defaults to `THREE.BasicShadowMap` (no filtering) at 1024², desktop keeps
> `PCFSoftShadowMap` at 2048² — both driven off Phase 1's `IS_MOBILE`. Exposed live in the
> settings drawer as a "High-quality shadows" toggle (new "Performance" group,
> `controlSchema.js`) reading/writing `game.shadowQuality.high` via `game.setShadowQuality()`
> — either platform can override its default in either direction.
>
> One correctness subtlety caught and fixed during implementation, not obvious from the Three.js
> API surface: the shadow-filter algorithm (`SHADOWMAP_TYPE_*`) is a compile-time define baked
> into each material's shader program the first time it's used, not read live from
> `renderer.shadowMap.type` every frame. Setting the renderer property alone would only affect
> materials compiled *after* the toggle fires — every vehicle/structure already on screen would
> silently keep whatever filter was active at their own first render, making the toggle a no-op
> for anything already in the scene. Fixed by walking `world.scene` and setting
> `material.needsUpdate = true` on every current material inside `applyShadowQuality()`, forcing
> an immediate recompile so the toggle actually takes visible effect rather than only applying
> to future meshes.
>
> **Verification gap — closed.** Confirmed live in a running instance: desktop defaults are
> exactly right (`shadowMapType` 2 = `PCFSoftShadowMap`, 2048² map, `shadowQuality.high: true`
> from `pointer:coarse` reading `false`); calling `game.setShadowQuality(false)` correctly
> switches to `BasicShadowMap` (type 0), shrinks the map to 1024², and disposes the old shadow
> render target. The `needsUpdate` recompile fix genuinely works — verified all 169 scene
> materials' `.version` counters bumped after the toggle (checking `.needsUpdate` itself is a
> dead end: it's a write-only setter in Three.js with no getter, so reading it back is always
> `undefined` regardless of whether it was set — `.version` is the real signal). Rendered
> multiple frames at the switched setting and toggled back with zero console errors throughout.

The shadow pass was identified as the likely single biggest GPU cost on mobile: `PCFSoftShadowMap`
(multi-tap-per-fragment, the most expensive of Three's shadow filters) at 2048×2048, with
`castShadow` enabled broadly across nearly every vehicle sub-mesh, structure sub-mesh,
terrain, and crystal blooms.

- **Switch mobile to a cheaper shadow filter** — `THREE.BasicShadowMap` (no filtering) or at
  most `THREE.PCFShadowMap` (single-tap), not `PCFSoftShadowMap`. Keep the soft variant on
  desktop if you want, gated by the Phase 1 platform detection.
- **Shrink the shadow map resolution on mobile** — 2048² is a lot of depth-buffer fill and
  bandwidth for a mobile GPU. Try 1024² first; only go lower if quality suffers visibly at
  normal play distance.
- **Cut the caster set.** Not everything that currently has `castShadow = true` needs to:
  small trim details (lamp lenses, spot targets, individual light-bar segments) contribute
  shadow cost disproportionate to their visual shadow contribution. Keep hulls/cabins/turrets
  and terrain casting; consider dropping shadows from small fixed trim meshes, especially on
  vehicles at LOD tiers below "full" (see Phase 4).
- **Consider a shorter shadow camera frustum / tighter shadow-camera bounds** if not already
  tight — an oversized shadow frustum wastes map resolution on empty space, forcing a bigger
  map to get the same effective per-object shadow resolution near the player.

**Verify:** benchmark again. Expect this to be the second-largest mobile jump after Phase 1.
Watch for visible shadow-quality regression at normal play distance — if BasicShadowMap
looks too harsh, PCFShadowMap is the middle ground before reaching back for soft shadows.

---

## Phase 3 — Terrain fragment shader (fixed per-frame cost, independent of scene complexity)

This shader runs full-screen every frame regardless of camera angle or how many
vehicles/structures are on screen — it's a cost you pay unconditionally, which makes it a
priority even though it's more invasive to touch than Phases 1-2. It's also the likely
source of the recurring `MAX_FRAGMENT_UNIFORM_VECTORS(1024)` console warning seen in testing,
since it stacks ~30 custom uniforms on top of `MeshStandardMaterial`'s own PBR/lighting
uniform set.

- **Reduce fbm/noise octave counts on mobile.** The detail-noise layer alone runs 4 octaves
  (~28 hash evaluations per fragment); there's also a separate macro layer and a rock-strata
  layer. Cutting mobile to 2-3 octaves for detail (and considering dropping the strata layer
  on mobile entirely, or only evaluating it where the rock-blend factor is non-trivial) is a
  meaningful, visually-modest cut.
- **Audit whether the full PBR lighting chain is needed for terrain specifically**, or
  whether a cheaper (e.g. Lambert-style) lighting response reads acceptably for a
  matte, non-metallic ground material — PBR's IBL/environment sampling is not free, and
  terrain rarely needs specular realism the way a vehicle hull does.
- **Gate the buildability-overlay and construction-pad branches** (`if (uOverlay > 0.5)`,
  `if (uPadRadius > 0.0)`) so they compile out entirely on builds/platforms where they're
  never active, rather than branching on every fragment when inactive — a shader permutation
  (or at minimum an `#ifdef`) avoids paying branch-evaluation cost on every terrain fragment
  when the overlay isn't in use.
- **Confirm the fog-of-war texture sample is skipped whenever fog is fully revealed or
  disabled**, not sampled-and-multiplied-by-a-no-op every frame regardless of state.

**Verify:** benchmark again, on a save/scene where terrain fills most of the frame (this is
where the phase's effect concentrates). Compare visual terrain quality side-by-side at normal
play distance before committing to the reduced octave count — this is the one phase most
likely to need a quality/perf trade-off judgment call rather than being a free win.

---

## Phase 4 — Vehicle/structure draw-call and mesh reduction

Lower expected fps-per-effort than Phases 1-3, but addresses a real structural gap: vehicles
and structures build from many separate, non-merged `THREE.Mesh` objects (15-25+ per
vehicle — hull, wheels, turret, lights, trim, each its own draw call), while `blooms.js`
already demonstrates the pattern that avoids this (`InstancedMesh`, 728 crystals in one draw
call). Worth doing once Phases 1-3 have closed most of the gap, especially if a match with
many combat units still dips below 30fps.

- **Instance repeated sub-parts across vehicles of the same type** — wheels are the obvious
  candidate (every vehicle has 3-6+ identical wheel meshes; a fleet of a dozen vehicles is
  60+ wheel draw calls that could be one `InstancedMesh` per wheel-type). Turrets/barrels
  across same-def vehicles are a second candidate.
- **Merge static per-vehicle sub-meshes that share a material** (e.g. hull + cabin + fixed
  trim, where they don't need independent animation) into one `BufferGeometry` via
  `mergeGeometries`, cutting draw calls per vehicle without changing visual output — only
  worth doing for meshes that never move independently of the vehicle root.
- **Actually implement geometry/mesh-count reduction in the existing LOD tiers.** The current
  `updateVehicleLOD`-style system (distance-tiered at 40/100 units) only toggles headlamp
  visibility today — the tier names imply mesh reduction that isn't actually wired up. Make
  the MID/LOW tiers genuinely hide small trim meshes (lights, mirrors, antennae, individual
  light-bar segments) rather than only intensity/visibility flags on lights, and consider
  swapping to a lower-poly hull/wheel geometry at the LOW tier if triangle count (not just
  draw calls) is still a factor after instancing.
- **Add a frustum check to the existing distance-only LOD**, not just distance — a vehicle
  close to the camera but well outside the view cone currently gets full LOD treatment it
  doesn't need to.

**Verify:** benchmark a scene with a large fleet (a late-game multi-team AI match is the
natural stress case) before/after — this phase's effect scales with unit count, so a
small-scene benchmark will underrate it.

---

## Phase 5 — Re-baseline and decide if further work is needed

- Re-run Phase 0's benchmark scene on both platforms after Phases 1-4. If mobile and desktop
  both hold ≥30fps at the 1%-low (not just average) across the benchmark scene, stop here —
  further optimization has diminishing returns relative to feature work.
- If mobile still falls short, the next lever is content-side rather than renderer-side:
  reducing simultaneous on-screen vehicle count via stricter fog-of-war-driven culling,
  capping wreckage accumulation (already flagged as a known, unrelated cleanup item —
  permanent wreckage adds unbounded draw calls over a long match), or a hard vehicle-count
  cap in very large AI matches.
- If desktop still falls short after mobile is fixed, that's a signal the bottleneck isn't
  DPR/shadow-severity related (desktop was never as exposed to those) and warrants a fresh,
  desktop-specific profile rather than assuming the same fixes apply — CPU-side per-frame
  cost (JS tick logic, fog reveal loops, pathfinding) becomes the more likely suspect once
  the GPU-side items above are resolved.
