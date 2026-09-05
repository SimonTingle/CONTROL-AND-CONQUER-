// Does an open hamburger drawer bury the game's own on-screen text?
//
// On a phone both drawers are `min(88vw, 340px)` — nearly the whole viewport.
// Every world overlay in style.css was originally taught to dodge only the
// drawer sharing *its own* screen edge (#hud slides away from the left-hand
// settings drawer, #minimap from the right-hand vehicle drawer), which is
// correct while a drawer is a 320px panel against one edge and wrong the
// moment it spans both. Nothing was watching for that, because nothing in the
// repository rendered the game at a phone size and measured what covered what.
//
// This does. It drives a real sandbox match at three phone widths, opens each
// drawer in turn, and intersects the rect of every content element with the
// rect of every open drawer. Before the fix it reported the radio feed 86-100%
// covered, #hud 90% covered by the right drawer, and #minimap 67-78% covered
// by the left — none of which any unit test can see, since they are facts
// about layout, not about logic.
//
// It also checks the two text-clipping failures that only exist on touch:
// `.vehicle-card-stats` was revealed by :hover alone, so a phone never showed
// it at all, and `.vehicle-card-lock` ellipsised the unlock condition down to
// "Locked — char…". Both assertions compare scrollWidth/Height against
// client dimensions rather than merely checking visibility — an earlier
// version of this file only checked that the stat line had non-zero height,
// passed against a still-truncated line, and had to be sharpened. A check
// that has never failed has not been shown to check anything (CLAUDE.md).
//
// The desktop case is asserted too, and deliberately: the fix must NOT reach
// above 720px, where there is room to slide aside and sliding reads better
// than vanishing. It requires a real non-zero translation, not just
// "transform is not the string none" — the identity matrix passes that.
//
// Not part of `npm test`, which is dependency-free by policy. This needs a
// browser and the dev server:
//
//   npm i --no-save playwright-core
//   npx vite --port 5199 --strictPort &
//   node tests/e2e/mobile-drawer-overlap.mjs
//
// PLAYWRIGHT_CHROMIUM points at an existing Chromium; without it the script
// falls back to whatever playwright-core resolves on its own.
//
// Headless software rendering runs at roughly 5fps, so the waits here are
// generous on purpose: a 250ms CSS transition needs far longer than 250ms of
// wall clock to settle, and sampling too early reports a stale transform.
import { chromium } from 'playwright-core';

const BASE = process.env.GAME_URL || 'http://localhost:5199';


const SIZES = [
  { name: '320x568', w: 320, h: 568 },
  { name: '360x640', w: 360, h: 640 },
  { name: '390x844', w: 390, h: 844 },
];
const MAX_OVERLAP_PCT = 5;
let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL  ' + m); };
const pass = (m) => console.log('  ok    ' + m);

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});

async function match(page) {
  const clickText=(s,r)=>page.evaluate(([a,b])=>{const e=[...document.querySelectorAll(a)].find(x=>new RegExp(b).test(x.textContent));if(e){e.click();return true}return false},[s,r]);
  await page.goto(BASE,{waitUntil:'load'});
  await page.waitForTimeout(2200);
  await clickText('button','Sandbox Test'); await page.waitForTimeout(800);
  await clickText('.difficulty-card','.'); await page.waitForTimeout(2600);
  // Real content in the HUD and the radio feed, so neither is zero-sized.
  await page.evaluate(() => { const g=window.game; if (g?.playerTeam) g.playerTeam.credits = 1500; });
  await page.evaluate(async () => {
    const m = await import('/src/ui/radioFeed.js');
    m.pushRadioLine({ speaker:'Recon', text:'Contact. Hostiles on my position.' });
    m.pushRadioLine({ speaker:'Command', text:'Copy contact. Fall back and hold.' });
  });
  await page.waitForTimeout(1200);
}

const collisions = (page) => page.evaluate(() => {
  const CONTENT = { '#hud':'HUD', '.radio-feed':'Radio feed', '#minimap':'Minimap',
                    '.hint-card':'Hint card', '#version-badge':'Version badge' };
  const DRAWERS = { '#panel':'LEFT drawer', '#vehicle-panel':'RIGHT drawer' };
  const box=(el)=>{const r=el.getBoundingClientRect();const cs=getComputedStyle(el);
    return {r,z:+(cs.zIndex==='auto'?0:cs.zIndex),
      shown: cs.display!=='none' && +cs.opacity>0.01 && cs.visibility!=='hidden' && r.width>0 && r.height>0};};
  const out=[];
  for (const [ds,dn] of Object.entries(DRAWERS)) {
    const d=document.querySelector(ds); if(!d) continue; const db=box(d);
    if (!db.shown || db.r.right<=0 || db.r.left>=innerWidth) continue;
    for (const [cs_,cn] of Object.entries(CONTENT)) {
      const c=document.querySelector(cs_); if(!c) continue; const cb=box(c);
      if (!cb.shown) continue;
      const ox=Math.max(0,Math.min(db.r.right,cb.r.right)-Math.max(db.r.left,cb.r.left));
      const oy=Math.max(0,Math.min(db.r.bottom,cb.r.bottom)-Math.max(db.r.top,cb.r.top));
      if (ox<=0||oy<=0) continue;
      out.push({drawer:dn, content:cn, pct:Math.round(ox*oy/(cb.r.width*cb.r.height)*100)});
    }
  }
  return out;
});

