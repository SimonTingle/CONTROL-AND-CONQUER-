/**
 * `mountVersionBadge` — the on-screen build stamp.
 *
 * Requested directly after a real production multiplayer investigation:
 * confirming two players' devices were on the same build took reading
 * CapRover deploy logs, because the only existing version stamp
 * (`__APP_VERSION__`, console-logged in main.js) is invisible on a phone with
 * no attached devtools. This puts the same value on screen instead.
 *
 * No jsdom — the DOM surface used (createElement, textContent, an attribute,
 * appendChild) is small enough to fake, the same approach
 * lobby-reentry.test.mjs and lobby-rejoin.test.mjs already use, to keep
 * `npm test` dependency-free.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function installFakeDom() {
  const body = { children: [], appendChild(el) { this.children.push(el); return el; } };
  globalThis.document = {
    body,
    createElement: () => ({
      attrs: {},
      textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; },
    }),
  };
  return body;
}

test('renders the build-time version string as visible text', async () => {
  installFakeDom();
  const { mountVersionBadge } = await import(`../src/ui/versionBadge.js?t=${Date.now()}-a`);
  const el = mountVersionBadge('abc1234');
  assert.equal(el.textContent, 'abc1234');
});

test('is mounted onto document.body', async () => {
  const body = installFakeDom();
  const { mountVersionBadge } = await import(`../src/ui/versionBadge.js?t=${Date.now()}-b`);
  const el = mountVersionBadge('abc1234');
  assert.ok(body.children.includes(el), 'the badge must actually be attached, not just built');
});

test('falls back to the build-time global when no version is passed', async () => {
  // __APP_VERSION__ does not exist under plain Node — this is the path a real
  // page takes, where Vite has substituted a real literal at build time.
  globalThis.__APP_VERSION__ = 'deadbeef1234';
  installFakeDom();
  const { mountVersionBadge } = await import(`../src/ui/versionBadge.js?t=${Date.now()}-c`);
  const el = mountVersionBadge();
  assert.equal(el.textContent, 'deadbeef1234');
  delete globalThis.__APP_VERSION__;
});

test('is marked decorative, not read as page content', async () => {
  installFakeDom();
  const { mountVersionBadge } = await import(`../src/ui/versionBadge.js?t=${Date.now()}-d`);
  const el = mountVersionBadge('abc1234');
  assert.equal(el.attrs['aria-hidden'], 'true');
});
