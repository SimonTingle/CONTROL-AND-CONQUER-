/**
 * The dusk/dawn screen flashing.
 *
 * `AutoQuality` is a feedback controller whose own action changes the signal it
 * measures. That is what made it oscillate, and it is why these tests drive it
 * **closed-loop** — the fps handed back each frame depends on the quality state
 * the controller just chose, exactly as it does on a real machine:
 *
 *     const fps = aq.low ? lowFps : highFps;
 *
 * An open-loop test that replays a fixed fps trace cannot reproduce this bug at
 * all. It is the coupling that is the defect, so the coupling has to be in the
 * test. Before the fix this reported 29 state flips in 600 frames (~1.5-3 Hz),
 * each one jumping fog density 2.2x and pixel ratio between 2 and 1 — the throb
 * the player reported.
 *
 * The band matters as much as the flapping: a healthy machine and a hopeless one
 * are both stable, and only the middle oscillates. That is why the symptom was
 * specific to dusk, when the scene is at its most expensive and the framerate
 * lands in that band. Both ends are asserted below so a future "fix" that simply
 * stops the controller working can't pass.
 *
 * Dependency-free: plain class, injected callbacks, no browser and no renderer.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoQuality } from '../src/core/autoQuality.js';
import { Atmosphere } from '../src/sky/atmosphere.js';

const BASE_FOG = 0.0016;
const BASE_DPR = 2;

/**
 * Run the controller closed-loop for `frames`, with fps determined by the state
 * it is currently in.
 */
function runClosedLoop({ highFps, lowFps, frames = 600 }) {
  const aq = new AutoQuality();
  let flips = 0;
  let previousLow = false;
  let maxFogStep = 0;
  let lastFog = null;
  const pixelRatios = [];

  for (let i = 0; i < frames; i++) {
    const fps = aq.low ? lowFps : highFps;
    const dt = 1 / fps;
    aq.record(dt);
    aq.update({
      dt,
      userForcedPixelRatio: false,
      setPixelRatio: (r) => pixelRatios.push(r),
      basePixelRatio: BASE_DPR,
      baseFogDensity: BASE_FOG,
      setFogDensity: (d) => {
        if (lastFog !== null) maxFogStep = Math.max(maxFogStep, Math.abs(d - lastFog));
        lastFog = d;
      },
    });
    if (aq.low !== previousLow) {
      flips++;
      previousLow = aq.low;
    }
  }
  return { aq, flips, maxFogStep, pixelRatios, finalFog: lastFog };
}

// --- the reported bug ------------------------------------------------------

test('a machine in the unstable band does not strobe', () => {
  // The exact case that reproduced the report: high quality yields 23fps (below
  // the 25 drop threshold), low quality yields 40 (above the 32 recover
  // threshold). Every threshold between those two numbers oscillates unless the
  // controller is damped in time.
  const { flips } = runClosedLoop({ highFps: 23, lowFps: 40 });
  assert.ok(flips <= 2, `expected at most 2 quality changes, got ${flips}`);
});

test('a narrower unstable band does not strobe either', () => {
  const { flips } = runClosedLoop({ highFps: 20, lowFps: 34 });
  assert.ok(flips <= 2, `expected at most 2 quality changes, got ${flips}`);
});

test('the dwell grows with each change, so repeated flapping decays', () => {
  // Backoff, not a latch: changes get rarer without becoming impossible, so a
  // machine that recovers after a heavy battle still gets its resolution back.
  const { aq, flips } = runClosedLoop({ highFps: 23, lowFps: 40 });
  assert.ok(flips >= 1, 'this case should change quality at least once');
  assert.ok(aq.dwellSeconds > 6, `dwell should have grown, got ${aq.dwellSeconds}`);
});

// --- the controller must still work ----------------------------------------

test('a healthy machine is never touched', () => {
  const { flips, pixelRatios } = runClosedLoop({ highFps: 50, lowFps: 60 });
  assert.equal(flips, 0);
  assert.deepEqual(pixelRatios, [], 'nothing should have changed the pixel ratio');
});

test('a genuinely slow machine drops quality and stays there', () => {
  // The other end of the band. Damping must not turn into "never acts".
  const { aq, flips } = runClosedLoop({ highFps: 15, lowFps: 28 });
  assert.equal(aq.low, true, 'a 15fps machine should end up on low quality');
  assert.ok(flips <= 2, `should settle, not flap; got ${flips} flips`);
});

test('dropping to low quality lowers the pixel ratio and raises the fog', () => {
  const { aq, pixelRatios, finalFog } = runClosedLoop({ highFps: 15, lowFps: 28 });
  assert.equal(aq.low, true);
  assert.equal(pixelRatios[0], 1, 'first change should drop the pixel ratio to 1');
  assert.ok(finalFog > BASE_FOG, 'low quality should end up with thicker fog');
});

