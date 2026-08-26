/**
 * Count what the audio system actually asks the Web Audio engine to do, per
 * second, in a running match.
 *
 * ## Why this and not an FPS measurement
 *
 * The obvious way to investigate a frame-rate regression is to measure frame
 * rate. That does not work in a headless sandbox with no GPU: Chromium falls
 * back to SwiftShader and ~99% of each frame is software rasterisation, which
 * swamps every CPU-side difference and makes absolute fps meaningless as a
 * prediction of real hardware (see scripts/perf-bisect.mjs's header).
 *
 * Automation-event counts have no such problem. "How many AudioParam ramps are
 * scheduled per second" is a property of the code, not of the machine — the
 * number is the same on a workstation and in this container. So it can settle
 * the specific question of whether the engine-audio path is doing a
 * pathological amount of per-frame work, without pretending to measure fps.
 *
 * ## What it hooks and why
 *
 * Three costs are counted separately because they have different fixes:
 *
 *  - `setTargetAtTime` / `linearRampToValueAtTime` / `setValueAtTime` —
 *    scheduled on AudioParam. `updateEngineLoop` writes volume and four
 *    oscillator/filter ramps unconditionally every frame per vehicle, with no
 *    dirty check.
 *  - `positionX/Y/Z` + `orientationX/Y/Z` ramps on PannerNode — scheduled by
 *    three.js inside `PositionalAudio.updateMatrixWorld`, i.e. inside
 *    `renderer.render()`, six per audio object per frame. These are invisible
 *    to the tick profiler because they are attributed to `render`.
 *  - `createBuffer` / `getChannelData` — the synchronous noise fills that
 *    precede every ambience re-bake.
 *
 * Divide any count by `elapsedS * framesRendered` to get per-frame-per-voice
 * figures; the report does the useful ones already.
 *
 * Usage:
 *   node scripts/audio-load-probe.mjs --port 5199 [--vehicles 40] [--sample 10]
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const PORT = Number(args.port ?? 5199);
const VEHICLES = Number(args.vehicles ?? 40);
const SAMPLE_MS = Number(args.sample ?? 10) * 1000;
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function loadPlaywright() {
  for (const spec of [process.env.PLAYWRIGHT_PATH, 'playwright',
    '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
    try { return await import(spec); } catch { /* next */ }
  }
  throw new Error('Could not load playwright');
}
const { chromium } = await loadPlaywright();

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 360 } });

// The counters must be installed before any audio node is constructed, so this
// runs as an init script rather than after load. Patching prototypes catches
// every instance, including the ones three.js creates internally.
await page.addInitScript(() => {
  window.__audioProbe = { counts: {}, installed: [] };
  const bump = (k) => { window.__audioProbe.counts[k] = (window.__audioProbe.counts[k] ?? 0) + 1; };

  const wrap = (proto, method, label) => {
    if (!proto || typeof proto[method] !== 'function') return;
    const original = proto[method];
    proto[method] = function (...a) { bump(label); return original.apply(this, a); };
    window.__audioProbe.installed.push(label);
  };

  // AudioParam scheduling — the per-frame churn under investigation.
  wrap(AudioParam.prototype, 'setTargetAtTime', 'param.setTargetAtTime');
  wrap(AudioParam.prototype, 'linearRampToValueAtTime', 'param.linearRamp');
  wrap(AudioParam.prototype, 'exponentialRampToValueAtTime', 'param.expRamp');
  wrap(AudioParam.prototype, 'setValueAtTime', 'param.setValueAtTime');

  // Node construction — should be zero per frame in steady state.
  wrap(BaseAudioContext.prototype, 'createGain', 'node.createGain');
  wrap(BaseAudioContext.prototype, 'createBiquadFilter', 'node.createBiquadFilter');
  wrap(BaseAudioContext.prototype, 'createOscillator', 'node.createOscillator');
  wrap(BaseAudioContext.prototype, 'createPanner', 'node.createPanner');
  wrap(BaseAudioContext.prototype, 'createBufferSource', 'node.createBufferSource');

  // The synchronous noise fills behind procedural baking.
  wrap(BaseAudioContext.prototype, 'createBuffer', 'buffer.createBuffer');
  wrap(AudioBuffer.prototype, 'getChannelData', 'buffer.getChannelData');

  // Offline renders — each ambience segment is one of these.
  const OfflineCtor = window.OfflineAudioContext;
  if (OfflineCtor) {
    window.OfflineAudioContext = function (...a) { bump('offline.construct'); return new OfflineCtor(...a); };
    window.OfflineAudioContext.prototype = OfflineCtor.prototype;
  }
});

await page.goto(`http://localhost:${PORT}/?benchmark=${VEHICLES}`, {
  waitUntil: 'domcontentloaded', timeout: 60000,
});
await page.waitForTimeout(4000);

// Same regime pinning as perf-bisect: full-quality audio, drawer closed, so the
// counts describe the path a real player is on rather than a degraded one.
await page.evaluate(() => {
  if (window.__autoQuality) { window.__autoQuality.update = () => {}; window.__autoQuality.low = false; }
  window.__audio?.resume?.();
  window.__audio?.setLowPower?.(false);
  for (const k of window.__audio?.activeLoopKeys?.() ?? []) window.__audio.stopEngineLoop(k);
  window.vehiclePicker?.setOpen?.(false);
});
await page.waitForTimeout(5000);

// Zero the counters and count frames over the same window, so the result can be
// expressed per frame rather than only per second.
await page.evaluate(() => {
  window.__audioProbe.counts = {};
  window.__audioProbe.frames = 0;
  window.__audioProbe.startedAt = performance.now();
  const tick = () => { window.__audioProbe.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

await page.waitForTimeout(SAMPLE_MS);

const out = await page.evaluate(() => {
  const p = window.__audioProbe;
  const elapsedS = (performance.now() - p.startedAt) / 1000;
  const a = window.__audio?.debugState?.();
  const perSec = {}, perFrame = {};
  for (const [k, v] of Object.entries(p.counts)) {
    perSec[k] = Number((v / elapsedS).toFixed(1));
    perFrame[k] = p.frames ? Number((v / p.frames).toFixed(2)) : null;
  }
  return {
    elapsedS: Number(elapsedS.toFixed(2)),
    framesRendered: p.frames,
    engineLoops: a?.loopCount ?? null,
    vehicles: window.vehicles?.instances?.length ?? null,
    audioContextState: a?.contextState ?? null,
    totals: p.counts,
    perSecond: perSec,
    perFrame,
  };
});

await browser.close();

const paramTotal = Object.entries(out.perFrame)
  .filter(([k]) => k.startsWith('param.'))
  .reduce((s, [, v]) => s + (v ?? 0), 0);

console.error(
  `\n  ${out.framesRendered} frames over ${out.elapsedS}s — ` +
  `${out.engineLoops} engine loops, ${out.vehicles} vehicles, audio ${out.audioContextState}\n` +
  `  AudioParam events per frame: ${paramTotal.toFixed(1)}` +
  (out.engineLoops ? `  (${(paramTotal / out.engineLoops).toFixed(1)} per engine loop)` : '') + '\n'
);
console.log(JSON.stringify(out, null, 2));
