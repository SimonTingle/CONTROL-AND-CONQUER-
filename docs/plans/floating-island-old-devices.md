# The island that never loaded, and the vehicles left hovering

## The report

> "Playing on a slow device doesn't load island. The scout and base vehicle
> deploy floating above water. Can you duplicate this error by running in a
> limited resource environment? Could we detect user device and adjust game
> graphics somehow? Make game default zoom further away."
>
> "the original device i tested was an ipad air 2 (10 years old)"

## It was never a performance bug

"Slow device" and "old GPU" correlate, so the report reads as a performance
problem. It is not, and the shape of the symptom says so before any code is
read: **a performance failure is gradual and this one is total.** Frames do not
half-draw an island. Something was either supported or it was not.

`src/terrain/heightmap.js` uploaded the heightfield like this:

```js
this.texture = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.FloatType);
this.texture.magFilter = THREE.LinearFilter;
this.texture.minFilter = THREE.LinearFilter;
```

In WebGL2, `R32F` is **only linear-filterable with `OES_texture_float_linear`**.
Without that extension the texture is *incomplete* and every sample returns 0.
`src/terrain/terrainMaterial.js` samples this texture in the **vertex** stage to
displace the terrain grid, so the whole island flattened to y = 0 — beneath the
water plane, hence "doesn't load island". Meanwhile `heightAt()` reads
`this.data`, a Float32Array the GPU is not involved in, and went on returning
the true heights. Deploy logic put units on ground at y ≈ 48.5 that nothing was
drawing: "floating above water".

The class header claimed "One field, two consumers — CPU and GPU can never
disagree." They disagreed by 48 metres.

**three.js does not rescue this.** `three.module.js:24739` warns and then sets
the LINEAR filter anyway:

> `THREE.WebGLRenderer: Unable to use linear filtering with floating point
> textures. OES_texture_float_linear not supported on this device.`

The iPad Air 2's PowerVR GX6850 is exactly the generation that has WebGL2 but
not float-linear filtering.

## Reproduced

Not by throttling anything — by removing the one capability that mattered.
`scripts/old-device-probe.mjs` patches `getExtension` and
`getSupportedExtensions`, before any module loads, to hide
`OES_texture_float_linear` from every context the page creates. Against the code
as it was:

```
{ "hasWebGL2": true, "hasFloatLinear": false,
  "textureType": "FloatType(R32F)", "minFilter": "LinearFilter",
  "cpuHeightAtCentre": 48.52, "cpuHeightOffCentre": 50.96,
  "filterWarnings": ["THREE.WebGLRenderer: Unable to use linear filtering with
                     floating point textures…"] }
```

The CPU says the ground is at 48.5 and the GPU is told to draw it flat. That is
the entire bug in one object.

Worth stating plainly: **a throttled CPU would never have reproduced this.** The
request was to try a limited-resource environment, and doing so would have shown
a slow but perfectly correct island. The reproduction had to remove a
*capability*, which is also why the fix is a capability probe and not a
performance tier alone.

## The fix

### 1. Half-float, not float

`HalfFloatType` (R16F) is linear-filterable in **WebGL2 core**, with no
extension at all — so the requirement that failed is simply gone rather than
being detected and worked around.

The cost is precision. Half-float has an 11-bit mantissa, so the normalised
`[0,1]` field quantises to about 1/2048. At `amplitude: 90` that is **~4cm**,
against a vertex spacing of 2m (a 513² grid over 1024 world units) — two orders
of magnitude below the resolution of the mesh it displaces. Measured worst-case
divergence across the real field: **4.9e-4 normalised**, inside the 2⁻¹¹ bound.

`this.data` stays a `Float32Array`. Only the GPU's copy is quantised, so
gameplay, pathing, placement and determinism are untouched — nothing in
`src/net/` or `src/core/stateHash.js` sees a different number.

**The one hazard this introduced, and how it is closed.** The texture no longer
*wraps* `data`; it has its own `Uint16Array` mirror. `terraform.js` and
`craters.js` both edit `data` in place and used to signal the upload with a bare
`texture.needsUpdate = true`, which worked only because of that shared
reference. Left alone they would have uploaded stale ground — the same
CPU/GPU divergence, reintroduced quietly by the fix for it. All three call sites
now call `heightmap.syncTexture(i0, j0, i1, j1)`, which re-encodes just the
edited rectangle. A test asserts that digging a crater actually syncs.

A capability fallback remains: if even half-float linear filtering is missing,
the filter degrades to `NEAREST`. That gives a faceted island rather than no
island. The failure mode should never again be a blank sea.

### 2. A startup quality tier

New `src/core/deviceTier.js`. Before this, the only startup signal was
`IS_MOBILE` — a `(pointer: coarse)` media query — so a 2014 iPad and an M4 iPad
Pro started with identical settings, and the old one was walked down only
afterwards by `autoQuality`, over several seconds of bad frames.

