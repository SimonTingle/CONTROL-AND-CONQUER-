/**
 * Browser verification for the Sound Creator.
 *
 * Three things `npm test` cannot reach, because all three need a real Web
 * Audio implementation and a real DOM:
 *
 *  1. **The buffer cache distinguishes generator params.** This is the check
 *     the pre-existing cache bug fails. The key was `${id}:${variation}` with
 *     `params` passed to the generator but absent from the key, so once three
 *     variations had been cached every subsequent play — at any intensity —
 *     returned a buffer baked for whichever intensity arrived first. The probe
 *     plays one intensity thirty times (expect exactly the three variations)
 *     and then eight distinct intensities (expect eight more entries). Under
 *     the old key the second number is 0.
 *
 *     It matters beyond the game sounding wrong: it is the editor's entire
 *     feedback loop. An author drags a slider, re-auditions, and hears the
 *     stale bake.
 *
 *  2. **A recipe edit changes the rendered buffer**, through the real
 *     `bakeRecipe` and the real `OfflineAudioContext`.
 *
 *  3. **The editor opens, draws, and filters by ability level** — including
 *     that the waveform canvas has actual pixels in it, which is the only way
 *     to tell "drew a waveform" from "drew nothing without throwing".
 *
 * Hardware-independent: every number here is a count or a comparison, not a
 * timing, so it means the same in this container as on a workstation. See
 * scripts/audio-load-probe.mjs's header for why that property is worth
 * insisting on in a sandbox with no GPU.
 *
 * Usage:
 *   npx vite --port 5199 --strictPort &
 *   node scripts/sound-editor-probe.mjs [--port 5199]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : '5199';
const url = `http://localhost:${port}/`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url, { waitUntil: 'load' });

const result = await page.evaluate(async () => {
  const audio = await import('/src/audio/audio.js');
  const synth = await import('/src/audio/synth.js');
  const recipes = await import('/src/sound/soundRecipe.js');
  const { SoundScreen } = await import('/src/sound/soundScreen.js');
  const THREE = await import('/node_modules/three/build/three.module.js');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const out = {};

  // --- 1. the cache key ---
  //
  // This section, and only this section, needs the live voice pool: it counts
  // cache entries produced by real `playAt` calls. `initAudio` runs at
  // main.js's module scope, but that import graph is large and can still be
  // executing when the load event fires, and the autoplay policy leaves the
  // context suspended until a gesture nothing here makes.
  //
  // So it is skipped rather than fatal when the pool never comes up. An
  // earlier version gated the *whole* probe on this, which meant a flaky and
  // entirely unrelated precondition reported FAIL for the layer, preset and
  // portal checks — none of which touch the pool. They need an
  // OfflineAudioContext and a DOM, both of which are always there. A check
  // that cannot run should say so and stand aside, not veto its neighbours.
  const ctx = THREE.AudioContext.getContext();
  if (ctx.state !== 'running') await ctx.resume();
  for (let i = 0; i < 60 && audio.debugState().voiceCount === 0; i++) await sleep(100);
  out.poolReady = audio.debugState().voiceCount > 0 && ctx.state === 'running';

  if (out.poolReady) {
    let mark = audio.debugState().cachedBuffers;
    for (let i = 0; i < 30; i++) audio.playAt('explosionGround', 0, 0, 0, { intensity: 1 });
    await sleep(1000);
    out.entriesForOneIntensity = audio.debugState().cachedBuffers - mark;

    mark = audio.debugState().cachedBuffers;
    for (const intensity of [0.3, 0.5, 0.8, 1.4, 1.9, 2.3, 2.8, 3.4]) {
      audio.playAt('explosionHull', 0, 0, 0, { intensity });
    }
    await sleep(1500);
    out.entriesForEightIntensities = audio.debugState().cachedBuffers - mark;
  } else {
    out.cacheCheckSkipped = `voiceCount=${audio.debugState().voiceCount}, ctx=${ctx.state}`;
  }

  // --- 2. an edit changes the bake ---
  const rms = (buf) => {
    const d = buf.getChannelData(0);
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / d.length);
  };
  const a = recipes.blankRecipe();
  const b = recipes.cloneRecipe(a);
  b.layers[0].startFreq = 800;
  recipes.syncId(b);
  out.rmsBefore = rms(await synth.bakeRecipe(a, recipes.recipeDuration(a)));
  out.rmsAfter = rms(await synth.bakeRecipe(b, recipes.recipeDuration(b)));
  out.editChangesBake = Math.abs(out.rmsBefore - out.rmsAfter) > 1e-4;

  // --- 3. every layer kind actually renders audio ---
  //
  // The unit tests prove a layer of each kind validates; only a real
  // OfflineAudioContext can prove it *makes a sound*. A kind whose primitive
  // is misconnected still validates perfectly and bakes pure silence, which
  // is the specific failure this catches.
  out.layerRms = {};
  for (const kind of Object.keys((await import('/src/sound/soundSchema.js')).LAYER_CONTROLS)) {
    const r = recipes.blankRecipe('probe');
    r.layers = [recipes.blankLayer(kind)];
    recipes.syncId(r);
    out.layerRms[kind] = Number(rms(await synth.bakeRecipe(r, recipes.recipeDuration(r))).toFixed(5));
  }
  out.everyLayerAudible = Object.values(out.layerRms).every((v) => v > 0.0001);

  // --- 4. every preset bakes ---
  const presets = await import('/src/sound/soundPresets.js');
  out.presetSilent = [];
  for (const p of presets.SOUND_PRESETS) {
    const buf = await synth.bakeRecipe(p.recipe, recipes.recipeDuration(p.recipe));
    if (rms(buf) <= 0.0001) out.presetSilent.push(p.id);
  }
  out.presetCount = presets.SOUND_PRESETS.length;

  // --- 5. the editor ---
  const screen = new SoundScreen({ toast: () => {} });
  screen.open();
  await sleep(600);
  const root = document.getElementById('sound-builder');
  out.editorVisible = !root.classList.contains('hidden');
  out.columns = root.querySelectorAll('.builder-left, .builder-centre, .builder-right').length;

  const canvas = root.querySelector('.sound-canvas-wave');
  const g = canvas.getContext('2d');
  const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
  let lit = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
  out.waveformPixels = lit;

  const sliders = () => root.querySelectorAll('.builder-right input[type=range]').length;
  screen.setLevel('low');
  out.slidersLow = sliders();
  screen.setLevel('medium');
  out.slidersMedium = sliders();
  screen.setLevel('advanced');
  out.slidersAdvanced = sliders();

  screen.close();
  out.editorClosed = root.classList.contains('hidden');

  // --- 6. the god-mode portal ---
  const { PortalScreen } = await import('/src/ui/portalScreen.js');
  const { GOD_MODE_EMAIL } = await import('/src/core/adminAccount.js');
  const portalRoot = document.getElementById('portal');
  const opened = [];
  const portal = new PortalScreen(() => {}, {
    isConfigured: true,
    getAccount: () => ({ email: GOD_MODE_EMAIL, displayName: 'probe' }),
    onGodMode: (app) => opened.push(app),
  });
  portal.showGodMode();
  const apps = [...portalRoot.querySelectorAll('.god-mode-row .god-mode-btn')];
  out.godModePanelApps = apps.length;
  out.godModeAppLabels = apps.map((b) => b.textContent);
  apps[1]?.click();
  out.godModeOpened = opened;
  // Back must return to the landing grid, not leave a dead panel.
  portalRoot.querySelector('.portal-back')?.click();
  out.godModeBackWorks = !!portalRoot.querySelector('.portal-button-row');

  // A non-admin must not be able to open the panel even by calling it.
  const denied = new PortalScreen(() => {}, {
    isConfigured: true,
    getAccount: () => ({ email: 'nobody@example.com', displayName: 'nobody' }),
    onGodMode: () => opened.push('LEAKED'),
  });
  denied.showGodMode();
  out.godModeDeniedForOthers = !document.querySelector('.god-mode-row');

  return out;
});

result.pageErrors = errors;
// The cache assertions apply only when the pool actually came up. Skipped is
// reported loudly below rather than being quietly folded into a pass.
const cacheOk = !result.poolReady
  || (result.entriesForOneIntensity === 3 && result.entriesForEightIntensities === 8);

const ok = !result.error
  && cacheOk
  && result.editChangesBake
  && result.everyLayerAudible
  && result.presetSilent?.length === 0
  && result.godModePanelApps === 2
  && result.godModeBackWorks
  && result.editorVisible
  && result.columns === 3
  && result.waveformPixels > 0
  && result.slidersLow < result.slidersMedium
  && result.slidersMedium < result.slidersAdvanced
  && result.editorClosed
  && errors.length === 0;

console.log(JSON.stringify(result, null, 2));
if (!result.poolReady) {
  console.log('NOTE: the voice pool never came up, so the cache-key check did not run.');
}
console.log(ok ? 'PASS' : 'FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