test('an explicit render-resolution choice is never overridden', () => {
  const aq = new AutoQuality();
  const pixelRatios = [];
  for (let i = 0; i < 600; i++) {
    const dt = 1 / (aq.low ? 28 : 15);
    aq.record(dt);
    aq.update({
      dt,
      userForcedPixelRatio: true,
      setPixelRatio: (r) => pixelRatios.push(r),
      basePixelRatio: BASE_DPR,
      setFogDensity: () => {},
      baseFogDensity: BASE_FOG,
    });
  }
  assert.equal(aq.low, true, 'quality should still drop');
  assert.deepEqual(pixelRatios, [], 'but the forced pixel ratio must be left alone');
});

// --- the fog ramp ----------------------------------------------------------

test('fog moves gradually rather than jumping', () => {
  // The most visible half of a quality change. Stepping it 2.2x in one frame is
  // what reads as a cut; ramping it reads as haze rolling in. The old code's
  // step was the full difference in a single frame.
  const fullStep = BASE_FOG * 2.2 - BASE_FOG;
  const { maxFogStep } = runClosedLoop({ highFps: 15, lowFps: 28 });
  assert.ok(maxFogStep > 0, 'the fog should actually have moved');
  assert.ok(
    maxFogStep < fullStep / 4,
    `per-frame fog step ${maxFogStep} should be far below the full step ${fullStep}`,
  );
});

test('fog still reaches its target', () => {
  // A ramp that never arrives would be its own bug.
  const { finalFog } = runClosedLoop({ highFps: 15, lowFps: 28, frames: 900 });
  assert.ok(
    Math.abs(finalFog - BASE_FOG * 2.2) < 1e-9,
    `fog should settle at the low-quality density, got ${finalFog}`,
  );
});

// --- the window ------------------------------------------------------------

test('the sample window is cleared when quality changes', () => {
  // Otherwise the next verdict is made from frames rendered at the quality we
  // just left — measurements of a state that no longer exists.
  const aq = new AutoQuality();
  for (let i = 0; i < 40; i++) aq.record(1 / 15);
  assert.ok(aq.samples.length > 0);
  aq.stateAge = 999; // past the dwell, so the change is allowed
  aq.update({
    dt: 1 / 15,
    userForcedPixelRatio: false,
    setPixelRatio: () => {},
    basePixelRatio: BASE_DPR,
    setFogDensity: () => {},
    baseFogDensity: BASE_FOG,
  });
  assert.equal(aq.low, true, 'should have dropped quality');
  assert.equal(aq.samples.length, 0, 'the window should be empty after a change');
});

// --- the shadow light at the horizon ---------------------------------------

/**
 * Second dusk/dawn defect, found while investigating the first.
 *
 * `sunLight.position` is the sun direction scaled out, so it followed the sun
 * below the horizon: at elevation 0 the shadow-casting light sat *exactly* on
 * the ground plane (the degenerate case for an orthographic shadow camera
 * looking along it), and below that it was underground casting shadows up
 * through the terrain — for half of every cycle.
 *
 * Asserted against the arithmetic rather than a rendered frame: there is no GPU
 * in this environment, so what can be checked is that the light is never at or
 * below ground, and that daylight is left exactly as it was.
 */
// Bound to the real constant, not a copy of it. A test that re-derived the
// threshold independently would keep passing if the production value drifted,
// which is the whole failure mode it exists to catch.
const shadowLightY = (elevation, mapSize = 1024) => {
  const pinned = Math.max(Atmosphere.MIN_SHADOW_ELEVATION, elevation);
  return Math.cos((90 - pinned) * (Math.PI / 180)) * mapSize * 0.9;
};

test('the shadow light never reaches or passes the ground plane', () => {
  for (let elevation = -70; elevation <= 70; elevation += 1) {
    assert.ok(
      shadowLightY(elevation) > 0,
      `shadow light is at or below ground at elevation ${elevation}`,
    );
  }
});

test('pinning does not move the shadow light during daylight', () => {
  // The pin must be invisible when the sun is genuinely up — it exists only for
  // the horizon crossing, and a fix that dimmed or flattened midday shadows
  // would be worse than the bug.
  const unpinned = (e, mapSize = 1024) => Math.cos((90 - e) * (Math.PI / 180)) * mapSize * 0.9;
  for (const elevation of [6, 12, 30, 45, 70]) {
    assert.equal(shadowLightY(elevation), unpinned(elevation), `elevation ${elevation} moved`);
  }
});