It asks the **GL context**, never the user-agent string:
`OES_texture_float_linear`, WebGL2, `MAX_TEXTURE_SIZE`,
`MAX_VERTEX_TEXTURE_IMAGE_UNITS`, plus `navigator.deviceMemory` and
`hardwareConcurrency` where present. The probe runs once, on a throwaway canvas,
because the renderer needs `antialias` at construction and so cannot itself be
the context we ask.

`floatLinear` is treated as decisive on its own — not because we still need
float filtering (part 1 removed that need) but because a GPU missing it is
without exception a decade-old part, and it is the one signal available in
Safari, where `deviceMemory` is not implemented at all. Absent signals are
treated as absent, never as bad; a test pins that.

| tier | pixel ratio cap | antialias | shadows |
|---|---|---|---|
| low | 1 | off | basic/1024 |
| medium | 1 mobile, 1.5 desktop | off | soft/2048 |
| high | 2 | on | soft/2048 |

Medium deliberately keeps a mobile device at pixel ratio 1, which is exactly the
measured pre-existing `IS_MOBILE` behaviour. Introducing a middle tier must not
quietly raise mobile to 1.5, and a test asserts it does not.

Two constraints, both load-bearing:

- **The tier is a starting point, not a ceiling.** `autoQuality` — with the
  dwell and backoff added in the dusk-flashing work — still owns adaptation from
  there, unchanged.
- **It never touches `renderQuality.userForced` or `shadowQuality.userForced`.**
  Those mean "the player chose this themselves", after which auto-quality backs
  off. The tier applies before any such choice can exist, so a tier that set them
  would permanently disable adaptation while pretending to be the player. A test
  asserts `tierSettings` returns no such flag.

The tier and the capabilities behind it are logged at startup and shown on the
perf HUD's device line, for the same reason the `IS_MOBILE` log exists: a real
device can report what it detected without devtools attached.

### 3. Default camera distance 26 → 40

`src/core/chaseCamera.js`. The player's call. `MIN_DISTANCE`/`MAX_DISTANCE`
(8/160) are unchanged — only the starting point moves — and there is one
construction site, `main.js`, which passes no `distance`.

Not incidental to this bug: at 26 the viewport was close enough that "is there
any ground here at all?" was off screen at the moment of first deploy.

### 4. The itch.io fork

`itch.io/` is a deliberate fork of the frontend and does not follow the root
automatically — and an iPad player is precisely its audience, so leaving the bug
there would have left the reporting player unfixed. Synced with
`itch.io/sync-from-main.sh`, whose dry run showed only these six files differing.

## Verification

**`npm test` — 500 tests, 13 new, dependency-free.** `tests/device-tier.test.mjs`
asserts the property that was violated rather than the spelling of the fix: that
the heightmap's texture type is one that is filterable **without an extension**,
checked against a set that deliberately excludes `FloatType`. Also: GPU/CPU
agreement across the real field, that an in-place edit reaches the texture, the
tier classifications, and the camera default within an unchanged zoom range.

**Six negative controls**, each by surgical edit, each failing behaviourally and
naming the right test:

| reverted | fails |
|---|---|
| `HalfFloatType` → `FloatType` | the filterable-type test |
| `syncTexture`'s conversion loop emptied | GPU/CPU agreement + in-place edit |
| `classify` ignores `floatLinear` | the low-tier test and the probe test |
| `DEFAULT_DISTANCE` 40 → 26 | the camera test |
| medium's mobile pixel-ratio branch | the mobile-DPR test |
| craters back to bare `needsUpdate` | the crater sync assertion |

**`scripts/old-device-probe.mjs`** — a real module graph, real renderer, real
513² heightmap, run twice: once with `OES_texture_float_linear` hidden and once
unmodified. All 12 checks pass. With the extension hidden: no three.js filtering
warning, texture half-float, filter still LINEAR, GPU/CPU worst delta 4.9e-4,
tier `low` with DPR 1 / no AA / basic shadows, camera at 40, no page errors. The
unmodified machine is unaffected. Its own negative control: reverting the
texture to `FloatType` brings the exact warning back and turns three checks red.

`npm run build` passes at the root and in `itch.io/`.

## Honest limits

- **I do not have an iPad Air 2, and there is no GPU here.** The reproduction
  hides the extension from a headless Chromium, which produces the precise
  three.js warning and the precise CPU/GPU divergence. That is strong evidence
  about the mechanism; it is not the same as seeing the island come back on the
  device. **That needs the player.**
- The tier thresholds (`deviceMemory`, `hardwareConcurrency`, `MAX_TEXTURE_SIZE`)
  are reasoned defaults, not measured against a fleet of devices. They are named
  constants. The one signal that is actually evidence-backed here is
  `floatLinear`.
- This machine classifies **medium**, not high, so the `high` path is exercised
  only by unit tests with injected capabilities, not by the browser probe.
- **Not investigated:** whether the iPad Air 2 is *also* too slow to play once
  the island renders. The tier gives it the most conservative settings the game
  has, but a device that old may still be under 30fps, and that is a separate
  question this change does not answer.
- **Not changed:** `src/core/platform.js`'s `IS_MOBILE` remains, now as one input
  to the tier among several rather than the sole startup signal.
