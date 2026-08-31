/**
 * Measure one build's frame cost, reproducibly, so a regression can be
 * bisected instead of argued about.
 *
 * ## Why this exists
 *
 * A ~50% FPS drop appeared across the 2026-08-25 commits and the candidate
 * causes have different signatures — a fixed per-frame tax, a periodic
 * re-bake hitch, and an unbounded leak all "feel" like the game got slower.
 * Guessing between them wastes the fix. This runs the game's own
 * `?benchmark=<n>` scene (fixed seed, fixed camera, deterministic vehicle
 * grid) under headless Chromium and prints one JSON blob per build.
 *
 * ## Two things that will silently corrupt the numbers if you skip them
 *
 * 1. **autoQuality fights the measurement.** Below 25fps it drops the pixel
 *    ratio to 1, thickens fog 2.2x, and calls `audio.setLowPower(true)` —
 *    which shrinks the voice pools 24->10 and 16->6. A slow build therefore
 *    measures itself doing *less work at lower resolution*, compressing the
 *    very gap being measured. It is stubbed out below, and the pixel ratio is
 *    pinned, so every build is measured in the same regime.
 *
 * 2. **The AudioContext may never start.** Audio initialises at module load
 *    but stays suspended until a real gesture calls `audio.resume()` (see
 *    main.js's canvas pointerdown handler). Headless with the autoplay policy
 *    relaxed usually starts it anyway, but "usually" is how you exonerate the
 *    audio system by accident. This asserts `contextState === 'running'` and
 *    records it in the output; if it is suspended, every audio number below is
 *    meaningless and the run should be discarded.
 *
 * ## Reading the output
 *
 * `simStepsPerFrame` matters: the sim runs fixed-step and can catch up to 5
 * times per rendered frame, while TickProfiler averages per *call*. A sim
 * segment's avgMs understates its per-frame cost by roughly this factor.
 *
 * Every field is probed defensively and comes back `null` if absent — this is
 * run against commits from before some of these debug handles existed, and a
 * missing handle must not abort the bisect.
 *
 * Usage:
 *   node scripts/perf-bisect.mjs --port 5199 [--vehicles 40] [--sample 20]
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const PORT = Number(args.port ?? 5199);
const VEHICLES = Number(args.vehicles ?? 40);
const WARMUP_MS = Number(args.warmup ?? 6000);
const SAMPLE_MS = Number(args.sample ?? 20) * 1000;
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Playwright is a dev-only dependency and deliberately not in package.json —
 * CLAUDE.md keeps `npm test` dependency-free and this script is not part of it.
 * Resolve a local install if there is one, otherwise fall back to a global one
 * (which is how this sandbox has it). PLAYWRIGHT_PATH overrides both.
 */
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs',
    '/usr/local/lib/node_modules/playwright/index.mjs',
  ].filter(Boolean);
  const tried = [];
  for (const spec of candidates) {
    try {
      return await import(spec);
    } catch (e) {
      tried.push(`${spec}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(`Could not load playwright. Tried:\n  ${tried.join('\n  ')}`);
}

const { chromium } = await loadPlaywright();

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: [
    '--no-sandbox',
    // Without this the AudioContext stays suspended and the whole audio
    // subsystem measures as free — see the header.
    '--autoplay-policy=no-user-gesture-required',
    // Headless Chromium will happily fall back to a software rasteriser, which
    // makes GPU-bound work look like CPU work and varies run to run. Ask for
    // the real thing and report what we got.
    '--use-gl=angle',
    '--enable-gpu',
  ],
});

/**
 * Deliberately small by default. This sandbox has no GPU, so headless Chromium
 * falls back to SwiftShader and at 1280x800 roughly 810ms of every 817ms frame
 * is software rasterisation — which swamps every CPU-side difference this
 * script exists to detect, and drags the frame rate to ~1.2fps where dt is so
 * large that dt-dependent sim logic stops behaving like it does at 60fps.
 * Shrinking the viewport cuts fill cost until CPU work is visible again.
 *
 * Consequence to keep in mind when reading results: absolute fps from this
 * script is meaningless as a prediction of real hardware. What is meaningful is
 * the *comparison* between two builds measured identically, and above all the
 * per-section CPU numbers in `profiler`, which are what actually regress.
 */
const page = await browser.newPage({
  viewport: { width: Number(args.width ?? 480), height: Number(args.height ?? 360) },
});
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/?benchmark=${VEHICLES}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});

// The benchmark scene spawns on the second rAF after load; give it real time
// to build terrain and vehicles before touching anything.
await page.waitForTimeout(4000);

// --- pin the measurement regime -------------------------------------------
const setup = await page.evaluate(() => {
  const out = { stubbedAutoQuality: false, resumedAudio: false, pinnedPixelRatio: null };

  // Stop autoQuality from changing resolution/fog/audio-pool size underneath
  // the measurement. Keep the object so `.low` can still be read.
  //
  // Stubbing alone is not enough and the first trial run proved it: by the time
  // this executes, autoQuality has usually ALREADY tripped to low — headless
  // startup is slow enough to cross the 25fps threshold — which shrank the
  // engine-loop pool 16 -> 6. Measuring there compares builds in the degraded
  // regime and understates exactly the per-vehicle audio cost under
  // investigation. So force the full-quality regime back on after stubbing.
  if (window.__autoQuality) {
    window.__autoQuality.update = () => {};
    window.__autoQuality.low = false;
    if (window.__autoQuality.samples) window.__autoQuality.samples.length = 0;
    out.stubbedAutoQuality = true;
  }
  try {
    window.__audio?.setLowPower?.(false);
    // panningModel is only set when a loop is *created*, so the loops that
    // already exist would keep the cheap 'equalpower' path while newly-created
    // ones get HRTF — a mixed regime that differs per build depending on how
    // early autoQuality tripped. Tear them all down; updateEngineAudio rebuilds
    // them uniformly at full quality within a frame or two.
    for (const key of window.__audio?.activeLoopKeys?.() ?? []) {
      window.__audio.stopEngineLoop(key);
    }
    out.forcedFullAudio = true;
  } catch (e) {
    out.audioLowPowerError = String(e);
  }
  if (window.renderer?.setPixelRatio) {
    window.renderer.setPixelRatio(1);
    out.pinnedPixelRatio = window.renderer.getPixelRatio?.() ?? null;
  }

  // The gesture main.js waits for. Calling resume() directly is equivalent and
  // does not depend on synthesising a trusted pointer event.
  try {
    window.__audio?.resume?.();
    out.resumedAudio = true;
  } catch (e) {
    out.audioResumeError = String(e);
  }

  // Close the vehicle drawer. The benchmark scene leaves it open, and its
  // update() does a full WebGLRenderer.render() plus a drawImage *per card,
  // per frame* — ~50ms/frame here, an order of magnitude above every other CPU
  // segment. That is real, but it is not gameplay: a player does not drive with
  // the drawer open, and leaving it open swamps the signal this script exists
  // to find. Measure the closed state and note the open-drawer cost separately.
  try {
    window.vehiclePicker?.setOpen?.(false);
    out.closedVehiclePicker = window.vehiclePicker?.open === false;
  } catch (e) {
    out.vehiclePickerError = String(e);
  }

  if (window.__tickProfiler) window.__tickProfiler.enabled = true;
  return out;
});

await page.waitForTimeout(WARMUP_MS);

// --- start the clean window -----------------------------------------------
await page.evaluate(() => {
  window.__tickProfiler?.reset?.();
  if (window.perfHud?.samples) window.perfHud.samples.length = 0;

  // Our own frame-time recorder, independent of perfHud (which only records
  // while visible) so this still works on builds where the HUD behaves
  // differently.
  window.__perfProbe = { frames: [], last: performance.now(), stop: false };
  const tick = () => {
    if (window.__perfProbe.stop) return;
    const now = performance.now();
    window.__perfProbe.frames.push(now - window.__perfProbe.last);
    window.__perfProbe.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Snapshot the counters we want a *rate* for, not a total.
  const a = window.__audio?.debugState?.();
  window.__perfProbe.startAmbienceSegments = a?.ambienceSegmentsPlayed ?? null;
  window.__perfProbe.startedAt = performance.now();
});

await page.waitForTimeout(SAMPLE_MS);

// --- collect ---------------------------------------------------------------
const result = await page.evaluate(() => {
  window.__perfProbe.stop = true;
  const elapsedS = (performance.now() - window.__perfProbe.startedAt) / 1000;

  // Drop the first few frames: the rAF chain's own first interval includes the
  // gap since the previous frame, which is not a frame time.
  const frames = window.__perfProbe.frames.slice(3);
  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
  const mean = frames.length ? frames.reduce((s, v) => s + v, 0) / frames.length : null;

  const audio = window.__audio?.debugState?.() ?? null;
  const startSeg = window.__perfProbe.startAmbienceSegments;
  const info = window.renderer?.info?.render ?? null;

  return {
    frameCount: frames.length,
    elapsedS: Number(elapsedS.toFixed(2)),
    // Mean frame time is the honest headline; fps is derived from it rather
    // than averaged per-frame (averaging fps overweights fast frames).
    frameMsAvg: mean === null ? null : Number(mean.toFixed(3)),
    frameMsMedian: pct(0.5) === null ? null : Number(pct(0.5).toFixed(3)),
    frameMsP99: pct(0.99) === null ? null : Number(pct(0.99).toFixed(3)),
    frameMsWorst: sorted.length ? Number(sorted[sorted.length - 1].toFixed(3)) : null,
    fpsAvg: mean ? Number((1000 / mean).toFixed(1)) : null,
    // The 1% low is the stutter metric — a periodic re-bake shows up here and
    // barely moves the average.
    fps1PctLow: pct(0.99) ? Number((1000 / pct(0.99)).toFixed(1)) : null,

    drawCalls: info?.calls ?? null,
    triangles: info?.triangles ?? null,
    programs: window.renderer?.info?.programs?.length ?? null,
    sceneChildren: window.world?.scene?.children?.length ?? null,

    profiler: window.__tickProfiler?.report?.() ?? null,

    audioContextState: audio?.contextState ?? null,
    engineLoopCount: audio?.loopCount ?? null,
    cachedBuffers: audio?.cachedBuffers ?? null,
    // Rate, not total: this is the ambience re-bake frequency, the thing that
    // would explain a periodic hitch.
    ambienceSegmentsPerMin:
      audio && startSeg !== null && elapsedS > 0
        ? Number((((audio.ambienceSegmentsPlayed - startSeg) / elapsedS) * 60).toFixed(2))
        : null,

    autoQualityLow: window.__autoQuality?.low ?? null,
    pixelRatio: window.renderer?.getPixelRatio?.() ?? null,
    vehicleCount: window.vehicles?.instances?.length ?? null,
  };
});

await browser.close();

// Headline first, so a bisect loop's output stays readable without scrolling
// past 20 profiler rows. The `regime` line is the one to check before trusting
// any comparison: two runs measured in different regimes are not comparable.
const top = (result.profiler ?? []).slice(0, 6)
  .map((s) => `${s.name}=${s.avgMs.toFixed(2)}ms`).join('  ');
console.error(
  `\n  fps ${result.fpsAvg}  (1% low ${result.fps1PctLow})  ` +
  `frame ${result.frameMsAvg}ms med ${result.frameMsMedian}ms p99 ${result.frameMsP99}ms\n` +
  `  regime: pixelRatio=${result.pixelRatio} autoQualityLow=${result.autoQualityLow} ` +
  `audio=${result.audioContextState} loops=${result.engineLoopCount} vehicles=${result.vehicleCount}\n` +
  `  draws=${result.drawCalls} tris=${result.triangles} sceneChildren=${result.sceneChildren} ` +
  `ambience/min=${result.ambienceSegmentsPerMin}\n` +
  `  top: ${top}\n`
);

// stdout stays pure JSON so a bisect driver can parse it.
console.log(JSON.stringify({ ...result, setup, pageErrors: pageErrors.slice(0, 5) }, null, 2));