for (const s of SIZES) {
  console.log(`\n===== ${s.name} (touch) =====`);
  const page = await browser.newPage({ viewport:{width:s.w,height:s.h}, hasTouch:true, isMobile:true });
  await match(page);

  // State A: right drawer auto-open (the default first run).
  let c = await collisions(page);
  let bad = c.filter(x=>x.pct>MAX_OVERLAP_PCT);
  bad.length ? bad.forEach(x=>fail(`A right-drawer: ${x.content} ${x.pct}% covered`))
             : pass('A right drawer auto-open: no content covered');

  // State B: left drawer open.
  await page.evaluate(()=>document.getElementById('vehicle-toggle')?.click());
  await page.waitForTimeout(1500);
  await page.evaluate(()=>document.getElementById('menu-toggle').click());
  await page.waitForTimeout(2500);
  c = await collisions(page);
  bad = c.filter(x=>x.pct>MAX_OVERLAP_PCT);
  bad.length ? bad.forEach(x=>fail(`B left-drawer: ${x.content} ${x.pct}% covered`))
             : pass('B left drawer open: no content covered');

  // The build string must be reachable in the drawer that hid the badge.
  const statsText = await page.evaluate(()=>document.getElementById('hud-stats').textContent);
  /build [0-9a-f]{4,}/i.test(statsText)
    ? pass(`B build string in panel: "${statsText.split('\n')[1]?.slice(0,42)}"`)
    : fail(`B build string missing from panel stats: "${statsText.replace(/\n/g,' | ')}"`);
  await page.screenshot({path:`/tmp/fix-${s.name}-left.png`});

  // Close the drawer: everything must come back.
  await page.evaluate(()=>document.getElementById('menu-toggle').click());
  await page.waitForTimeout(2500);
  const restored = await page.evaluate(()=>{
    const vis=(s)=>{const el=document.querySelector(s); if(!el) return null;
      const cs=getComputedStyle(el); return cs.display!=='none' && +cs.opacity>0.9;};
    return { hud:vis('#hud'), feed:vis('.radio-feed'), minimap:vis('#minimap'), badge:vis('#version-badge') };
  });
  Object.entries(restored).forEach(([k,v]) =>
    v===false ? fail(`C drawer closed: ${k} did not come back`) : null);
  if (Object.values(restored).every(v=>v!==false)) pass('C drawers closed: all chrome restored');

  // Vehicle card text must be readable on touch.
  await page.evaluate(()=>document.getElementById('vehicle-toggle').click());
  await page.waitForTimeout(900);
  const cards = await page.evaluate(()=>[...document.querySelectorAll('.vehicle-card-stats,.vehicle-card-lock')]
    .map(el=>({cls:el.className,text:el.textContent.trim(),
               sw:el.scrollWidth,cw:el.clientWidth,ch:el.clientHeight,sh:el.scrollHeight})));
  for (const k of cards) {
    if (!k.text) continue;
    // Horizontal clipping is the failure mode for a nowrap + ellipsis line:
    // scrollHeight stays equal to clientHeight because it never wraps, so only
    // scrollWidth exposes it. Checking both, since the wrapped replacement can
    // only fail vertically (line-clamp) instead.
    if (k.ch === 0) fail(`D ${k.cls} height-collapsed (invisible on touch): "${k.text}"`);
    else if (k.sw > k.cw + 1)
      fail(`D ${k.cls} clipped horizontally: "${k.text}" needs ${k.sw}px, has ${k.cw}px`);
    else if (k.sh > k.ch + 1)
      fail(`D ${k.cls} clipped vertically: "${k.text}" needs ${k.sh}px, has ${k.ch}px`);
    else pass(`D ${k.cls} readable: "${k.text.slice(0,38)}"`);
  }
  await page.screenshot({path:`/tmp/fix-${s.name}-cards.png`});
  await page.close();
}

// Desktop regression: the slide-aside behaviour must survive above 720px.
console.log('\n===== 1280x800 (desktop, mouse) =====');
const d = await browser.newPage({ viewport:{width:1280,height:800} });
await match(d);
const SETTLE = 3000; // 250ms transition, but swiftshader renders at ~5fps
const shiftX = (t) => { const m=/matrix\(([^)]+)\)/.exec(t); return m ? +m[1].split(',')[4] : 0; };
const deskState = () => d.evaluate(()=>{
  const g=(s)=>{const el=document.querySelector(s);const cs=getComputedStyle(el);
    return {transform:cs.transform, opacity:+cs.opacity, x:Math.round(el.getBoundingClientRect().x)};};
  return {body:document.body.className||'(none)', hud:g('#hud'), minimap:g('#minimap')};
});

await d.evaluate(()=>{ const p=document.getElementById('vehicle-panel');
  if (p.getBoundingClientRect().left < innerWidth) document.getElementById('vehicle-toggle').click(); });
await d.waitForTimeout(SETTLE);
await d.evaluate(()=>document.getElementById('menu-toggle').click());
await d.waitForTimeout(SETTLE);
let dk = await deskState();
dk.hud.opacity > 0.9 && shiftX(dk.hud.transform) > 100
  ? pass(`desktop: left drawer slides HUD aside +${shiftX(dk.hud.transform)}px (opacity ${dk.hud.opacity}, x=${dk.hud.x})`)
  : fail(`desktop HUD no longer slides aside: ${JSON.stringify(dk.hud)}`);

await d.evaluate(()=>document.getElementById('menu-toggle').click());
await d.waitForTimeout(SETTLE);
await d.evaluate(()=>document.getElementById('vehicle-toggle').click());
await d.waitForTimeout(SETTLE);
dk = await deskState();
dk.minimap.opacity > 0.9 && shiftX(dk.minimap.transform) < -100
  ? pass(`desktop: right drawer slides minimap aside ${shiftX(dk.minimap.transform)}px (opacity ${dk.minimap.opacity}, x=${dk.minimap.x})`)
  : fail(`desktop minimap no longer slides aside: ${JSON.stringify(dk.minimap)}`);
await d.screenshot({path:'/tmp/fix-desktop.png'});
await browser.close();

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
